import {
  HOST_KEY_POLICIES,
  type AuthStrategy,
  type ConnectionRequest,
  type ConnectionTarget,
  type HostKeyPolicy,
  type KeyAuthStrategy,
  type PasswordAuthStrategy,
  type SecretProvider
} from "./connection"
import { SshError } from "./sshError"

const ROOT_FIELDS = new Set([
  "target",
  "auth",
  "hostKeyPolicy",
  "connectTimeoutMs",
  "overallTimeoutMs"
])
const TARGET_FIELDS = new Set(["host", "port", "configFile"])
const AUTH_FIELDS = Object.freeze({
  "ssh-config": new Set(["kind"]),
  password: new Set(["kind", "user", "getPassword"]),
  key: new Set(["kind", "user", "keyName", "getPassphrase"])
})

export function validateConnectionRequest(input: unknown): ConnectionRequest {
  const request = requirePlainRecord(input, "connection request")

  rejectUnknownFields(request, ROOT_FIELDS, "connection request")

  const target = validateTarget(request.target)
  const auth = validateAuth(request.auth)
  const hostKeyPolicy = validateHostKeyPolicy(request.hostKeyPolicy)
  const connectTimeoutMs = validateOptionalPositiveInteger(
    request.connectTimeoutMs,
    "connectTimeoutMs"
  )
  const overallTimeoutMs = validateOptionalPositiveInteger(
    request.overallTimeoutMs,
    "overallTimeoutMs"
  )

  if (
    connectTimeoutMs !== undefined
    && overallTimeoutMs !== undefined
    && overallTimeoutMs < connectTimeoutMs
  ) {
    throw invalidInput("overallTimeoutMs cannot be less than connectTimeoutMs")
  }

  return {
    target,
    auth,
    hostKeyPolicy,
    ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
    ...(overallTimeoutMs === undefined ? {} : { overallTimeoutMs })
  }
}

function validateTarget(input: unknown): ConnectionTarget {
  const target = requirePlainRecord(input, "target")

  rejectUnknownFields(target, TARGET_FIELDS, "target")

  const host = requireSafeIdentifier(target.host, "target.host")
  const port = validateOptionalPort(target.port)
  const configFile = validateOptionalPath(target.configFile, "target.configFile")

  return {
    host,
    ...(port === undefined ? {} : { port }),
    ...(configFile === undefined ? {} : { configFile })
  }
}

function validateAuth(input: unknown): AuthStrategy {
  const auth = requirePlainRecord(input, "auth")
  const kind = auth.kind

  if (kind === "ssh-config") {
    rejectUnknownFields(auth, AUTH_FIELDS[kind], "auth")

    return { kind }
  }

  if (kind === "password") {
    rejectUnknownFields(auth, AUTH_FIELDS[kind], "auth")

    const result: PasswordAuthStrategy = {
      kind,
      user: requireSafeIdentifier(auth.user, "auth.user"),
      getPassword: requireSecretProvider(auth.getPassword, "auth.getPassword")
    }

    return result
  }

  if (kind === "key") {
    rejectUnknownFields(auth, AUTH_FIELDS[kind], "auth")

    const getPassphrase = validateOptionalSecretProvider(
      auth.getPassphrase,
      "auth.getPassphrase"
    )
    const result: KeyAuthStrategy = {
      kind,
      user: requireSafeIdentifier(auth.user, "auth.user"),
      keyName: requireSafePath(auth.keyName, "auth.keyName"),
      ...(getPassphrase === undefined ? {} : { getPassphrase })
    }

    return result
  }

  throw invalidInput("auth.kind must be ssh-config, password, or key")
}

function validateHostKeyPolicy(input: unknown): HostKeyPolicy {
  if (input === undefined) {
    return "ask"
  }

  if (
    typeof input === "string"
    && (HOST_KEY_POLICIES as ReadonlyArray<string>).includes(input)
  ) {
    return input as HostKeyPolicy
  }

  throw invalidInput("hostKeyPolicy must be ask, accept-new, or strict")
}

function validateOptionalPort(input: unknown): number | undefined {
  if (input === undefined) {
    return undefined
  }

  if (!Number.isInteger(input) || typeof input !== "number" || input < 1 || input > 65535) {
    throw invalidInput("target.port must be an integer between 1 and 65535")
  }

  return input
}

function validateOptionalPositiveInteger(
  input: unknown,
  fieldName: string
): number | undefined {
  if (input === undefined) {
    return undefined
  }

  if (!Number.isInteger(input) || typeof input !== "number" || input <= 0) {
    throw invalidInput(`${fieldName} must be a positive integer`)
  }

  return input
}

function requireSafeIdentifier(input: unknown, fieldName: string): string {
  if (
    typeof input !== "string"
    || input.length === 0
    || input.startsWith("-")
    || /[\s\u0000-\u001f\u007f]/u.test(input)
  ) {
    throw invalidInput(`${fieldName} contains an invalid identifier`)
  }

  return input
}

function validateOptionalPath(input: unknown, fieldName: string): string | undefined {
  if (input === undefined) {
    return undefined
  }

  return requireSafePath(input, fieldName)
}

function requireSafePath(input: unknown, fieldName: string): string {
  if (
    typeof input !== "string"
    || input.length === 0
    || /[\u0000\r\n]/u.test(input)
  ) {
    throw invalidInput(`${fieldName} contains an invalid path`)
  }

  return input
}

function requireSecretProvider(input: unknown, fieldName: string): SecretProvider {
  if (typeof input !== "function") {
    throw invalidInput(`${fieldName} must be a secret provider`)
  }

  return input as SecretProvider
}

function validateOptionalSecretProvider(
  input: unknown,
  fieldName: string
): SecretProvider | undefined {
  if (input === undefined) {
    return undefined
  }

  return requireSecretProvider(input, fieldName)
}

function requirePlainRecord(input: unknown, fieldName: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidInput(`${fieldName} must be an object`)
  }

  const prototype = Object.getPrototypeOf(input)

  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidInput(`${fieldName} must be a plain object`)
  }

  return input as Record<string, unknown>
}

function rejectUnknownFields(
  input: Readonly<Record<string, unknown>>,
  allowedFields: ReadonlySet<string>,
  fieldName: string
): void {
  const unknownField = Object.keys(input).find((key) => !allowedFields.has(key))

  if (unknownField !== undefined) {
    throw invalidInput(`${fieldName} contains unknown field: ${unknownField}`)
  }
}

function invalidInput(message: string): SshError {
  return new SshError({
    code: "invalid_input",
    operation: "validate-connection-request",
    message
  })
}
