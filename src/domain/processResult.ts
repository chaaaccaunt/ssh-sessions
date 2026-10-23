import type { SshError } from "./sshError"

export type ProcessStatus = "completed" | "failed" | "cancelled"

export interface ProcessResult {
  readonly status: ProcessStatus
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly durationMs: number
  readonly timedOut: boolean
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  readonly stdout?: Readonly<Uint8Array>
  readonly stderr?: Readonly<Uint8Array>
  readonly error?: SshError
}
