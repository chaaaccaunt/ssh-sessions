import assert from "node:assert/strict"
import { access } from "node:fs/promises"
import { test } from "node:test"

import {
  buildKnownHostRemovalCommand,
  HostKeyTrustService
} from "../application/hostKeys/HostKeyTrustService"
import type { ResolvedSshTarget } from "../application/targets/OpenSshTargetResolver"
import type { ConnectionRequest } from "../domain/connection"
import { classifyHostKeyFailure } from "../domain/hostKey"
import type { ProcessResult } from "../domain/processResult"
import { SshError } from "../domain/sshError"
import {
  classifyAskpassPrompt,
  OpenSshAskpassBroker
} from "../infrastructure/askpass/AskpassBroker"
import { NodeProcessRunner } from "../infrastructure/process/NodeProcessRunner"
import type {
  ProcessRunner,
  RunProcessRequest
} from "../infrastructure/process/ProcessRunner"

test("classifies host key failures without treating changed keys as unknown", () => {
  assert.equal(
    classifyHostKeyFailure("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!"),
    "changed"
  )
  assert.equal(
    classifyHostKeyFailure("No ED25519 host key is known for example.test and you have requested strict checking."),
    "unknown"
  )
  assert.equal(classifyHostKeyFailure("Permission denied"), undefined)
})

test("finds known_hosts entries using the effective host and non-standard port", async () => {
  const runner = new RecordingProcessRunner(createProcessResult({
    stdout: Buffer.from("# Host [server.example]:2222 found: line 3\n[server.example]:2222 ssh-ed25519 AAAA")
  }))
  const service = new HostKeyTrustService(runner, {
    resolve: () => Promise.resolve(createResolvedTarget())
  } as never)
  const result = await service.find(createRequest())

  assert.equal(result.query, "[server.example]:2222")
  assert.equal(result.entries.length, 2)
  assert.deepEqual(runner.requests[0]?.args, ["-F", "[server.example]:2222"])
})

test("changed key diagnostics are read-only and prepare a separate removal command", async () => {
  const runner = new RecordingProcessRunner(createProcessResult())
  const service = new HostKeyTrustService(runner, {
    resolve: () => Promise.resolve(createResolvedTarget())
  } as never)
  const diagnostic = await service.diagnose(
    createRequest(),
    "REMOTE HOST IDENTIFICATION HAS CHANGED"
  )

  assert.equal(diagnostic.kind, "changed")
  assert.deepEqual(
    diagnostic.removalCommand,
    buildKnownHostRemovalCommand("[server.example]:2222")
  )
  assert.equal(runner.requests.some((request) => request.args.includes("-R")), false)
})

test("classifies ASKPASS prompts before selecting a secret", () => {
  assert.equal(classifyAskpassPrompt("operator@example.test's password:"), "password")
  assert.equal(classifyAskpassPrompt("Enter passphrase for key '/tmp/id':"), "key-passphrase")
  assert.equal(
    classifyAskpassPrompt("The authenticity of host cannot be established. Fingerprint SHA256:x. Continue?"),
    "host-authenticity"
  )
  assert.equal(classifyAskpassPrompt("Verification code:"), "mfa")
  assert.equal(classifyAskpassPrompt("Unexpected question:"), "unknown")
})

test("ASKPASS sends a password over one-time IPC without putting it in argv or env", async () => {
  const secretText = "unit-test-password"
  const broker = new OpenSshAskpassBroker()
  const session = await broker.open({
    auth: {
      kind: "password",
      user: "operator",
      getPassword: () => Promise.resolve(Buffer.from(secretText))
    },
    hostKeyPolicy: "strict"
  })
  const runner = new NodeProcessRunner()
  const helperPath = session.environment.SSH_ASKPASS!

  try {
    const serializedEnvironment = JSON.stringify(session.environment)
    assert.equal(serializedEnvironment.includes(secretText), false)

    const result = await runner.run({
      ...createAskpassInvocation(helperPath, "operator@example.test's password:"),
      environment: session.environment,
      stdio: "capture",
      timeoutMs: 5_000
    })

    assert.equal(result.status, "completed")
    assert.equal(Buffer.from(result.stdout ?? []).toString("utf8").trim(), secretText)
    assert.equal(JSON.stringify(runner).includes(secretText), false)
  } finally {
    const endpoint = session.environment.SSH_SESSION_ASKPASS_ENDPOINT!
    await session.close()

    if (process.platform !== "win32") {
      await assert.rejects(access(endpoint))
    } else {
      await assert.rejects(access(helperPath))
    }
  }
})

test("ASKPASS never supplies a password to fingerprint or MFA prompts", async () => {
  let secretWasRead = false
  const broker = new OpenSshAskpassBroker()
  const session = await broker.open({
    auth: {
      kind: "password",
      user: "operator",
      getPassword: () => {
        secretWasRead = true
        return Promise.resolve(Buffer.from("must-not-be-read"))
      }
    },
    hostKeyPolicy: "strict"
  })
  const runner = new NodeProcessRunner()

  try {
    const result = await runner.run({
      ...createAskpassInvocation(session.environment.SSH_ASKPASS!, "Verification code:"),
      environment: session.environment,
      stdio: "capture",
      timeoutMs: 5_000
    })

    assert.equal(result.status, "failed")
    assert.equal(secretWasRead, false)
    assert.equal(session.getFailure() instanceof SshError, true)
    assert.equal(session.getFailure()?.code, "mfa_required")
  } finally {
    await session.close()
  }
})

function createAskpassInvocation(
  helperPath: string,
  prompt: string
): Pick<RunProcessRequest, "executable" | "args"> {
  if (process.platform === "win32") {
    return { executable: helperPath, args: [prompt] }
  }

  return { executable: process.execPath, args: [helperPath, prompt] }
}

class RecordingProcessRunner implements ProcessRunner {
  readonly requests: RunProcessRequest[] = []

  constructor(private readonly result: ProcessResult) {}

  run(request: RunProcessRequest): Promise<ProcessResult> {
    this.requests.push(request)
    return Promise.resolve(this.result)
  }
}

function createRequest(): ConnectionRequest {
  return {
    target: { host: "alias" },
    auth: { kind: "ssh-config" },
    hostKeyPolicy: "strict"
  }
}

function createResolvedTarget(): ResolvedSshTarget {
  return {
    hostName: "server.example",
    user: "operator",
    port: 2222,
    identityFiles: []
  }
}

function createProcessResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
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
