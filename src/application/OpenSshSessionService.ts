import { stat } from "node:fs/promises"

import type { ConnectionRequest } from "../domain/connection"
import { validateConnectionRequest } from "../domain/connectionValidation"
import {
  classifyOpenSshFailure,
  type OpenSshOperation
} from "../domain/openSshFailure"
import type { ProcessResult } from "../domain/processResult"
import { SshError } from "../domain/sshError"
import { runWithAskpass, type AskpassBrokerOptions } from "../infrastructure/askpass/AskpassBroker"
import {
  buildSshConnectArguments,
  buildSshExecuteArguments,
  buildScpDownloadArguments,
  buildScpUploadArguments,
  buildSftpArguments
} from "../infrastructure/openssh/OpenSshArguments"
import { buildSftpBatch } from "../infrastructure/openssh/SftpBatch"
import type {
  ProcessRunner,
  RunProcessRequest
} from "../infrastructure/process/ProcessRunner"
import type {
  ConnectOptions,
  ExecuteOutput,
  ExecuteRequest,
  ExecuteStdin,
  FileTransferResult,
  SessionOperationOptions,
  SessionState,
  SftpBatchRequest,
  SshSessionApplication,
  DownloadRequest,
  UploadRequest
} from "./SshSessionApplication"

const DEFAULT_CAPTURE_BYTES = 1024 * 1024

export class OpenSshSessionService implements Pick<
  SshSessionApplication,
  "connect" | "execute" | "upload" | "download" | "files" | "executeFileBatch"
