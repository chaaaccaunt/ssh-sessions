import assert from "node:assert/strict"
import { resolve } from "node:path"
import { test } from "node:test"

import { DoctorService } from "../application/doctor/DoctorService"
import {
  OpenSshTargetResolver,
  parseSshConfigOutput
} from "../application/targets/OpenSshTargetResolver"
import type { ConnectionRequest } from "../domain/connection"
import type { ProcessResult } from "../domain/processResult"
import { SshError } from "../domain/sshError"
import {
  buildScpDownloadArguments,
  buildScpUploadArguments,
  buildSftpArguments,
  buildSshConfigQueryArguments,
  buildSshConnectArguments,
  buildSshExecuteArguments
} from "../infrastructure/openssh/OpenSshArguments"
import { NodeProcessRunner } from "../infrastructure/process/NodeProcessRunner"
import type {
  ProcessRunner,
  RunProcessRequest
} from "../infrastructure/process/ProcessRunner"

const TEST_HOME = resolve("test-home")

test("process runner captures output and preserves a non-zero exit code", async () => {
  const runner = new NodeProcessRunner()
  const result = await runner.run({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('out');process.stderr.write('err');process.exit(7)"],
    stdio: "capture"
  })

  assert.equal(result.status, "failed")
  assert.equal(result.exitCode, 7)
  assert.equal(Buffer.from(result.stdout ?? []).toString("utf8"), "out")
  assert.equal(Buffer.from(result.stderr ?? []).toString("utf8"), "err")
})

test("process runner distinguishes a missing executable", async () => {
  const runner = new NodeProcessRunner()

  await assert.rejects(
    runner.run({
      executable: "ssh-session-definitely-missing-executable",
      args: [],
      stdio: "capture"
    }),
    (error: unknown) => error instanceof SshError && error.code === "executable_not_found"
  )
})

test("process runner rejects line breaks before spawning", () => {
  const runner = new NodeProcessRunner()

  assert.throws(
    () => runner.run({
      executable: process.execPath,
      args: ["invalid\nargument"],
      stdio: "capture"
    }),
    (error: unknown) => error instanceof SshError && error.code === "invalid_input"
  )
})

test("process runner terminates a timed out process", async () => {
  const runner = new NodeProcessRunner()
  const result = await runner.run({
    executable: process.execPath,
    args: ["-e", "setInterval(() => undefined, 1000)"],
    stdio: "capture",
    timeoutMs: 50
  })

  assert.equal(result.status, "failed")
  assert.equal(result.timedOut, true)
})

test("process runner supports cancellation and bounded capture", async () => {
  const runner = new NodeProcessRunner()
  const abortController = new AbortController()
  const runningProcess = runner.run({
    executable: process.execPath,
    args: ["-e", "setInterval(() => undefined, 1000)"],
    stdio: "capture",
    signal: abortController.signal
  })

  abortController.abort()

  const cancelledResult = await runningProcess
  const capturedResult = await runner.run({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('1234567890')"],
    stdio: "capture",
    maxCaptureBytes: 4
  })

  assert.equal(cancelledResult.status, "cancelled")
  assert.equal(capturedResult.stdoutTruncated, true)
  assert.equal(Buffer.from(capturedResult.stdout ?? []).toString("utf8"), "1234")
})

test("doctor treats an executed probe as available regardless of its exit code", async () => {
  const runner = new RecordingProcessRunner(createProcessResult({ exitCode: 1 }))
  const report = await new DoctorService(runner).run()

  assert.equal(report.healthy, true)
  assert.equal(report.tools.length, 4)
  assert.deepEqual(
    runner.requests.map((request) => request.executable),
    ["ssh", "scp", "sftp", "ssh-keygen"]
  )
})

test("doctor reports a timed out probe as unhealthy", async () => {
  const runner = new RecordingProcessRunner(createProcessResult({ timedOut: true }))
  const report = await new DoctorService(runner).run()

  assert.equal(report.healthy, false)
  assert.equal(report.tools.every((tool) => !tool.available), true)
})

test("builds ssh arguments for config, password, and key authentication", () => {
  const configRequest = createConfigRequest()
  const passwordRequest = createPasswordRequest()
  const keyRequest = createKeyRequest()

  assert.deepEqual(
    buildSshConnectArguments(configRequest, { homeDirectory: TEST_HOME }),
    ["-o", "StrictHostKeyChecking=ask", "production"]
  )
  assert.deepEqual(
    buildSshConnectArguments(passwordRequest, { homeDirectory: TEST_HOME }),
    [
      "-p", "2222",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectTimeout=2",
      "-o", "BatchMode=no",
      "-o", "PubkeyAuthentication=no",
      "-o", "PasswordAuthentication=yes",
      "-o", "KbdInteractiveAuthentication=yes",
      "-o", "PreferredAuthentications=keyboard-interactive,password",
      "operator@example.test"
    ]
  )
  assert.deepEqual(
    buildSshConnectArguments(keyRequest, { homeDirectory: TEST_HOME }),
    [
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "BatchMode=no",
      "-i", resolve(TEST_HOME, ".ssh", "id_ed25519"),
      "-o", "IdentitiesOnly=yes",
      "-o", "PasswordAuthentication=no",
      "-o", "KbdInteractiveAuthentication=no",
      "-o", "PreferredAuthentications=publickey",
      "operator@example.test"
    ]
  )
})

