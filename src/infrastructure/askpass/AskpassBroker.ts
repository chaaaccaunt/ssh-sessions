import { randomBytes, timingSafeEqual } from "node:crypto"
import { chmod, mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import type {
  AuthStrategy,
  HostKeyPolicy,
  SecretProvider
} from "../../domain/connection"
import { SshError } from "../../domain/sshError"
import type { ProcessResult } from "../../domain/processResult"
import type {
  ProcessRunner,
  RunProcessRequest
} from "../process/ProcessRunner"
import { WINDOWS_ASKPASS_EXECUTABLE_BASE64 } from "./windowsAskpassExecutable"

const ENDPOINT_ENV = "SSH_SESSION_ASKPASS_ENDPOINT"
const TOKEN_ENV = "SSH_SESSION_ASKPASS_TOKEN"
const MAX_REQUEST_BYTES = 64 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_LIFETIME_MS = 120_000
const DEFAULT_MAX_PASSWORD_PROMPTS = 1
const TRUST_WARNING = "Verify this fingerprint through a trusted channel before accepting it."

export type AskpassPromptKind =
  | "password"
  | "key-passphrase"
  | "host-authenticity"
  | "mfa"
  | "unknown"

export interface HostKeyConfirmationRequest {
  readonly prompt: string
  readonly warning: string
}

export interface AskpassBrokerOptions {
  readonly auth: AuthStrategy
  readonly hostKeyPolicy: HostKeyPolicy
  readonly confirmHostKey?: (
    request: HostKeyConfirmationRequest
  ) => Promise<boolean>
  readonly helperPath?: string
  readonly requestTimeoutMs?: number
  readonly lifetimeMs?: number
  readonly maximumPasswordPrompts?: number
  readonly signal?: AbortSignal
}

export interface AskpassSession {
  readonly environment: Readonly<Record<string, string>>
  getFailure(): SshError | undefined
  close(): Promise<void>
}

interface AskpassRequest {
  readonly token: string
  readonly prompt: string
}

interface AskpassResponse {
  readonly ok: boolean
  readonly value?: string
  readonly error?: string
}

interface PreparedHelper {
  readonly path: string
  cleanup(): Promise<void>
}

export class OpenSshAskpassBroker {
  open(options: AskpassBrokerOptions): Promise<AskpassSession> {
    validateOptions(options)

    const endpoint = createEndpoint()
    const token = randomBytes(32).toString("hex")
    const state = new BrokerState(options, token)
    const sockets = new Set<Socket>()
    let preparedHelper: PreparedHelper | undefined
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once("close", () => sockets.delete(socket))
      handleSocket(socket, state, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    })

    return prepareHelper(options.helperPath)
      .then((helper) => {
        preparedHelper = helper
        return listen(server, endpoint)
      })
      .then(() => createSession(
        server,
        sockets,
        state,
        endpoint,
        token,
        preparedHelper?.path ?? "",
        preparedHelper?.cleanup ?? (() => Promise.resolve()),
        options
      ))
      .catch((error: unknown) => {
        return Promise.allSettled([
          removeEndpoint(endpoint),
          preparedHelper?.cleanup() ?? Promise.resolve()
        ])
          .then(() => Promise.reject(toBrokerError(error, "start-askpass-broker")))
      })
  }
}

export function runWithAskpass(
  processRunner: ProcessRunner,
  request: RunProcessRequest,
  options: AskpassBrokerOptions,
  broker: OpenSshAskpassBroker = new OpenSshAskpassBroker()
): Promise<ProcessResult> {
  const signal = request.signal ?? options.signal
  const brokerOptions: AskpassBrokerOptions = {
    ...options,
    ...(signal === undefined ? {} : { signal })
  }

  return broker.open(brokerOptions)
    .then((session) => processRunner.run({
      ...request,
      environment: {
        ...request.environment,
        ...session.environment
      }
    })
      .then((result) => {
        const failure = session.getFailure()

        if (failure !== undefined) {
          throw failure
        }

        return result
      })
      .finally(() => session.close()))
}

export function classifyAskpassPrompt(prompt: string): AskpassPromptKind {
  if (
    /authenticity of host|are you sure you want to continue connecting|fingerprint/iu.test(prompt)
  ) {
    return "host-authenticity"
  }

  if (/enter passphrase for (?:key|.*private key)/iu.test(prompt)) {
    return "key-passphrase"
  }

  if (/verification code|one[- ]time|\botp\b|two[- ]factor|duo|security token/iu.test(prompt)) {
    return "mfa"
  }

  if (/password\s*:/iu.test(prompt)) {
    return "password"
  }

  return "unknown"
}

class BrokerState {
  private passwordPromptCount = 0
  private password: Uint8Array | undefined
  private passphrase: Uint8Array | undefined
  private failure: SshError | undefined

  constructor(
    private readonly options: AskpassBrokerOptions,
    private readonly token: string
  ) {}

  getFailure(): SshError | undefined {
    return this.failure
  }