> {
  constructor(private readonly processRunner: ProcessRunner) {}

  connect(input: ConnectionRequest, options: ConnectOptions = {}): Promise<ProcessResult> {
    const connection = validateConnectionRequest(input)
    const processRequest: RunProcessRequest = {
      executable: "ssh",
      args: buildSshConnectArguments(connection),
      stdio: "inherit",
      ...(connection.overallTimeoutMs === undefined
        ? {}
        : { timeoutMs: connection.overallTimeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    }

    return this.run(connection, processRequest, options, "connect")
  }

  execute(input: ExecuteRequest): Promise<ProcessResult> {
    const connection = validateConnectionRequest(input.connection)
    const processRequest = createExecuteProcessRequest(connection, input)

    return this.run(connection, processRequest, input, "execute", true)
  }

  upload(input: UploadRequest): Promise<FileTransferResult> {
    const connection = validateConnectionRequest(input.connection)

    return validateUploadSource(input.localPath, input.recursive === true)
      .then(() => this.runTransfer(connection, {
        executable: "scp",
        args: buildScpUploadArguments(connection, input),
        stdio: "inherit",
        ...(connection.overallTimeoutMs === undefined
          ? {}
          : { timeoutMs: connection.overallTimeoutMs }),
        ...(input.signal === undefined ? {} : { signal: input.signal })
      }, input, "upload"))
  }

  download(input: DownloadRequest): Promise<FileTransferResult> {
    const connection = validateConnectionRequest(input.connection)

    return this.runTransfer(connection, {
      executable: "scp",
      args: buildScpDownloadArguments(connection, input),
      stdio: "inherit",
      ...(connection.overallTimeoutMs === undefined
        ? {}
        : { timeoutMs: connection.overallTimeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal })
    }, input, "download")
  }

  files(
    input: ConnectionRequest,
    options: SessionOperationOptions = {}
  ): Promise<ProcessResult> {
    const connection = validateConnectionRequest(input)

    return this.run(connection, {
      executable: "sftp",
      args: buildSftpArguments(connection),
      stdio: "inherit",
      ...(connection.overallTimeoutMs === undefined
        ? {}
        : { timeoutMs: connection.overallTimeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    }, options, "files")
  }

  executeFileBatch(input: SftpBatchRequest): Promise<FileTransferResult> {
    const connection = validateConnectionRequest(input.connection)
    const output = input.output ?? { mode: "capture", maxBytes: DEFAULT_CAPTURE_BYTES }

    return this.runTransfer(connection, {
      executable: "sftp",
      args: buildSftpArguments(connection, { batch: true }),
      stdin: buildSftpBatch(input.operations),
      ...createOutputOptions(output),
      ...(connection.overallTimeoutMs === undefined
        ? {}
        : { timeoutMs: connection.overallTimeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal })
    }, input, "file-batch", true)
  }

  private runTransfer(
    connection: ConnectionRequest,
    request: RunProcessRequest,
    options: SessionOperationOptions,
    operation: OpenSshOperation,
    forceAskpass = false
  ): Promise<FileTransferResult> {
    return this.run(connection, request, options, operation, forceAskpass)
      .then((result) => ({
        ...result,
        potentiallyPartial: result.status !== "completed"
      }))
  }

  private run(
    connection: ConnectionRequest,
    request: RunProcessRequest,
    options: SessionOperationOptions,
    operation: OpenSshOperation,
    forceAskpass = false
  ): Promise<ProcessResult> {
    emitState(options, "starting")
    const observedRequest = observeProcessRequest(request, options)
    let operationPromise: Promise<ProcessResult>

    if (connection.auth.kind === "ssh-config" && !forceAskpass) {
      operationPromise = this.processRunner.run(observedRequest)
    } else {
      const askpassOptions: AskpassBrokerOptions = {
        auth: connection.auth,
        hostKeyPolicy: connection.hostKeyPolicy,
        ...(options.confirmHostKey === undefined
          ? {}
          : {
              confirmHostKey: (prompt) => {
                options.onEvent?.({ type: "prompt", prompt })
                return options.confirmHostKey?.(prompt) ?? Promise.resolve(false)
              }
            }),
        ...(options.signal === undefined ? {} : { signal: options.signal })
      }

      operationPromise = runWithAskpass(
        this.processRunner,
        observedRequest,
        askpassOptions
      )
    }

    return operationPromise
      .then((result) => {
        const error = classifyOpenSshFailure(operation, result)
        const enrichedResult: ProcessResult = error === undefined
          ? result
          : { ...result, error }

        if (error !== undefined) {
          options.onEvent?.({ type: "failure", error })
        }

        emitState(options, toSessionState(enrichedResult))
        return enrichedResult
      })
      .catch((error: unknown) => {
        if (error instanceof SshError) {
          options.onEvent?.({ type: "failure", error })
          emitState(options, error.code === "cancelled" ? "cancelled" : "failed")
        } else {
          emitState(options, "failed")
        }

        throw error
      })
  }
}

function observeProcessRequest(
  request: RunProcessRequest,
  options: SessionOperationOptions
): RunProcessRequest {
  const observeStream = request.stdio === "stream" && options.onEvent !== undefined

  return {
    ...request,
    onSpawn: () => {
      request.onSpawn?.()
      emitState(options, "running")
    },
    ...(request.onStdout === undefined && !observeStream
      ? {}
      : {
          onStdout: (chunk: Readonly<Uint8Array>) => {
            options.onEvent?.({ type: "output", stream: "stdout", chunk })
            request.onStdout?.(chunk)
          }
        }),
    ...(request.onStderr === undefined && !observeStream
      ? {}
      : {
          onStderr: (chunk: Readonly<Uint8Array>) => {
            options.onEvent?.({ type: "output", stream: "stderr", chunk })
            request.onStderr?.(chunk)
          }
        })
  }
}

function emitState(options: SessionOperationOptions, state: SessionState): void {
  options.onEvent?.({ type: "state", state })
  const connectOptions = options as ConnectOptions
  connectOptions.onStateChange?.(state)
}

function validateUploadSource(localPath: string, recursive: boolean): Promise<void> {
  return stat(localPath)
    .then((source) => {
      if (source.isDirectory() && !recursive) {
        throw new SshError({
          code: "invalid_input",
          operation: "validate-upload-source",
          message: "uploading a directory requires recursive mode"
        })
      }
    })
    .catch((error: unknown) => {
      if (error instanceof SshError) {
        throw error
      }

      throw new SshError({
        code: "invalid_input",
        operation: "validate-upload-source",
        message: "local upload source does not exist or is not accessible",
        cause: error
      })
    })
}

function createExecuteProcessRequest(
  connection: ConnectionRequest,
  request: ExecuteRequest
): RunProcessRequest {
  const output = request.output ?? { mode: "capture", maxBytes: DEFAULT_CAPTURE_BYTES }
  const stdin = request.stdin ?? { mode: "null" }

  return {
    executable: "ssh",
    args: buildSshExecuteArguments(connection, {
      command: request.command,
      ...(request.tty === undefined ? {} : { tty: request.tty })
    }),
    ...createOutputOptions(output),
    ...createStdinOptions(stdin),
    ...(connection.overallTimeoutMs === undefined
      ? {}
      : { timeoutMs: connection.overallTimeoutMs }),
    ...(request.signal === undefined ? {} : { signal: request.signal })
  }
}

function createOutputOptions(output: ExecuteOutput): Pick<
  RunProcessRequest,
  "stdio" | "maxCaptureBytes" | "onStdout" | "onStderr"
> {
  if (output.mode === "stream") {
    return {
      stdio: "stream",
      ...(output.onStdout === undefined ? {} : { onStdout: output.onStdout }),
      ...(output.onStderr === undefined ? {} : { onStderr: output.onStderr })
    }
  }

  return {
    stdio: "capture",
    maxCaptureBytes: output.maxBytes ?? DEFAULT_CAPTURE_BYTES
  }
}

function createStdinOptions(stdin: ExecuteStdin): Pick<
  RunProcessRequest,
  "stdin" | "inheritStdin"
> {
  if (stdin.mode === "inherit") {
    return { inheritStdin: true }
  }

  if (stdin.mode === "pipe") {
    return { stdin: stdin.data }
  }

  return {}
}

function toSessionState(result: ProcessResult): SessionState {
  if (result.status === "cancelled") {
    return "cancelled"
  }

  return result.status === "completed" ? "completed" : "failed"
}
