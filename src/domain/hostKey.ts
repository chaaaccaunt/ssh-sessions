import { SshError } from "./sshError"

export type HostKeyFailureKind = "unknown" | "changed"

const CHANGED_KEY_PATTERN = /remote host identification has changed|offending .* key in/iu
const UNKNOWN_KEY_PATTERN = /authenticity of host .* can't be established|no .* host key is known for|host key verification failed/iu

export function classifyHostKeyFailure(input: string): HostKeyFailureKind | undefined {
  if (CHANGED_KEY_PATTERN.test(input)) {
    return "changed"
  }

  if (UNKNOWN_KEY_PATTERN.test(input)) {
    return "unknown"
  }

  return undefined
}

export function toHostKeyError(input: string): SshError | undefined {
  const kind = classifyHostKeyFailure(input)

  if (kind === undefined) {
    return undefined
  }

  return new SshError({
    code: kind === "changed" ? "host_key_changed" : "host_key_unknown",
    operation: "verify-host-key",
    message: kind === "changed"
      ? "The remote host key has changed"
      : "The remote host key is not trusted",
    context: { diagnostic: input }
  })
}