  authorize(request: AskpassRequest): Promise<Uint8Array> {
    if (!tokensEqual(request.token, this.token)) {
      return this.reject("authentication_failed", "ASKPASS helper authentication failed")
    }

    const kind = classifyAskpassPrompt(request.prompt)

    if (kind === "host-authenticity") {
      return this.confirmHostKey(request.prompt)
    }

    if (kind === "key-passphrase") {
      if (this.options.auth.kind !== "key" || this.options.auth.getPassphrase === undefined) {
        return this.reject("key_passphrase_required", "A key passphrase is required")
      }

      return this.loadSecret("passphrase", this.options.auth.getPassphrase)
    }

    if (kind === "password") {
      if (this.options.auth.kind !== "password") {
        return this.reject("authentication_failed", "Password authentication was not requested")
      }

      this.passwordPromptCount += 1

      if (this.passwordPromptCount > (this.options.maximumPasswordPrompts ?? DEFAULT_MAX_PASSWORD_PROMPTS)) {
        return this.reject("authentication_failed", "The password prompt limit was exceeded")
      }

      return this.loadSecret("password", this.options.auth.getPassword)
    }

    if (kind === "mfa") {
      return this.reject("mfa_required", "Interactive MFA confirmation is required")
    }

    return this.reject("authentication_failed", "Unsupported authentication prompt")
  }

  dispose(): void {
    this.password?.fill(0)
    this.passphrase?.fill(0)
    this.password = undefined
    this.passphrase = undefined
  }

  private confirmHostKey(prompt: string): Promise<Uint8Array> {
    if (this.options.hostKeyPolicy !== "ask" || this.options.confirmHostKey === undefined) {
      return this.reject("host_key_unknown", "The remote host key is not trusted")
    }

    return this.options.confirmHostKey({ prompt, warning: TRUST_WARNING })
      .then((accepted) => {
        if (!accepted) {
          throw this.recordFailure("host_key_unknown", "The remote host key was not accepted")
        }

        return Buffer.from("yes", "utf8")
      })
      .catch((error: unknown) => {
        if (error instanceof SshError) {
          throw error
        }

        throw this.recordFailure(
          "host_key_unknown",
          "Unable to confirm the remote host key",
          error
        )
      })
  }

  private loadSecret(
    kind: "password" | "passphrase",
    provider: SecretProvider
  ): Promise<Uint8Array> {
    const existing = kind === "password" ? this.password : this.passphrase

    if (existing !== undefined) {
      return Promise.resolve(existing)
    }

    return provider()
      .then((secret) => {
        if (!(secret instanceof Uint8Array) || secret.byteLength === 0) {
          throw new Error("secret provider returned an empty or invalid value")
        }

        const stored = Buffer.from(secret)

        if (kind === "password") {
          this.password = stored
        } else {
          this.passphrase = stored
        }

        return stored
      })
      .catch((error: unknown) => {
        throw this.recordFailure(
          kind === "password" ? "authentication_failed" : "key_passphrase_required",
          `Unable to provide the ${kind}`,
          error
        )
      })
  }

  private reject(code: "authentication_failed" | "host_key_unknown" | "key_passphrase_required" | "mfa_required", message: string): Promise<Uint8Array> {
    return Promise.reject(this.recordFailure(code, message))
  }

  private recordFailure(
    code: "authentication_failed" | "host_key_unknown" | "key_passphrase_required" | "mfa_required",
    message: string,
    cause?: unknown
  ): SshError {
    const error = new SshError({
      code,
      operation: "answer-askpass-prompt",
      message,
      ...(cause === undefined ? {} : { cause })
    })

    this.failure = error
    return error
  }
}

function handleSocket(socket: Socket, state: BrokerState, timeoutMs: number): void {
  let input = ""
  let handled = false
  const timeout = setTimeout(() => {
    respond(socket, { ok: false, error: "ASKPASS request timed out" })
  }, timeoutMs)

  timeout.unref()
  socket.setEncoding("utf8")
  socket.on("data", (chunk: string) => {
    input += chunk

    if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_BYTES) {
      clearTimeout(timeout)
      respond(socket, { ok: false, error: "ASKPASS request is too large" })
      return
    }

    if (!handled && input.includes("\n")) {
      handled = true
      clearTimeout(timeout)
      processRequest(input.slice(0, input.indexOf("\n")), state, socket)
    }
  })
  socket.once("error", () => clearTimeout(timeout))
  socket.once("close", () => clearTimeout(timeout))
}

function processRequest(input: string, state: BrokerState, socket: Socket): void {
  let request: AskpassRequest

  try {
    request = parseRequest(input)
  } catch {
    respond(socket, { ok: false, error: "Invalid ASKPASS request" })
    return
  }

  state.authorize(request)
    .then((secret) => respond(socket, {
      ok: true,
      value: Buffer.from(secret).toString("base64")
    }))
    .catch(() => respond(socket, { ok: false, error: "ASKPASS request rejected" }))
}