test("builds command, scp, and sftp arguments without invoking a shell", () => {
  const request = createConfigRequest()

  assert.deepEqual(
    buildSshExecuteArguments(request, { command: "uname -a" }, { homeDirectory: TEST_HOME }),
    ["-o", "StrictHostKeyChecking=ask", "-T", "production", "uname -a"]
  )
  assert.deepEqual(
    buildScpUploadArguments(
      request,
      { localPath: "./archive.zip", remotePath: "/tmp/archive.zip" },
      { homeDirectory: TEST_HOME }
    ),
    [
      "-o", "StrictHostKeyChecking=ask",
      "--", "./archive.zip", "production:/tmp/archive.zip"
    ]
  )
  assert.deepEqual(
    buildScpDownloadArguments(
      request,
      { localPath: "./archive.zip", remotePath: "/tmp/archive.zip", recursive: true },
      { homeDirectory: TEST_HOME }
    ),
    [
      "-o", "StrictHostKeyChecking=ask",
      "-r", "--", "production:/tmp/archive.zip", "./archive.zip"
    ]
  )
  assert.deepEqual(
    buildSftpArguments(request, { batch: true }, { homeDirectory: TEST_HOME }),
    ["-o", "StrictHostKeyChecking=ask", "-b", "-", "production"]
  )
})

test("formats IPv6 scp destinations and blocks key path traversal", () => {
  const ipv6Request: ConnectionRequest = {
    target: { host: "2001:db8::10" },
    auth: {
      kind: "key",
      user: "operator",
      keyName: "id_ed25519"
    },
    hostKeyPolicy: "strict"
  }
  const traversalRequest: ConnectionRequest = {
    target: { host: "2001:db8::10" },
    auth: {
      kind: "key",
      user: "operator",
      keyName: "../outside"
    },
    hostKeyPolicy: "strict"
  }

  assert.equal(
    buildScpUploadArguments(
      ipv6Request,
      { localPath: "file.txt", remotePath: "/tmp/file.txt" },
      { homeDirectory: TEST_HOME }
    ).at(-1),
    "operator@[2001:db8::10]:/tmp/file.txt"
  )
  assert.equal(
    buildSftpArguments(
      ipv6Request,
      {},
      { homeDirectory: TEST_HOME }
    ).at(-1),
    "operator@[2001:db8::10]"
  )
  assert.throws(
    () => buildSshConnectArguments(traversalRequest, { homeDirectory: TEST_HOME }),
    (error: unknown) => error instanceof SshError && error.code === "invalid_input"
  )
})

test("parses effective OpenSSH configuration", () => {
  const result = parseSshConfigOutput([
    "host production",
    "hostname 192.0.2.10",
    "user deploy",
    "port 2200",
    "proxyjump gateway",
    "identityfile ~/.ssh/id_ed25519",
    "identityfile ~/.ssh/id_rsa"
  ].join("\n"))

  assert.deepEqual(result, {
    hostName: "192.0.2.10",
    user: "deploy",
    port: 2200,
    proxyJump: "gateway",
    identityFiles: ["~/.ssh/id_ed25519", "~/.ssh/id_rsa"]
  })
})

test("target resolver executes ssh -G through the process runner", async () => {
  const runner = new RecordingProcessRunner(createProcessResult({
    stdout: Buffer.from("hostname example.test\nuser operator\nport 22\n")
  }))
  const resolver = new OpenSshTargetResolver(runner, { homeDirectory: TEST_HOME })
  const result = await resolver.resolve(createConfigRequest())

  assert.equal(result.hostName, "example.test")
  assert.deepEqual(
    runner.requests[0]?.args,
    buildSshConfigQueryArguments(createConfigRequest(), { homeDirectory: TEST_HOME })
  )
})

class RecordingProcessRunner implements ProcessRunner {
  readonly requests: RunProcessRequest[] = []

  constructor(private readonly result: ProcessResult) {}

  run(request: RunProcessRequest): Promise<ProcessResult> {
    this.requests.push(request)
    return Promise.resolve(this.result)
  }
}

function createProcessResult(
  overrides: Partial<ProcessResult> = {}
): ProcessResult {
  return {
    status: overrides.exitCode === undefined || overrides.exitCode === 0
      ? "completed"
      : "failed",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides
  }
}

function createConfigRequest(): ConnectionRequest {
  return {
    target: { host: "production" },
    auth: { kind: "ssh-config" },
    hostKeyPolicy: "ask"
  }
}

function createPasswordRequest(): ConnectionRequest {
  return {
    target: { host: "example.test", port: 2222 },
    auth: {
      kind: "password",
      user: "operator",
      getPassword: () => Promise.resolve(Buffer.from("secret"))
    },
    hostKeyPolicy: "strict",
    connectTimeoutMs: 1_001
  }
}

function createKeyRequest(): ConnectionRequest {
  return {
    target: { host: "example.test" },
    auth: { kind: "key", user: "operator", keyName: "id_ed25519" },
    hostKeyPolicy: "accept-new"
  }
}
