import { spawn, type ChildProcess, type StdioOptions } from "node:child_process"
import { performance } from "node:perf_hooks"

import { SshError } from "../../domain/sshError"
import type { ProcessResult, ProcessStatus } from "../../domain/processResult"
import type { ProcessRunner, RunProcessRequest } from "./ProcessRunner"

const DEFAULT_MAX_CAPTURE_BYTES = 1024 * 1024
const FORCE_KILL_DELAY_MS = 2_000
const INVALID_ARGUMENT_PATTERN = /[\u0000\r\n]/u

interface CaptureState {
  readonly chunks: Buffer[]
  size: number
  truncated: boolean
}

export class NodeProcessRunner implements ProcessRunner {
  run(request: RunProcessRequest): Promise<ProcessResult> {
    validateRequest(request)

    const startedAt = performance.now()

    if (request.signal?.aborted === true) {
      return Promise.resolve(createCancelledResult(startedAt))
    }

    return new Promise<ProcessResult>((resolve, reject) => {
      const maximumCaptureBytes = request.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES
      const stdoutCapture = createCaptureState()
      const stderrCapture = createCaptureState()
      let child: ChildProcess
      let settled = false
      let cancelled = false
      let timedOut = false
      let timeoutHandle: NodeJS.Timeout | undefined
      let forceKillHandle: NodeJS.Timeout | undefined

      const environment = createEnvironment(request.environment)
      const stdio: StdioOptions = request.stdio === "inherit"
        ? "inherit"
        : [
            request.inheritStdin === true
              ? "inherit"
              : request.stdin === undefined ? "ignore" : "pipe",
            "pipe",
            "pipe"
          ]

      try {
        child = spawn(request.executable, [...request.args], {
          env: environment,
          shell: false,
          stdio,
          windowsHide: request.stdio === "capture"
        })
      } catch (error: unknown) {
        reject(toSpawnError(error, request.executable))
        return
      }

      const cleanup = () => {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle)
        }

        if (forceKillHandle !== undefined) {
          clearTimeout(forceKillHandle)
        }

        request.signal?.removeEventListener("abort", abortProcess)
      }

      const finishWithError = (error: unknown) => {
        if (settled) {
          return
        }

        settled = true
        cleanup()
        reject(toSpawnError(error, request.executable))
      }

      const terminateProcess = () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return
        }

        child.kill("SIGTERM")
        forceKillHandle = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL")
          }
        }, FORCE_KILL_DELAY_MS)
        forceKillHandle.unref()
      }

      function abortProcess(): void {
        cancelled = true
        terminateProcess()
      }

      child.once("error", finishWithError)
      child.once("spawn", () => request.onSpawn?.())
      child.once("close", (exitCode, signal) => {
        if (settled) {
          return
        }

        settled = true
        cleanup()

        const status: ProcessStatus = cancelled
          ? "cancelled"
          : exitCode === 0 && !timedOut
            ? "completed"
            : "failed"
        const result: ProcessResult = {
          status,
          exitCode,
          signal,
          durationMs: Math.max(0, performance.now() - startedAt),
          timedOut,
          stdoutTruncated: stdoutCapture.truncated,
          stderrTruncated: stderrCapture.truncated,
            ...(request.stdio === "capture"
            ? {
                stdout: Buffer.concat(stdoutCapture.chunks),
                stderr: Buffer.concat(stderrCapture.chunks)
              }
            : {})
        }

        resolve(result)
      })

      if (request.stdio !== "inherit") {
        child.stdout?.on("data", (chunk: Buffer | string) => {
          if (request.stdio === "capture") {
            captureChunk(stdoutCapture, chunk, maximumCaptureBytes)
          } else {
            request.onStdout?.(toBuffer(chunk))
          }
        })
        child.stderr?.on("data", (chunk: Buffer | string) => {
          if (request.stdio === "capture") {
            captureChunk(stderrCapture, chunk, maximumCaptureBytes)
          } else {
            request.onStderr?.(toBuffer(chunk))
          }
        })

        if (request.stdin !== undefined) {
          child.stdin?.on("error", () => undefined)
          child.stdin?.end(request.stdin)
        }
      }

      if (request.timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          timedOut = true
          terminateProcess()
        }, request.timeoutMs)
        timeoutHandle.unref()
      }

      request.signal?.addEventListener("abort", abortProcess, { once: true })

      if (request.signal?.aborted === true) {
        abortProcess()
      }
    })
  }
}

