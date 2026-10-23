import { homedir } from "node:os"
import { isAbsolute, relative, resolve } from "node:path"

import type { AuthStrategy, ConnectionRequest } from "../../domain/connection"
import { validateConnectionRequest } from "../../domain/connectionValidation"
import { SshError } from "../../domain/sshError"

const INVALID_VALUE_PATTERN = /[\u0000\r\n]/u

export interface OpenSshBuildContext {
  readonly homeDirectory: string
}

export interface SshExecuteOptions {
  readonly command: string
  readonly tty?: boolean
}

export interface ScpTransferOptions {
  readonly localPath: string
  readonly remotePath: string
  readonly recursive?: boolean
}

export interface SftpArgumentsOptions {
  readonly batch?: boolean
}

export function buildSshConnectArguments(
  input: unknown,
  context: OpenSshBuildContext = defaultBuildContext()
): ReadonlyArray<string> {
  const request = validateConnectionRequest(input)
  const args = buildConnectionOptions(request, "ssh", context)

  args.push(formatSshDestination(request))

  return args
}

export function buildSshExecuteArguments(
  input: unknown,
  options: SshExecuteOptions,
  context: OpenSshBuildContext = defaultBuildContext()
): ReadonlyArray<string> {
  const request = validateConnectionRequest(input)
  const command = requireSafeValue(options.command, "command")
  const args = buildConnectionOptions(request, "ssh", context)

  args.push(options.tty === true ? "-tt" : "-T")
  args.push(formatSshDestination(request), command)

  return args
}

export function buildSshConfigQueryArguments(
  input: unknown,
  context: OpenSshBuildContext = defaultBuildContext()
): ReadonlyArray<string> {
  const request = validateConnectionRequest(input)
  const args = ["-G", ...buildConnectionOptions(request, "ssh", context)]

  args.push(formatSshDestination(request))

  return args
}

export function buildScpUploadArguments(
  input: unknown,
  options: ScpTransferOptions,
  context: OpenSshBuildContext = defaultBuildContext()
): ReadonlyArray<string> {
  const request = validateConnectionRequest(input)
  const localPath = requireSafeLocalPath(options.localPath)
  const remotePath = requireSafeRemotePath(options.remotePath)
  const args = buildConnectionOptions(request, "scp", context)

  if (options.recursive === true) {
    args.push("-r")
  }

  args.push("--", localPath, formatScpRemote(request, remotePath))

  return args
}

export function buildScpDownloadArguments(
  input: unknown,
  options: ScpTransferOptions,
  context: OpenSshBuildContext = defaultBuildContext()
): ReadonlyArray<string> {
  const request = validateConnectionRequest(input)
  const localPath = requireSafeLocalPath(options.localPath)
  const remotePath = requireSafeRemotePath(options.remotePath)
  const args = buildConnectionOptions(request, "scp", context)

  if (options.recursive === true) {
    args.push("-r")
  }

  args.push("--", formatScpRemote(request, remotePath), localPath)

  return args
}

export function buildSftpArguments(
  input: unknown,
  options: SftpArgumentsOptions = {},
  context: OpenSshBuildContext = defaultBuildContext()
): ReadonlyArray<string> {
  const request = validateConnectionRequest(input)
  const args = buildConnectionOptions(request, "sftp", context)

  if (options.batch === true) {
    args.push("-b", "-")
  }

  args.push(formatFileTransferDestination(request))

  return args
}

function buildConnectionOptions(
  request: ConnectionRequest,
  executable: "ssh" | "scp" | "sftp",
  context: OpenSshBuildContext
): string[] {
  const args: string[] = []

  if (request.target.configFile !== undefined) {
    args.push("-F", request.target.configFile)
  }

  if (request.target.port !== undefined) {
    args.push(executable === "ssh" ? "-p" : "-P", String(request.target.port))
  }

  args.push("-o", `StrictHostKeyChecking=${mapHostKeyPolicy(request.hostKeyPolicy)}`)

  if (request.connectTimeoutMs !== undefined) {
    args.push("-o", `ConnectTimeout=${Math.max(1, Math.ceil(request.connectTimeoutMs / 1000))}`)
  }

  appendAuthOptions(args, request.auth, context)

  return args
}

