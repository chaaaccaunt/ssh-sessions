import type { ProcessResult } from "./processResult"
import { SshError, type SshErrorCode } from "./sshError"

export type OpenSshOperation =
  | "connect"
  | "execute"
  | "upload"
  | "download"
  | "files"
  | "file-batch"

const MAX_DIAGNOSTIC_LENGTH = 16 * 1024
const ANSI_ESCAPE_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/gu

const FAILURE_PATTERNS: ReadonlyArray<{
  readonly code: SshErrorCode
  readonly pattern: RegExp
}> = [
  {
    code: "host_key_changed",
    pattern: /remote host identification has changed|offending .* key in/iu
  },
  {
    code: "host_key_unknown",
    pattern: /authenticity of host .* can't be established|no .* host key is known for|host key verification failed/iu
  },
  {
    code: "config_error",
    pattern: /bad configuration option|terminating, \d+ bad configuration options|could not open user config file/iu
  },
  {
    code: "dns_failed",
    pattern: /could not resolve hostname|name or service not known|nodename nor servname provided/iu
  },
  {
    code: "connection_refused",
    pattern: /connection refused/iu
  },
  {
    code: "connection_timeout",
    pattern: /connection timed out|operation timed out|connect to host .* port .* timed out/iu
  },
  {
    code: "proxy_failed",
    pattern: /proxycommand failed|stdio forwarding failed|connection closed by unknown port 65535/iu
  },
  {
    code: "key_unreadable",
    pattern: /identity file .* not accessible|load key .* permission denied|error loading key/iu
  },
  {
    code: "key_passphrase_required",
    pattern: /incorrect passphrase supplied to decrypt private key|bad passphrase/iu
  },
  {
    code: "mfa_required",
    pattern: /verification code|one[- ]time password|two[- ]factor/iu
  },
  {
    code: "authentication_failed",
    pattern: /permission denied \([^\r\n]*(?:publickey|password|keyboard-interactive)[^\r\n]*\)|authentication failed|too many authentication failures/iu
  },
  {
    code: "permission_denied",
    pattern: /permission denied/iu
  },
  {
    code: "connection_lost",
    pattern: /connection (?:closed|reset|lost)|broken pipe|client_loop: send disconnect/iu
  }
]

export function classifyOpenSshFailure(
  operation: OpenSshOperation,
  result: ProcessResult
): SshError | undefined {
  if (result.status === "completed") {
    return undefined
  }

  const diagnostic = sanitizeOpenSshDiagnostic(result.stderr)
  const code = classifyFailureCode(operation, result, diagnostic)

  return new SshError({
    code,
    operation,
    message: failureMessage(code),
    context: {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      diagnostic
    }
  })
}

export function sanitizeOpenSshDiagnostic(
  input: Readonly<Uint8Array> | string | undefined
): string | undefined {
  if (input === undefined) {
    return undefined
  }

  const decoded = typeof input === "string"
    ? input
    : Buffer.from(input).toString("utf8")
  const sanitized = decoded
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(CONTROL_CHARACTER_PATTERN, "")
    .trim()

  if (sanitized.length === 0) {
    return undefined
  }

  return sanitized.slice(0, MAX_DIAGNOSTIC_LENGTH)
}

function classifyFailureCode(
  operation: OpenSshOperation,
  result: ProcessResult,
  diagnostic: string | undefined
): SshErrorCode {
  if (result.status === "cancelled") {
    return "cancelled"
  }

  if (result.timedOut) {
    return "connection_timeout"
  }

  if (diagnostic !== undefined) {
    const match = FAILURE_PATTERNS.find(({ pattern }) => pattern.test(diagnostic))

    if (match !== undefined) {
      return match.code
    }
  }

  if (result.signal !== null) {
    return "connection_lost"
  }

  if (operation === "execute") {
    return "remote_command_failed"
  }

  if (
    operation === "upload"
    || operation === "download"
    || operation === "files"
    || operation === "file-batch"
  ) {
    return "transfer_failed"
  }

  return "unknown_openssh_error"
}

function failureMessage(code: SshErrorCode): string {
  const words = code.replaceAll("_", " ")
  return `OpenSSH failed: ${words}`
}
