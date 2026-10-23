import { Writable } from "node:stream"
import { createInterface } from "node:readline"

import type { HostKeyConfirmationRequest } from "../../infrastructure/askpass/AskpassBroker"

export function readSecret(prompt: string): Promise<Uint8Array> {
  process.stderr.write(prompt)

  return readLine(true)
    .then((value) => {
      process.stderr.write("\n")
      return Buffer.from(value, "utf8")
    })
}

export function confirmHostKey(request: HostKeyConfirmationRequest): Promise<boolean> {
  process.stderr.write(`${request.prompt}\n${request.warning}\nAccept this host key? [y/N] `)

  return readLine(false)
    .then((value) => value.trim().toLowerCase() === "y" || value.trim().toLowerCase() === "yes")
}

function readLine(hidden: boolean): Promise<string> {
  const output = hidden ? new MutedOutput() : process.stderr
  const terminal = process.stdin.isTTY === true
  const input = createInterface({ input: process.stdin, output, terminal })

  return new Promise<string>((resolve, reject) => {
    input.once("SIGINT", () => {
      input.close()
      reject(new Error("Input cancelled"))
    })
    input.question("", (answer) => {
      input.close()
      resolve(answer)
    })
  })
}

class MutedOutput extends Writable {
  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    callback()
  }
}
