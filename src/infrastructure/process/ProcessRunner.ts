import type { ProcessResult } from "../../domain/processResult"

export type ProcessStdioMode = "capture" | "inherit" | "stream"

export type ProcessOutputHandler = (chunk: Readonly<Uint8Array>) => void

export interface RunProcessRequest {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly stdio: ProcessStdioMode
  readonly stdin?: string | Uint8Array
  readonly inheritStdin?: boolean
  readonly onStdout?: ProcessOutputHandler
  readonly onStderr?: ProcessOutputHandler
  readonly onSpawn?: () => void
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly maxCaptureBytes?: number
}

export interface ProcessRunner {
  run(request: RunProcessRequest): Promise<ProcessResult>
}
