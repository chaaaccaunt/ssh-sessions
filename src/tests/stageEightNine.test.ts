import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { OpenSshSessionService } from "../application/OpenSshSessionService"
import type { CliDependencies } from "../presentation/cli/runCli"
import { runCli } from "../presentation/cli/runCli"
import type { ConnectionRequest } from "../domain/connection"
import type { ProcessResult } from "../domain/processResult"
import { SshError } from "../domain/sshError"
import {
  buildScpDownloadArguments,
  buildScpUploadArguments
} from "../infrastructure/openssh/OpenSshArguments"
import { buildSftpBatch } from "../infrastructure/openssh/SftpBatch"
import type {
  ProcessRunner,
  RunProcessRequest
} from "../infrastructure/process/ProcessRunner"

test("scp uses its port flag and rejects ambiguous remote paths", () => {
  const connection = createConnection(2222)

  assert.deepEqual(
    buildScpUploadArguments(connection, {
      localPath: "archive.zip",
      remotePath: "/tmp/archive.zip"
    }),
    [
      "-P", "2222",
      "-o", "StrictHostKeyChecking=yes",
      "--", "archive.zip", "production:/tmp/archive.zip"
    ]
  )
  assert.throws(
    () => buildScpDownloadArguments(connection, {
      localPath: "archive.zip",
      remotePath: "-dangerous"
    }),
    isInvalidInput
  )
  assert.throws(
    () => buildScpUploadArguments(connection, {
      localPath: "ambiguous:file.txt",
      remotePath: "/tmp/file.txt"
    }),
    isInvalidInput
  )
})

test("upload validates its local source and marks failed transfers as partial", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ssh-session-transfer-"))
  const filePath = join(directory, "file.txt")
  const childDirectory = join(directory, "folder")

  try {
    await writeFile(filePath, "data")
    await mkdir(childDirectory)

    const runner = new RecordingProcessRunner(createResult({
      status: "failed",
      exitCode: 1
    }))
    const service = new OpenSshSessionService(runner)
    const result = await service.upload({
      connection: createConnection(),
      localPath: filePath,
      remotePath: "/tmp/file.txt"
    })

    assert.equal(result.potentiallyPartial, true)
    assert.equal(runner.requests[0]?.executable, "scp")
    assert.equal(runner.requests[0]?.stdio, "inherit")

    await assert.rejects(
      service.upload({
        connection: createConnection(),
        localPath: childDirectory,
        remotePath: "/tmp/folder"
      }),
      isInvalidInput
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("interactive files inherits the terminal", async () => {
  const runner = new RecordingProcessRunner(createResult())

  await new OpenSshSessionService(runner).files(createConnection())

  assert.equal(runner.requests[0]?.executable, "sftp")
  assert.equal(runner.requests[0]?.stdio, "inherit")
})

test("SFTP batch quotes paths and cannot be extended through a line break", () => {
  assert.equal(
    buildSftpBatch([
      {
        kind: "put",
        localPath: "local file.txt",
        remotePath: "remote/\"quoted\".txt"
      },
      { kind: "rename", fromPath: "old name", toPath: "new name" },
      { kind: "remove", path: "obsolete.txt" }
    ]),
    [
      "put \"local file.txt\" \"remote/\\\"quoted\\\".txt\"",
      "rename \"old name\" \"new name\"",
      "rm \"obsolete.txt\"",
      ""
    ].join("\n")
  )
  assert.throws(
    () => buildSftpBatch([{ kind: "remove", path: "safe\nrm another" }]),
    isInvalidInput
  )
})

test("SFTP batch uses stdin separately from password ASKPASS", async () => {
  const secret = "batch-secret"
  const runner = new RecordingProcessRunner(createResult())
  const service = new OpenSshSessionService(runner)

  const result = await service.executeFileBatch({
    connection: {
      target: { host: "example.test" },
      auth: {
        kind: "password",
        user: "operator",
        getPassword: () => Promise.resolve(Buffer.from(secret))
      },
      hostKeyPolicy: "strict"
    },
    operations: [{ kind: "mkdir", path: "release files" }]
  })

  const request = runner.requests[0]
  assert.equal(result.potentiallyPartial, false)
  assert.equal(request?.executable, "sftp")
  assert.equal(request?.stdin, "mkdir \"release files\"\n")
  assert.equal(request?.args.includes("-b"), true)
  assert.equal(request?.args.join(" ").includes(secret), false)
  assert.equal(JSON.stringify(request?.environment).includes(secret), false)
  assert.equal(typeof request?.environment?.SSH_ASKPASS, "string")
})

test("CLI routes upload, download, and files with transfer options", async () => {
  const calls: Array<{ readonly name: string, readonly value: unknown }> = []
  const dependencies = createCliDependencies(calls)

  assert.equal(await runCli(
    ["upload", "production", "local.txt", "/tmp/remote.txt", "--recursive"],
    dependencies,
    () => undefined,
    () => undefined
  ), 0)
  assert.equal(await runCli(
    ["download", "production", "/tmp/remote.txt", "local.txt"],
    dependencies,
    () => undefined,
    () => undefined
  ), 0)
  assert.equal(await runCli(
    ["files", "production"],
    dependencies,
    () => undefined,
    () => undefined
  ), 0)

  assert.deepEqual(calls.map((call) => call.name), ["upload", "download", "files"])
  assert.equal((calls[0]?.value as { recursive?: boolean }).recursive, true)
})

class RecordingProcessRunner implements ProcessRunner {
  readonly requests: RunProcessRequest[] = []

  constructor(private readonly result: ProcessResult) {}

  run(request: RunProcessRequest): Promise<ProcessResult> {
    this.requests.push(request)
    return Promise.resolve(this.result)
  }
}

function createConnection(port?: number): ConnectionRequest {
  return {
    target: { host: "production", ...(port === undefined ? {} : { port }) },
    auth: { kind: "ssh-config" },
    hostKeyPolicy: "strict"
  }
}

function createResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
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

function isInvalidInput(error: unknown): boolean {
  return error instanceof SshError && error.code === "invalid_input"
}

function createCliDependencies(
  calls: Array<{ readonly name: string, readonly value: unknown }>
): CliDependencies {
  const complete = () => Promise.resolve(createResult())

  return {
    runDoctor: () => Promise.resolve({
      healthy: true,
      tools: [],
      platform: process.platform,
      architecture: process.arch
    }),
    connect: complete,
    execute: complete,
    upload: (request) => {
      calls.push({ name: "upload", value: request })
      return complete()
    },
    download: (request) => {
      calls.push({ name: "download", value: request })
      return complete()
    },
    files: (connection) => {
      calls.push({ name: "files", value: connection })
      return complete()
    },
    readSecret: () => Promise.resolve(Buffer.from("secret")),
    confirmHostKey: () => Promise.resolve(true)
  }
}
