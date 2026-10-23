import { redactDiagnosticValue } from "../security/redaction"

export const SSH_ERROR_CODES = [
  "executable_not_found",
  "invalid_input",
  "config_error",
  "dns_failed",
  "connection_refused",
  "connection_timeout",
  "proxy_failed",
  "host_key_unknown",
  "host_key_changed",
  "authentication_failed",
  "key_unreadable",
  "key_passphrase_required",
  "mfa_required",
  "permission_denied",
  "connection_lost",
  "process_timeout",
  "remote_command_failed",
  "transfer_failed",
  "cancelled",
  "unknown_openssh_error"
] as const

export type SshErrorCode = (typeof SSH_ERROR_CODES)[number]

export interface SshErrorOptions {
  readonly code: SshErrorCode
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
  readonly context?: Readonly<Record<string, unknown>>
}

export class SshError extends Error {
  readonly code: SshErrorCode
  readonly domain = "ssh-session"
  readonly operation: string
  readonly context?: unknown

  constructor(options: SshErrorOptions) {
    super(
      options.message,
      options.cause === undefined ? undefined : { cause: options.cause }
    )

    this.name = "SshError"
    this.code = options.code
    this.operation = options.operation

    if (options.context !== undefined) {
      this.context = redactDiagnosticValue(options.context)
    }
  }
}
