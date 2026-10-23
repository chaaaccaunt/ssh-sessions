#!/usr/bin/env node

import { connect } from "node:net"

const MAX_RESPONSE_BYTES = 1024 * 1024
const endpoint = process.env.SSH_SESSION_ASKPASS_ENDPOINT
const token = process.env.SSH_SESSION_ASKPASS_TOKEN
const prompt = process.argv[2] ?? ""

if (endpoint === undefined || token === undefined) {
  fail()
} else {
  const socket = connect(endpoint)
  let response = ""

  socket.setEncoding("utf8")
  socket.once("connect", () => {
    socket.write(`${JSON.stringify({ token, prompt })}\n`)
  })
  socket.on("data", (chunk: string) => {
    response += chunk

    if (Buffer.byteLength(response, "utf8") > MAX_RESPONSE_BYTES) {
      socket.destroy()
      fail()
    }

    if (response.includes("\n")) {
      const line = response.slice(0, response.indexOf("\n"))
      socket.destroy()
      writeResponse(line)
    }
  })
  socket.once("error", fail)
  socket.once("end", () => {
    if (!response.includes("\n")) {
      fail()
    }
  })
}

function writeResponse(input: string): void {
  try {
    const value: unknown = JSON.parse(input)

    if (
      typeof value !== "object"
      || value === null
      || !("ok" in value)
      || value.ok !== true
      || !("value" in value)
      || typeof value.value !== "string"
    ) {
      fail()
      return
    }

    const secret = Buffer.from(value.value, "base64")

    process.stdout.write(secret)
    process.stdout.write("\n", () => {
      secret.fill(0)
    })
  } catch {
    fail()
  }
}

function fail(): void {
  process.exitCode = 1
}
