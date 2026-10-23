import type { ConnectionRequest } from "../domain/connection"
import type { ProcessResult } from "../domain/processResult"
import type { SshError } from "../domain/sshError"
import type { HostKeyConfirmationRequest } from "../infrastructure/askpass/AskpassBroker"
import type { ProcessOutputHandler } from "../infrastructure/process/ProcessRunner"

export type SessionState = "starting" | "running" | "completed" | "failed" | "cancelled"

export type SessionEvent =
  | { readonly type: "state", readonly state: SessionState }
  | {
      readonly type: "output"
      readonly stream: "stdout" | "stderr"
      readonly chunk: Readonly<Uint8Array>
    }
  | {
      readonly type: "prompt"
      readonly prompt: HostKeyConfirmationRequest
    }
  | { readonly type: "failure", readonly error: SshError }

export type SessionEventHandler = (event: SessionEvent) => void

export interface SessionOperationOptions {
  readonly signal?: AbortSignal
  readonly onEvent?: SessionEventHandler
  readonly confirmHostKey?: (
    request: HostKeyConfirmationRequest
  ) => Promise<boolean>
}

export interface ConnectOptions extends SessionOperationOptions {
  readonly onStateChange?: (state: SessionState) => void
}

export type ExecuteStdin =
  | { readonly mode: "inherit" }
  | { readonly mode: "null" }
  | { readonly mode: "pipe", readonly data: string | Uint8Array }

export type ExecuteOutput =
  | { readonly mode: "capture", readonly maxBytes?: number }
  | {
      readonly mode: "stream"
      readonly onStdout?: ProcessOutputHandler
      readonly onStderr?: ProcessOutputHandler
    }

export interface ExecuteRequest extends SessionOperationOptions {
  readonly connection: ConnectionRequest
  readonly command: string
  readonly tty?: boolean
  readonly stdin?: ExecuteStdin
  readonly output?: ExecuteOutput
}

export interface UploadRequest extends SessionOperationOptions {
  readonly connection: ConnectionRequest
  readonly localPath: string
  readonly remotePath: string
  readonly recursive?: boolean
}

export interface DownloadRequest extends SessionOperationOptions {
  readonly connection: ConnectionRequest
  readonly remotePath: string
  readonly localPath: string
  readonly recursive?: boolean
}

export interface FileTransferResult extends ProcessResult {
  readonly potentiallyPartial: boolean
}

export type SftpBatchOperation =
  | {
      readonly kind: "put"
      readonly localPath: string
      readonly remotePath?: string
      readonly recursive?: boolean
    }
  | {
      readonly kind: "get"
      readonly remotePath: string
      readonly localPath?: string
      readonly recursive?: boolean
    }
  | { readonly kind: "mkdir", readonly path: string }
  | { readonly kind: "rename", readonly fromPath: string, readonly toPath: string }
  | { readonly kind: "remove", readonly path: string }
  | { readonly kind: "rmdir", readonly path: string }

export interface SftpBatchRequest extends SessionOperationOptions {
  readonly connection: ConnectionRequest
  readonly operations: ReadonlyArray<SftpBatchOperation>
  readonly output?: ExecuteOutput
}

export interface SshSessionApplication {
  connect(connection: ConnectionRequest, options?: ConnectOptions): Promise<ProcessResult>
  execute(request: ExecuteRequest): Promise<ProcessResult>
  upload(request: UploadRequest): Promise<FileTransferResult>
  download(request: DownloadRequest): Promise<FileTransferResult>
  files(connection: ConnectionRequest, options?: SessionOperationOptions): Promise<ProcessResult>
  executeFileBatch(request: SftpBatchRequest): Promise<FileTransferResult>
}
