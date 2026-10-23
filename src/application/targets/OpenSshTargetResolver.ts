import type { ConnectionRequest } from "../../domain/connection"
import { validateConnectionRequest } from "../../domain/connectionValidation"
import { SshError } from "../../domain/sshError"
import { buildSshConfigQueryArguments } from "../../infrastructure/openssh/OpenSshArguments"
import type { OpenSshBuildContext } from "../../infrastructure/openssh/OpenSshArguments"
import type { ProcessRunner } from "../../infrastructure/process/ProcessRunner"

const MAX_CONFIG_OUTPUT_BYTES = 1024 * 1024

export interface ResolvedSshTarget {
  readonly hostName: string
  readonly user: string
  readonly port: number
  readonly proxyJump?: string
  readonly identityFiles: ReadonlyArray<string>
}

export class OpenSshTargetResolver {
  constructor(
    private readonly processRunner: ProcessRunner,
    private readonly buildContext?: OpenSshBuildContext
  ) {}

  resolve(input: unknown): Promise<ResolvedSshTarget> {
    const request = validateConnectionRequest(input)
    const args = this.buildContext === undefined
      ? buildSshConfigQueryArguments(request)
      : buildSshConfigQueryArguments(request, this.buildContext)

    return this.processRunner.run({
      executable: "ssh",
      args,
      stdio: "capture",
      timeoutMs: request.connectTimeoutMs ?? 10_000,
      maxCaptureBytes: MAX_CONFIG_OUTPUT_BYTES
    })
      .then((result) => {
        if (result.status !== "completed" || result.stdoutTruncated) {
          throw configResolutionError(request, result.stderr, result.timedOut)
        }

        return parseSshConfigOutput(result.stdout)
      })
  }
}

export function parseSshConfigOutput(
  input: Readonly<Uint8Array> | string | undefined
): ResolvedSshTarget {
  const text = typeof input === "string"
    ? input
    : input === undefined
      ? ""
      : Buffer.from(input).toString("utf8")
  const values = new Map<string, string[]>()

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim()

    if (line.length === 0) {
      continue
    }

    const separatorIndex = line.search(/\s/u)

    if (separatorIndex <= 0) {
      continue
    }

    const key = line.slice(0, separatorIndex).toLowerCase()
    const value = line.slice(separatorIndex).trim()
    const existingValues = values.get(key)

    if (existingValues === undefined) {
      values.set(key, [value])
    } else {
      existingValues.push(value)
    }
  }

  const hostName = firstRequiredValue(values, "hostname")
  const user = firstRequiredValue(values, "user")
  const portText = firstRequiredValue(values, "port")
  const port = Number(portText)

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw invalidConfigOutput(`ssh -G returned invalid port: ${portText}`)
  }

  const proxyJumpValue = values.get("proxyjump")?.[0]
  const proxyJump = proxyJumpValue === undefined || proxyJumpValue === "none"
    ? undefined
    : proxyJumpValue

  return {
    hostName,
    user,
    port,
    identityFiles: values.get("identityfile")?.slice() ?? [],
    ...(proxyJump === undefined ? {} : { proxyJump })
  }
}

function firstRequiredValue(values: ReadonlyMap<string, string[]>, key: string): string {
  const value = values.get(key)?.[0]

  if (value === undefined || value.length === 0) {
    throw invalidConfigOutput(`ssh -G output does not contain ${key}`)
  }

  return value
}

function configResolutionError(
  request: ConnectionRequest,
  stderr: Readonly<Uint8Array> | undefined,
  timedOut: boolean
): SshError {
  return new SshError({
    code: timedOut ? "process_timeout" : "config_error",
    operation: "resolve-ssh-target",
    message: timedOut
      ? "Timed out while resolving OpenSSH configuration"
      : "Unable to resolve OpenSSH configuration",
    context: {
      host: request.target.host,
      stderr: stderr === undefined ? "" : Buffer.from(stderr).toString("utf8").trim()
    }
  })
}

function invalidConfigOutput(message: string): SshError {
  return new SshError({
    code: "config_error",
    operation: "parse-ssh-config",
    message
  })
}
