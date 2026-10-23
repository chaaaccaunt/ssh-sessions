const REDACTED_VALUE = "[REDACTED]"
const CIRCULAR_VALUE = "[CIRCULAR]"
const MAX_DEPTH_VALUE = "[MAX_DEPTH]"
const ACCESSOR_VALUE = "[ACCESSOR]"
const FUNCTION_VALUE = "[FUNCTION]"
const BINARY_VALUE = "[BINARY]"
const MAX_DEPTH = 8
const SENSITIVE_FIELD_PATTERN = /(password|passphrase|secret|token)/iu
const PROTOTYPE_FIELDS = new Set(["__proto__", "prototype", "constructor"])

export function redactDiagnosticValue(
  input: unknown,
  secrets: ReadonlyArray<string | Uint8Array> = []
): unknown {
  const secretStrings = secrets
    .map(toSecretString)
    .filter((secret) => secret.length > 0)

  return redactValue(input, secretStrings, new WeakSet<object>(), 0)
}

function redactValue(
  input: unknown,
  secrets: ReadonlyArray<string>,
  visited: WeakSet<object>,
  depth: number
): unknown {
  if (typeof input === "string") {
    return redactString(input, secrets)
  }

  if (
    input === null
    || typeof input === "number"
    || typeof input === "boolean"
    || typeof input === "undefined"
  ) {
    return input
  }

  if (typeof input === "bigint" || typeof input === "symbol") {
    return String(input)
  }

  if (typeof input === "function") {
    return FUNCTION_VALUE
  }

  if (input instanceof Uint8Array) {
    return BINARY_VALUE
  }

  if (depth >= MAX_DEPTH) {
    return MAX_DEPTH_VALUE
  }

  if (visited.has(input)) {
    return CIRCULAR_VALUE
  }

  visited.add(input)

  if (Array.isArray(input)) {
    return input.map((item) => redactValue(item, secrets, visited, depth + 1))
  }

  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const descriptors = Object.getOwnPropertyDescriptors(input)

  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (PROTOTYPE_FIELDS.has(key) || SENSITIVE_FIELD_PATTERN.test(key)) {
      output[key] = REDACTED_VALUE
      continue
    }

    if (!("value" in descriptor)) {
      output[key] = ACCESSOR_VALUE
      continue
    }

    output[key] = redactValue(descriptor.value, secrets, visited, depth + 1)
  }

  return output
}

function redactString(input: string, secrets: ReadonlyArray<string>): string {
  return secrets.reduce(
    (result, secret) => result.replaceAll(secret, REDACTED_VALUE),
    input
  )
}

function toSecretString(secret: string | Uint8Array): string {
  if (typeof secret === "string") {
    return secret
  }

  return Buffer.from(secret).toString("utf8")
}
