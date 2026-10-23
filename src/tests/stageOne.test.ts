import assert from "node:assert/strict"
import { test } from "node:test"

import { validateConnectionRequest } from "../domain/connectionValidation"
import { SshError } from "../domain/sshError"
import { redactDiagnosticValue } from "../security/redaction"

test("validates an ssh config host and applies safe defaults", () => {
  const request = validateConnectionRequest({
    target: { host: "production" },
    auth: { kind: "ssh-config" }
  })

  assert.equal(request.target.host, "production")
  assert.equal(request.auth.kind, "ssh-config")
  assert.equal(request.hostKeyPolicy, "ask")
})

test("validates password and key authentication without reading secrets", () => {
  let passwordWasRead = false
  const getPassword = () => {
    passwordWasRead = true
    return Promise.resolve(Buffer.from("password"))
  }
  const passwordRequest = validateConnectionRequest({
    target: { host: "example.test", port: 2222 },
    auth: { kind: "password", user: "operator", getPassword },
    hostKeyPolicy: "strict"
  })
  const keyRequest = validateConnectionRequest({
    target: { host: "example.test" },
    auth: { kind: "key", user: "operator", keyName: "id_ed25519" }
  })

  assert.equal(passwordRequest.auth.kind, "password")
  assert.equal(keyRequest.auth.kind, "key")
  assert.equal(passwordWasRead, false)
})

test("rejects option injection, invalid ports, and unknown fields", () => {
  assert.throws(
    () => validateConnectionRequest({
      target: { host: "-oProxyCommand=malicious" },
      auth: { kind: "ssh-config" }
    }),
    isInvalidInput
  )
  assert.throws(
    () => validateConnectionRequest({
      target: { host: "example.test", port: 70000 },
      auth: { kind: "ssh-config" }
    }),
    isInvalidInput
  )
  assert.throws(
    () => validateConnectionRequest({
      target: { host: "example.test" },
      auth: { kind: "ssh-config", password: "leak" }
    }),
    isInvalidInput
  )
})

test("redacts sensitive fields and known secret values", () => {
  const input = {
    password: "value",
    nested: {
      token: "token-value",
      message: "Authentication failed for secret-value"
    }
  }
  const redacted = redactDiagnosticValue(input, ["secret-value"])
  const serialized = JSON.stringify(redacted)

  assert.equal(serialized.includes("value"), false)
  assert.equal(serialized.includes("token-value"), false)
  assert.equal(serialized.includes("secret-value"), false)
  assert.equal(serialized.includes("[REDACTED]"), true)
})

test("domain errors retain stable metadata and redact their context", () => {
  const cause = new Error("low-level failure")
  const error = new SshError({
    code: "authentication_failed",
    operation: "connect",
    message: "Authentication failed",
    cause,
    context: { password: "must-not-leak", host: "example.test" }
  })

  assert.equal(error.domain, "ssh-session")
  assert.equal(error.code, "authentication_failed")
  assert.equal(error.operation, "connect")
  assert.equal(error.cause, cause)
  assert.equal(JSON.stringify(error.context).includes("must-not-leak"), false)
})

function isInvalidInput(error: unknown): boolean {
  return error instanceof SshError && error.code === "invalid_input"
}
