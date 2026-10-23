import type { SftpBatchOperation } from "../../application/SshSessionApplication"
import { SshError } from "../../domain/sshError"

const INVALID_PATH_PATTERN = /[\u0000\r\n]/u

export function buildSftpBatch(
  operations: ReadonlyArray<SftpBatchOperation>
): string {
  if (operations.length === 0) {
    throw invalidBatch("at least one SFTP operation is required")
  }

  return `${operations.map(buildOperation).join("\n")}\n`
}

function buildOperation(operation: SftpBatchOperation): string {
  if (operation.kind === "put") {
    return joinCommand(
      operation.recursive === true ? ["put", "-R"] : ["put"],
      operation.localPath,
      operation.remotePath
    )
  }

  if (operation.kind === "get") {
    return joinCommand(
      operation.recursive === true ? ["get", "-R"] : ["get"],
      operation.remotePath,
      operation.localPath
    )
  }

  if (operation.kind === "rename") {
    return joinCommand(["rename"], operation.fromPath, operation.toPath)
  }

  return joinCommand(
    [operation.kind === "remove" ? "rm" : operation.kind],
    operation.path
  )
}

function joinCommand(
  command: ReadonlyArray<string>,
  firstPath: string,
  secondPath?: string
): string {
  const parts = [...command, quotePath(firstPath)]

  if (secondPath !== undefined) {
    parts.push(quotePath(secondPath))
  }

  return parts.join(" ")
}

function quotePath(input: unknown): string {
  if (
    typeof input !== "string"
    || input.length === 0
    || INVALID_PATH_PATTERN.test(input)
    || input.startsWith("-")
  ) {
    throw invalidBatch("SFTP paths must be non-empty and cannot contain line breaks or start with '-'")
  }

  return `"${input.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`
}

function invalidBatch(message: string): SshError {
  return new SshError({
    code: "invalid_input",
    operation: "build-sftp-batch",
    message
  })
}
