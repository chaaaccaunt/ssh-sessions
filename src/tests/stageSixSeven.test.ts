import assert from "node:assert/strict"
import { test } from "node:test"

import { OpenSshSessionService } from "../application/OpenSshSessionService"
import type { SessionState } from "../application/SshSessionApplication"
import type { ConnectionRequest } from "../domain/connection"
import type { ProcessResult } from "../domain/processResult"
import { NodeProcessRunner } from "../infrastructure/process/NodeProcessRunner"
import type {
  ProcessRunner,
  RunProcessRequest
} from "../infrastructure/process/ProcessRunner"

test("connect inherits the terminal and reports observable session states", async () => {
  const runner = new RecordingProcessRunner(createProcessResult())
  const service = new OpenSshSessionService(runner)
  const states: SessionState[] = []
  const result = await service.connect(createConfigConnection(), {
    onStateChange: (state) => states.push(state)
  })

  assert.equal(result.exitCode, 0)
  assert.equal(runner.requests[0]?.executable, "ssh")
  assert.equal(runner.requests[0]?.stdio, "inherit")
  assert.deepEqual(states, ["starting", "running", "completed"])
})

test("connect attaches ASKPASS without placing a password in argv or environment", async () => {
  const secret = "stage-six-secret"
  const runner = new RecordingProcessRunner(createProcessResult())
  const service = new OpenSshSessionService(runner)

  await service.connect({
    target: { host: "example.test" },
    auth: {
      kind: "password",
      user: "operator",
      getPassword: () => Promise.resolve(Buffer.from(secret))
    },
    hostKeyPolicy: "strict"
  })

  const request = runner.requests[0]
  assert.equal(request?.args.join(" ").includes(secret), false)
  assert.equal(JSON.stringify(request?.environment).includes(secret), false)
  assert.equal(typeof request?.environment?.SSH_ASKPASS, "string")
})

test("execute captures binary output and preserves the remote exit code", async () => {
  const stdout = Buffer.from([0, 1, 2, 255])
  const runner = new RecordingProcessRunner(createProcessResult({
    status: "failed",
    exitCode: 23,
    stdout,
    stderr: Buffer.from("failure")
  }))
  const result = await new OpenSshSessionService(runner).execute({
    connection: createConfigConnection("strict"),
    command: "binary-command"
  })

  assert.equal(result.exitCode, 23)
  assert.deepEqual(Buffer.from(result.stdout ?? []), stdout)
  assert.equal(runner.requests[0]?.stdio, "capture")
  assert.equal(runner.requests[0]?.args.includes("-T"), true)
})

test("execute supports explicit PTY, piped stdin, and streamed output", async () => {
  const runner = new RecordingProcessRunner(createProcessResult(), {
    stdout: Buffer.from("out"),
    stderr: Buffer.from("err")
  })
  const stdoutChunks: Uint8Array[] = []
  const stderrChunks: Uint8Array[] = []

  await new OpenSshSessionService(runner).execute({
    connection: createConfigConnection("strict"),
    command: "interactive-command",
    tty: true,
    stdin: { mode: "pipe", data: Buffer.from("input") },
    output: {
      mode: "stream",
      onStdout: (chunk) => stdoutChunks.push(chunk),
      onStderr: (chunk) => stderrChunks.push(chunk)
    }
  })

  const request = runner.requests[0]
  assert.equal(request?.args.includes("-tt"), true)
  assert.deepEqual(request?.stdin, Buffer.from("input"))
  assert.equal(Buffer.concat(stdoutChunks).toString("utf8"), "out")
  assert.equal(Buffer.concat(stderrChunks).toString("utf8"), "err")
})

test("node process runner streams output and pipes stdin without text decoding", async () => {
  const stdoutChunks: Uint8Array[] = []
  const stderrChunks: Uint8Array[] = []
  const result = await new NodeProcessRunner().run({
    executable: process.execPath,
    args: [
      "-e",
      "process.stdin.on('data',d=>process.stdout.write(d));process.stdin.on('end',()=>process.stderr.write(Buffer.from([0,255])))"
    ],
    stdio: "stream",
    stdin: Buffer.from([1, 2, 3]),
    onStdout: (chunk) => stdoutChunks.push(chunk),
    onStderr: (chunk) => stderrChunks.push(chunk)
  })

  assert.equal(result.status, "completed")
  assert.deepEqual(Buffer.concat(stdoutChunks), Buffer.from([1, 2, 3]))
  assert.deepEqual(Buffer.concat(stderrChunks), Buffer.from([0, 255]))
  assert.equal(result.stdout, undefined)
})

class RecordingProcessRunner implements ProcessRunner {
  readonly requests: RunProcessRequest[] = []

  constructor(
    private readonly result: ProcessResult,
    private readonly streamed: {
      readonly stdout?: Uint8Array
      readonly stderr?: Uint8Array
    } = {}
  ) {}

  run(request: RunProcessRequest): Promise<ProcessResult> {
    this.requests.push(request)
    request.onSpawn?.()

    if (this.streamed.stdout !== undefined) {
      request.onStdout?.(this.streamed.stdout)
    }

    if (this.streamed.stderr !== undefined) {
      request.onStderr?.(this.streamed.stderr)
    }

    return Promise.resolve(this.result)
  }
}

function createConfigConnection(
  hostKeyPolicy: ConnectionRequest["hostKeyPolicy"] = "ask"
): ConnectionRequest {
  return {
    target: { host: "production" },
    auth: { kind: "ssh-config" },
    hostKeyPolicy
  }
}

function createProcessResult(
  overrides: Partial<ProcessResult> = {}
): ProcessResult {
  return {
    status: "completed",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides
  }
}