function appendAuthOptions(
  args: string[],
  auth: AuthStrategy,
  context: OpenSshBuildContext
): void {
  if (auth.kind === "password") {
    args.push("-o", "BatchMode=no")
    args.push("-o", "PubkeyAuthentication=no")
    args.push("-o", "PasswordAuthentication=yes")
    args.push("-o", "KbdInteractiveAuthentication=yes")
    args.push("-o", "PreferredAuthentications=keyboard-interactive,password")
    return
  }

  if (auth.kind === "key") {
    args.push("-o", "BatchMode=no")
    args.push("-i", resolveKeyPath(auth.keyName, context.homeDirectory))
    args.push("-o", "IdentitiesOnly=yes")
    args.push("-o", "PasswordAuthentication=no")
    args.push("-o", "KbdInteractiveAuthentication=no")
    args.push("-o", "PreferredAuthentications=publickey")
  }
}

function mapHostKeyPolicy(policy: ConnectionRequest["hostKeyPolicy"]): string {
  if (policy === "strict") {
    return "yes"
  }

  return policy
}

function formatSshDestination(request: ConnectionRequest): string {
  const user = request.auth.kind === "ssh-config" ? undefined : request.auth.user

  return user === undefined
    ? request.target.host
    : `${user}@${request.target.host}`
}

function formatScpRemote(request: ConnectionRequest, remotePath: string): string {
  return `${formatFileTransferDestination(request)}:${remotePath}`
}

function formatFileTransferDestination(request: ConnectionRequest): string {
  const host = formatFileTransferHost(request.target.host)
  const user = request.auth.kind === "ssh-config" ? undefined : request.auth.user

  return user === undefined ? host : `${user}@${host}`
}

function formatFileTransferHost(host: string): string {
  if (host.includes(":") && !(host.startsWith("[") && host.endsWith("]"))) {
    return `[${host}]`
  }

  return host
}

function resolveKeyPath(keyName: string, homeDirectory: string): string {
  if (keyName === "~") {
    throw invalidArguments("auth.keyName must identify a key file")
  }

  if (keyName.startsWith("~/") || keyName.startsWith("~\\")) {
    return resolve(homeDirectory, keyName.slice(2))
  }

  if (isAbsolute(keyName)) {
    return keyName
  }

  const sshDirectory = resolve(homeDirectory, ".ssh")
  const keyPath = resolve(sshDirectory, keyName)
  const relativePath = relative(sshDirectory, keyPath)

  if (
    relativePath === ".."
    || relativePath.startsWith(`..\\`)
    || relativePath.startsWith("../")
    || isAbsolute(relativePath)
  ) {
    throw invalidArguments("auth.keyName cannot escape the SSH directory")
  }

  return keyPath
}

function requireSafeValue(input: unknown, fieldName: string): string {
  if (
    typeof input !== "string"
    || input.length === 0
    || INVALID_VALUE_PATTERN.test(input)
  ) {
    throw invalidArguments(`${fieldName} contains an invalid value`)
  }

  return input
}

function requireSafeLocalPath(input: unknown): string {
  const path = requireSafePath(input, "localPath")
  const colonIndex = path.indexOf(":")
  const separatorIndexes = [path.indexOf("/"), path.indexOf("\\")]
    .filter((index) => index !== -1)
  const firstSeparator = separatorIndexes.length === 0
    ? -1
    : Math.min(...separatorIndexes)

  if (!isAbsolute(path) && colonIndex !== -1 && (firstSeparator === -1 || colonIndex < firstSeparator)) {
    throw invalidArguments("localPath with an ambiguous colon must be absolute or start with a directory component")
  }

  return path
}

function requireSafeRemotePath(input: unknown): string {
  return requireSafePath(input, "remotePath")
}

function requireSafePath(input: unknown, fieldName: string): string {
  const path = requireSafeValue(input, fieldName)

  if (path.startsWith("-")) {
    throw invalidArguments(`${fieldName} cannot start with '-'`)
  }

  return path
}

function defaultBuildContext(): OpenSshBuildContext {
  return { homeDirectory: homedir() }
}

function invalidArguments(message: string): SshError {
  return new SshError({
    code: "invalid_input",
    operation: "build-openssh-arguments",
    message
  })
}
