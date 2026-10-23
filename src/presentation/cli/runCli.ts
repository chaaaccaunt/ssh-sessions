import type {
  ConnectOptions,
  DownloadRequest,
  ExecuteRequest,
  UploadRequest
} from "../../application/SshSessionApplication"
import type { DoctorReport } from "../../application/doctor/DoctorService"
import type {
  AuthStrategy,
  ConnectionRequest,
  HostKeyPolicy,
  SecretProvider
} from "../../domain/connection"
import type { ProcessResult } from "../../domain/processResult"
import type { HostKeyConfirmationRequest } from "../../infrastructure/askpass/AskpassBroker"

type WriteOutput = (message: string | Uint8Array) => void

export interface CliDependencies {
  readonly runDoctor: () => Promise<DoctorReport>
  readonly connect: (
    connection: ConnectionRequest,
    options: ConnectOptions
  ) => Promise<ProcessResult>
  readonly execute: (request: ExecuteRequest) => Promise<ProcessResult>
  readonly upload: (request: UploadRequest) => Promise<ProcessResult>
  readonly download: (request: DownloadRequest) => Promise<ProcessResult>
  readonly files: (
    connection: ConnectionRequest,
    options: ConnectOptions
  ) => Promise<ProcessResult>
  readonly readSecret: (prompt: string) => Promise<Uint8Array>
  readonly confirmHostKey: (request: HostKeyConfirmationRequest) => Promise<boolean>
}

const HELP = `ssh-session

Usage:
  ssh-session --help
  ssh-session doctor
  ssh-session connect <target> [connection-options]
  ssh-session exec <target> [connection-options] [--tty] -- "<remote-command>"
  ssh-session upload <target> <local-path> <remote-path> [connection-options] [--recursive]
  ssh-session download <target> <remote-path> <local-path> [connection-options] [--recursive]
  ssh-session files <target> [connection-options]

Connection options:
  --user <name> --password
  --user <name> --key <key-name-or-path>
  --port <number>
  --config <path>
  --host-key-policy <ask|accept-new|strict>
  --connect-timeout <milliseconds>
  --timeout <milliseconds>
`

export function runCli(
  args: ReadonlyArray<string>,
  dependencies: CliDependencies,
  writeOutput: WriteOutput,
  writeError: WriteOutput
): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    writeOutput(HELP)
    return Promise.resolve(0)
  }

  if (args[0] === "doctor" && args.length === 1) {
    return dependencies.runDoctor()
      .then((report) => {
        writeOutput(formatDoctorReport(report))
        return report.healthy ? 0 : 1
      })
  }

  try {
    if (args[0] === "connect") {
      const parsed = parseConnectionCommand(args.slice(1), dependencies.readSecret, false)

      return dependencies.connect(parsed.connection, {
        confirmHostKey: dependencies.confirmHostKey
      }).then(toExitCode)
    }

    if (args[0] === "exec") {
      const parsed = parseConnectionCommand(args.slice(1), dependencies.readSecret, true)
      const request: ExecuteRequest = {
        connection: parsed.connection,
        command: parsed.command,
        tty: parsed.tty,
        stdin: { mode: "inherit" },
        output: {
          mode: "stream",
          onStdout: writeOutput,
          onStderr: writeError
        },
        confirmHostKey: dependencies.confirmHostKey
      }

      return dependencies.execute(request).then(toExitCode)
    }

    if (args[0] === "upload" || args[0] === "download") {
      const parsed = parseTransferCommand(
        args.slice(1),
        dependencies.readSecret,
        args[0]
      )
      const common = {
        connection: parsed.connection,
        recursive: parsed.recursive,
        confirmHostKey: dependencies.confirmHostKey
      }

      return args[0] === "upload"
        ? dependencies.upload({
            ...common,
            localPath: parsed.localPath,
            remotePath: parsed.remotePath
          }).then(toExitCode)
        : dependencies.download({
            ...common,
            remotePath: parsed.remotePath,
            localPath: parsed.localPath
          }).then(toExitCode)
    }

    if (args[0] === "files") {
      const parsed = parseConnectionCommand(args.slice(1), dependencies.readSecret, false)

      return dependencies.files(parsed.connection, {
        confirmHostKey: dependencies.confirmHostKey
      }).then(toExitCode)
    }
  } catch (error: unknown) {
    writeError(`${formatCliError(error)}\n`)
    return Promise.resolve(2)
  }

  writeError(`Unknown command: ${args[0]}\n`)
  return Promise.resolve(2)
}

interface ParsedTransferCommand {
  readonly connection: ConnectionRequest
  readonly localPath: string
  readonly remotePath: string
  readonly recursive: boolean
}

function parseTransferCommand(
  args: ReadonlyArray<string>,
  readSecret: (prompt: string) => Promise<Uint8Array>,
  direction: "upload" | "download"
): ParsedTransferCommand {
  const [target, firstPath, secondPath, ...options] = args

  if (
    target === undefined
    || firstPath === undefined
    || secondPath === undefined
    || firstPath.startsWith("-")
    || secondPath.startsWith("-")
  ) {
    throw new Error(`${direction} requires a target, source path, and destination path`)
  }

  const recursive = options.includes("--recursive")
  const connectionOptions = options.filter((option) => option !== "--recursive")
  const parsed = parseConnectionCommand(
    [target, ...connectionOptions],
    readSecret,
    false
  )

  return {
    connection: parsed.connection,
    localPath: direction === "upload" ? firstPath : secondPath,
    remotePath: direction === "upload" ? secondPath : firstPath,
    recursive
  }
}