function parseRequest(input: string): AskpassRequest {
  const value: unknown = JSON.parse(input)

  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !("token" in value)
    || !("prompt" in value)
    || typeof value.token !== "string"
    || typeof value.prompt !== "string"
  ) {
    throw new Error("invalid request")
  }

  return { token: value.token, prompt: value.prompt }
}

function respond(socket: Socket, response: AskpassResponse): void {
  if (socket.destroyed) {
    return
  }

  socket.end(`${JSON.stringify(response)}\n`)
}

function createSession(
  server: Server,
  sockets: Set<Socket>,
  state: BrokerState,
  endpoint: string,
  token: string,
  helperPath: string,
  cleanupHelper: () => Promise<void>,
  options: AskpassBrokerOptions
): AskpassSession {
  let closePromise: Promise<void> | undefined
  const lifetime = setTimeout(
    () => close(),
    options.lifetimeMs ?? DEFAULT_LIFETIME_MS
  )
  const onAbort = () => close()

  lifetime.unref()
  options.signal?.addEventListener("abort", onAbort, { once: true })

  const close = (): Promise<void> => {
    if (closePromise !== undefined) {
      return closePromise
    }

    clearTimeout(lifetime)
    options.signal?.removeEventListener("abort", onAbort)
    state.dispose()

    for (const socket of sockets) {
      socket.destroy()
    }

    closePromise = closeServer(server)
      .then(() => removeEndpoint(endpoint))
      .finally(cleanupHelper)

    return closePromise
  }

  if (options.signal?.aborted === true) {
    void close()
  }

  return {
    environment: {
      SSH_ASKPASS: helperPath,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: "ssh-session",
      [ENDPOINT_ENV]: endpoint,
      [TOKEN_ENV]: token
    },
    getFailure: () => state.getFailure(),
    close
  }
}

function createEndpoint(): string {
  const suffix = randomBytes(12).toString("hex")

  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ssh-session-${process.pid}-${suffix}`
  }

  return join(tmpdir(), `ssh-session-${process.pid}-${suffix}.sock`)
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error)

    server.once("error", onError)
    server.listen(endpoint, () => {
      server.removeListener("error", onError)
      resolveListen()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose()
      return
    }

    server.close(() => resolveClose())
  })
}

function removeEndpoint(endpoint: string): Promise<void> {
  if (process.platform === "win32") {
    return Promise.resolve()
  }

  return unlink(endpoint).catch((error: unknown) => {
    if (getErrorCode(error) !== "ENOENT") {
      throw error
    }
  })
}

function prepareHelper(configuredPath: string | undefined): Promise<PreparedHelper> {
  if (configuredPath !== undefined) {
    return prepareExistingHelper(configuredPath)
  }

  if (process.platform !== "win32") {
    return prepareExistingHelper(resolve(__dirname, "askpassHelper.js"))
  }

  return createWindowsHelper()
}

function prepareExistingHelper(helperPath: string): Promise<PreparedHelper> {
  const prepare = process.platform === "win32"
    ? Promise.resolve()
    : chmod(helperPath, 0o700)

  return prepare.then(() => ({
    path: helperPath,
    cleanup: () => Promise.resolve()
  }))
}

function createWindowsHelper(): Promise<PreparedHelper> {
  return mkdtemp(join(tmpdir(), "ssh-session-askpass-"))
    .then((directory) => {
      const helperPath = join(directory, "askpass.exe")
      const executable = Buffer.from(WINDOWS_ASKPASS_EXECUTABLE_BASE64, "base64")

      if (executable[0] !== 0x4d || executable[1] !== 0x5a) {
        return rm(directory, { recursive: true, force: true })
          .then(() => Promise.reject(new Error("invalid embedded Windows ASKPASS executable")))
      }

      return writeFile(helperPath, executable, { flag: "wx", mode: 0o700 })
        .then(() => ({
          path: helperPath,
          cleanup: () => rm(directory, { recursive: true, force: true })
        }))
        .finally(() => executable.fill(0))
    })
}

function tokensEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8")
  const expectedBuffer = Buffer.from(expected, "utf8")

  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer)
}

function validateOptions(options: AskpassBrokerOptions): void {
  validatePositiveInteger(options.requestTimeoutMs, "requestTimeoutMs")
  validatePositiveInteger(options.lifetimeMs, "lifetimeMs")
  validatePositiveInteger(options.maximumPasswordPrompts, "maximumPasswordPrompts")

}

function validatePositiveInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new SshError({
      code: "invalid_input",
      operation: "start-askpass-broker",
      message: `${name} must be a positive integer`
    })
  }
}

function toBrokerError(error: unknown, operation: string): SshError {
  if (error instanceof SshError) {
    return error
  }

  return new SshError({
    code: "unknown_openssh_error",
    operation,
    message: "Unable to operate the ASKPASS broker",
    cause: error
  })
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined
  }

  return typeof error.code === "string" ? error.code : undefined
}