function validateRequest(request: RunProcessRequest): void {
  if (
    request.executable.length === 0
    || INVALID_ARGUMENT_PATTERN.test(request.executable)
  ) {
    throw invalidProcessRequest("executable is invalid")
  }

  const invalidArgument = request.args.find((argument) => INVALID_ARGUMENT_PATTERN.test(argument))

  if (invalidArgument !== undefined) {
    throw invalidProcessRequest("process arguments cannot contain NUL or line breaks")
  }

  if (request.stdio === "inherit" && request.stdin !== undefined) {
    throw invalidProcessRequest("stdin data cannot be provided when stdio is inherited")
  }

  if (request.stdio === "inherit" && request.inheritStdin !== undefined) {
    throw invalidProcessRequest("inheritStdin cannot be configured when stdio is inherited")
  }

  if (request.stdin !== undefined && request.inheritStdin === true) {
    throw invalidProcessRequest("stdin data and inherited stdin are mutually exclusive")
  }

  if (
    request.stdio === "stream"
    && request.onStdout === undefined
    && request.onStderr === undefined
  ) {
    throw invalidProcessRequest("stream stdio requires an output handler")
  }

  if (request.stdio !== "stream" && (
    request.onStdout !== undefined || request.onStderr !== undefined
  )) {
    throw invalidProcessRequest("output handlers require stream stdio")
  }

  validatePositiveInteger(request.timeoutMs, "timeoutMs")
  validatePositiveInteger(request.maxCaptureBytes, "maxCaptureBytes")

  if (request.environment !== undefined) {
    for (const [key, value] of Object.entries(request.environment)) {
      if (
        key.length === 0
        || INVALID_ARGUMENT_PATTERN.test(key)
        || (value !== undefined && value.includes("\u0000"))
      ) {
        throw invalidProcessRequest("environment contains an invalid entry")
      }
    }
  }
}

function validatePositiveInteger(input: number | undefined, fieldName: string): void {
  if (input !== undefined && (!Number.isInteger(input) || input <= 0)) {
    throw invalidProcessRequest(`${fieldName} must be a positive integer`)
  }
}

function createEnvironment(
  overrides: Readonly<Record<string, string | undefined>> | undefined
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env }

  if (overrides === undefined) {
    return environment
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete environment[key]
    } else {
      environment[key] = value
    }
  }

  return environment
}

function createCaptureState(): CaptureState {
  return { chunks: [], size: 0, truncated: false }
}

function captureChunk(
  state: CaptureState,
  input: Buffer | string,
  maximumBytes: number
): void {
  const chunk = typeof input === "string" ? Buffer.from(input) : input
  const remainingBytes = maximumBytes - state.size

  if (remainingBytes <= 0) {
    state.truncated = true
    return
  }

  if (chunk.length <= remainingBytes) {
    state.chunks.push(Buffer.from(chunk))
    state.size += chunk.length
    return
  }

  state.chunks.push(Buffer.from(chunk.subarray(0, remainingBytes)))
  state.size += remainingBytes
  state.truncated = true
}

function toBuffer(input: Buffer | string): Buffer {
  return typeof input === "string" ? Buffer.from(input) : Buffer.from(input)
}

function createCancelledResult(startedAt: number): ProcessResult {
  return {
    status: "cancelled",
    exitCode: null,
    signal: null,
    durationMs: Math.max(0, performance.now() - startedAt),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false
  }
}

function toSpawnError(error: unknown, executable: string): SshError {
  const code = getNodeErrorCode(error)

  return new SshError({
    code: code === "ENOENT" ? "executable_not_found" : "unknown_openssh_error",
    operation: "spawn-process",
    message: code === "ENOENT"
      ? `Executable not found: ${executable}`
      : `Unable to start executable: ${executable}`,
    cause: error,
    context: { executable, systemCode: code }
  })
}

function getNodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined
  }

  return typeof error.code === "string" ? error.code : undefined
}

function invalidProcessRequest(message: string): SshError {
  return new SshError({
    code: "invalid_input",
    operation: "validate-process-request",
    message
  })
}
