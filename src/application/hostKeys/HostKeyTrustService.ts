import type { ConnectionRequest } from "../../domain/connection"
import { validateConnectionRequest } from "../../domain/connectionValidation"
import {
  classifyHostKeyFailure,
  type HostKeyFailureKind
} from "../../domain/hostKey"
import { SshError } from "../../domain/sshError"
import type { ProcessResult } from "../../domain/processResult"
import type { ProcessRunner } from "../../infrastructure/process/ProcessRunner"
import {
  OpenSshTargetResolver,
  type ResolvedSshTarget
} from "../targets/OpenSshTargetResolver"

const MAX_KNOWN_HOSTS_OUTPUT_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

export interface KnownHostCommand {
  readonly executable: "ssh-keygen"
  readonly args: ReadonlyArray<string>
}

export interface KnownHostLookup {
  readonly host: string
  readonly port: number
  readonly query: string
  readonly entries: ReadonlyArray<string>
  readonly command: KnownHostCommand
  readonly resolved: boolean
}

export interface HostKeyDiagnostic extends KnownHostLookup {
  readonly kind: HostKeyFailureKind
  readonly openSshMessage: string
  readonly possibleCauses: ReadonlyArray<string>
  readonly removalCommand?: KnownHostCommand
}

export class HostKeyTrustService {
  private readonly targetResolver: OpenSshTargetResolver

  constructor(
    private readonly processRunner: ProcessRunner,
    targetResolver?: OpenSshTargetResolver
  ) {
    this.targetResolver = targetResolver ?? new OpenSshTargetResolver(processRunner)
  }

  find(input: unknown): Promise<KnownHostLookup> {
    const request = validateConnectionRequest(input)

    return this.resolveBestEffort(request)
      .then(({ target, resolved }) => this.findTarget(target, resolved, request))
  }

  diagnose(input: unknown, openSshMessage: string): Promise<HostKeyDiagnostic> {
    const kind = classifyHostKeyFailure(openSshMessage)

    if (kind === undefined) {
      return Promise.reject(new SshError({
        code: "invalid_input",
        operation: "diagnose-host-key",
        message: "The OpenSSH diagnostic is not a host key failure"
      }))
    }

    return this.find(input)
      .then((lookup) => ({
        ...lookup,
        kind,
        openSshMessage,
        possibleCauses: kind === "changed"
          ? [
              "server reinstallation or an intentional host key rotation",
              "IP address reuse",
              "DNS, alias, proxy, or jump-host mismatch",
              "a man-in-the-middle attack"
            ]
          : [
              "first connection to this host",
              "a hostname, port, alias, proxy, or jump-host mismatch"
            ],
        ...(kind === "changed"
          ? { removalCommand: buildKnownHostRemovalCommand(lookup.query) }
          : {})
      }))
  }

  private resolveBestEffort(
    request: ConnectionRequest
  ): Promise<{ readonly target: ResolvedSshTarget; readonly resolved: boolean }> {
    return this.targetResolver.resolve(request)
      .then((target) => ({ target, resolved: true }))
      .catch(() => ({
        target: {
          hostName: request.target.host,
          user: request.auth.kind === "ssh-config" ? "" : request.auth.user,
          port: request.target.port ?? 22,
          identityFiles: []
        },
        resolved: false
      }))
  }

  private findTarget(
    target: ResolvedSshTarget,
    resolved: boolean,
    request: ConnectionRequest
  ): Promise<KnownHostLookup> {
    const query = formatKnownHostQuery(target.hostName, target.port)
    const command = buildKnownHostFindCommand(query)

    return this.processRunner.run({
      executable: command.executable,
      args: command.args,
      stdio: "capture",
      timeoutMs: request.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxCaptureBytes: MAX_KNOWN_HOSTS_OUTPUT_BYTES
    })
      .then((result) => createLookup(result, target, query, command, resolved))
  }
}

export function formatKnownHostQuery(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

export function buildKnownHostFindCommand(query: string): KnownHostCommand {
  return { executable: "ssh-keygen", args: ["-F", requireSafeQuery(query)] }
}

export function buildKnownHostRemovalCommand(query: string): KnownHostCommand {
  return { executable: "ssh-keygen", args: ["-R", requireSafeQuery(query)] }
}

function createLookup(
  result: ProcessResult,
  target: ResolvedSshTarget,
  query: string,
  command: KnownHostCommand,
  resolved: boolean
): KnownHostLookup {
  if (result.timedOut) {
    throw new SshError({
      code: "process_timeout",
      operation: "find-known-host",
      message: "Timed out while reading known_hosts"
    })
  }

  if (result.status === "cancelled") {
    throw new SshError({
      code: "cancelled",
      operation: "find-known-host",
      message: "Reading known_hosts was cancelled"
    })
  }

  if (result.stdoutTruncated) {
    throw new SshError({
      code: "config_error",
      operation: "find-known-host",
      message: "ssh-keygen output exceeded the allowed size"
    })
  }

  if (result.status === "failed" && result.exitCode !== 1) {
    throw new SshError({
      code: "config_error",
      operation: "find-known-host",
      message: "Unable to read known_hosts with ssh-keygen",
      context: { stderr: decode(result.stderr), exitCode: result.exitCode }
    })
  }

  const output = decode(result.stdout)
  const entries = output.length === 0 ? [] : output.split(/\r?\n/u)

  return {
    host: target.hostName,
    port: target.port,
    query,
    entries,
    command,
    resolved
  }
}

function decode(input: Readonly<Uint8Array> | undefined): string {
  return input === undefined ? "" : Buffer.from(input).toString("utf8").trim()
}

function requireSafeQuery(input: string): string {
  if (input.length === 0 || /[\u0000\r\n]/u.test(input)) {
    throw new SshError({
      code: "invalid_input",
      operation: "build-known-host-command",
      message: "known_hosts query contains an invalid value"
    })
  }

  return input
}