interface ParsedCommand {
  readonly connection: ConnectionRequest
  readonly tty: boolean
  readonly command: string
}

function parseConnectionCommand(
  args: ReadonlyArray<string>,
  readSecret: (prompt: string) => Promise<Uint8Array>,
  expectCommand: boolean
): ParsedCommand {
  const separatorIndex = args.indexOf("--")
  const optionArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex)
  const commandArgs = separatorIndex === -1 ? [] : args.slice(separatorIndex + 1)

  if (expectCommand && commandArgs.length !== 1) {
    throw new Error("exec requires one quoted remote command after --")
  }

  if (!expectCommand && separatorIndex !== -1) {
    throw new Error("connect does not accept a remote command")
  }

  const target = optionArgs[0]

  if (target === undefined || target.length === 0 || target.startsWith("-")) {
    throw new Error("a connection target is required")
  }

  let user: string | undefined
  let authKind: "ssh-config" | "password" | "key" = "ssh-config"
  let keyName: string | undefined
  let port: number | undefined
  let configFile: string | undefined
  let hostKeyPolicy: HostKeyPolicy = "ask"
  let connectTimeoutMs: number | undefined
  let overallTimeoutMs: number | undefined
  let tty = false

  for (let index = 1; index < optionArgs.length; index += 1) {
    const option = optionArgs[index]

    if (option === "--password") {
      authKind = requireUnsetAuth(authKind, "password")
      continue
    }

    if (option === "--tty" && expectCommand) {
      tty = true
      continue
    }

    const value = optionArgs[index + 1]

    if (value === undefined) {
      throw new Error(`missing value for ${option}`)
    }

    index += 1

    if (option === "--user") {
      user = value
    } else if (option === "--key") {
      authKind = requireUnsetAuth(authKind, "key")
      keyName = value
    } else if (option === "--port") {
      port = parsePositiveInteger(value, option)
    } else if (option === "--config") {
      configFile = value
    } else if (option === "--host-key-policy") {
      hostKeyPolicy = parseHostKeyPolicy(value)
    } else if (option === "--connect-timeout") {
      connectTimeoutMs = parsePositiveInteger(value, option)
    } else if (option === "--timeout") {
      overallTimeoutMs = parsePositiveInteger(value, option)
    } else {
      throw new Error(`unknown option: ${option}`)
    }
  }

  const auth = createAuth(authKind, user, keyName, readSecret)

  return {
    connection: {
      target: {
        host: target,
        ...(port === undefined ? {} : { port }),
        ...(configFile === undefined ? {} : { configFile })
      },
      auth,
      hostKeyPolicy,
      ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
      ...(overallTimeoutMs === undefined ? {} : { overallTimeoutMs })
    },
    tty,
    command: commandArgs[0] ?? ""
  }
}

function createAuth(
  kind: "ssh-config" | "password" | "key",
  user: string | undefined,
  keyName: string | undefined,
  readSecret: (prompt: string) => Promise<Uint8Array>
): AuthStrategy {
  if (kind === "ssh-config") {
    if (user !== undefined) {
      throw new Error("--user requires --password or --key")
    }

    return { kind }
  }

  if (user === undefined) {
    throw new Error(`${kind} authentication requires --user`)
  }

  if (kind === "password") {
    return {
      kind,
      user,
      getPassword: createSecretProvider(readSecret, "Password: ")
    }
  }

  if (keyName === undefined) {
    throw new Error("key authentication requires --key")
  }

  return {
    kind,
    user,
    keyName,
    getPassphrase: createSecretProvider(readSecret, "Key passphrase: ")
  }
}

function createSecretProvider(
  readSecret: (prompt: string) => Promise<Uint8Array>,
  prompt: string
): SecretProvider {
  return () => readSecret(prompt)
}

function requireUnsetAuth(
  current: "ssh-config" | "password" | "key",
  next: "password" | "key"
): "password" | "key" {
  if (current !== "ssh-config") {
    throw new Error("choose only one authentication method")
  }

  return next
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value)

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} requires a positive integer`)
  }

  return parsed
}

function parseHostKeyPolicy(value: string): HostKeyPolicy {
  if (value === "ask" || value === "accept-new" || value === "strict") {
    return value
  }

  throw new Error("--host-key-policy must be ask, accept-new, or strict")
}

function toExitCode(result: ProcessResult): number {
  if (result.exitCode !== null) {
    return result.exitCode
  }

  return result.status === "cancelled" ? 130 : 1
}

function formatCliError(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid command"
}

function formatDoctorReport(report: DoctorReport): string {
  const lines = report.tools.map((tool) => {
    const status = tool.available ? "ok" : "missing"
    return `${tool.name}: ${status}`
  })

  if (report.openSshVersion !== undefined) {
    lines.unshift(`OpenSSH: ${report.openSshVersion}`)
  }

  return `${lines.join("\n")}\n`
}
