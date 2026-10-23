import assert from "node:assert/strict"
import { test } from "node:test"

import { OpenSshSessionService } from "../application/OpenSshSessionService"
import type { SessionEvent } from "../application/SshSessionApplication"
import type { ConnectionRequest } from "../domain/connection"
import {
  classifyOpenSshFailure,
  sanitizeOpenSshDiagnostic,
  type OpenSshOperation
} from "../domain/openSshFailure"
import type { ProcessResult } from "../domain/processResult"
import type {
  ProcessRunner,
  RunProcessRequest
} from "../infrastructure/process/ProcessRunner"

test("classifies OpenSSH failures using structure before locale-dependent text", () => {
  assert.equal(classifyOpenSshFailure("connect", createResult({
    status: "cancelled"
  }))?.code, "cancelled")
  assert.equal(classifyOpenSshFailure("connect", createResult({
    timedOut: true
  }))?.code, "connection_timeout")
  assert.equal(classifyOpenSshFailure("connect", createResult({
    stderr: Buffer.from("ssh: Could not resolve hostname example.test: Name or service not known")
  }))?.code, "dns_failed")
  assert.equal(classifyOpenSshFailure("connect", createResult({
    stderr: Buffer.from("Keine Verbindung zum Zielhost möglich")
  }))?.code, "unknown_openssh_error")
})

test("uses stable operation fallbacks without replacing the remote exit code", () => {
  const cases: ReadonlyArray<{
    readonly operation: OpenSshOperation
    readonly code: string
  }> = [
    { operation: "execute", code: "remote_command_failed" },
    { operation: "upload", code: "transfer_failed" },
    { operation: "download", code: "transfer_failed" },
    { operation: "file-batch", code: "transfer_failed" }
  ]

  for (const item of cases) {
    const error = classifyOpenSshFailure(item.operation, createResult())

    assert.equal(error?.code, item.code)
    assert.equal((error?.context as { exitCode?: number }).exitCode, 17)
  }
})

test("sanitizes terminal control characters while retaining source diagnostics", () => {
  assert.equal(
    sanitizeOpenSshDiagnostic("\u001b[31mPermission denied\u001b[0m\u0000"),
    "Permission denied"
  )
})

test("application emits structured events and enriches failed results", async () => {
  const runner = new EventProcessRunner(createResult({
    stderr: Buffer.from("Permission denied (publickey,password).")
  }))
  const events: SessionEvent[] = []
  const result = await new OpenSshSessionService(runner).execute({
    connection: createConnection(),
    command: "false",
    output: {
      mode: "stream"
    },
    onEvent: (event) => events.push(event)
  })

  assert.equal(result.exitCode, 17)
  assert.equal(result.error?.code, "authentication_failed")
  assert.deepEqual(
    events.filter((event) => event.type === "state").map((event) => event.state),
    ["starting", "running", "failed"]
  )
  assert.deepEqual(
    events.filter((event) => event.type === "output").map((event) => event.stream),
    ["stdout", "stderr"]
  )
  assert.equal(events.some((event) => event.type === "failure"), true)
})

class EventProcessRunner implements ProcessRunner {
  constructor(private readonly result: ProcessResult) {}

  run(request: RunProcessRequest): Promise<ProcessResult> {
    request.onSpawn?.()
    request.onStdout?.(Buffer.from("output"))
    request.onStderr?.(Buffer.from("diagnostic"))
    return Promise.resolve(this.result)
  }
}

function createConnection(): ConnectionRequest {
  return {
    target: { host: "example.test" },
    auth: { kind: "ssh-config" },
    hostKeyPolicy: "strict"
  }
}

function createResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    status: "failed",
    exitCode: 17,
    signal: null,
    durationMs: 1,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides
  }
}
