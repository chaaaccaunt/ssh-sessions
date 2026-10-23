import type { ProcessResult } from "../../domain/processResult"
import { SshError } from "../../domain/sshError"
import type { ProcessRunner } from "../../infrastructure/process/ProcessRunner"

const TOOL_PROBES = [
  { name: "ssh", args: ["-V"] },
  { name: "scp", args: [] },
  { name: "sftp", args: [] },
  { name: "ssh-keygen", args: ["-?"] }
] as const

export interface DoctorToolResult {
  readonly name: string
  readonly available: boolean
  readonly diagnostic?: string
}

export interface DoctorReport {
  readonly healthy: boolean
  readonly openSshVersion?: string
  readonly tools: ReadonlyArray<DoctorToolResult>
}

export class DoctorService {
  constructor(private readonly processRunner: ProcessRunner) {}

  run(): Promise<DoctorReport> {
    return Promise.all(TOOL_PROBES.map((probe) => this.probe(probe.name, probe.args)))
      .then((tools) => {
        const sshResult = tools.find((tool) => tool.name === "ssh")
        const report: DoctorReport = {
          healthy: tools.every((tool) => tool.available),
          tools,
          ...(sshResult?.diagnostic === undefined
            ? {}
            : { openSshVersion: firstLine(sshResult.diagnostic) })
        }

        return report
      })
  }

  private probe(name: string, args: ReadonlyArray<string>): Promise<DoctorToolResult> {
    return this.processRunner.run({
      executable: name,
      args,
      stdio: "capture",
      timeoutMs: 5_000,
      maxCaptureBytes: 64 * 1024
    })
      .then((result) => {
        const responsive = !result.timedOut && result.status !== "cancelled"

        return {
          name,
          available: responsive,
          ...createDiagnostic(result, responsive)
        }
      })
      .catch((error: unknown) => ({
        name,
        available: false,
        diagnostic: formatProbeError(error)
      }))
  }
}

function createDiagnostic(
  result: ProcessResult,
  responsive: boolean
): { readonly diagnostic?: string } {
  const stdout = decode(result.stdout)
  const stderr = decode(result.stderr)
  const diagnostic = [stdout, stderr].filter((value) => value.length > 0).join("\n")

  if (!responsive && diagnostic.length === 0) {
    return { diagnostic: result.timedOut ? "tool probe timed out" : "tool probe cancelled" }
  }

  return diagnostic.length === 0 ? {} : { diagnostic }
}

function decode(input: Readonly<Uint8Array> | undefined): string {
  return input === undefined ? "" : Buffer.from(input).toString("utf8").trim()
}

function firstLine(input: string): string {
  return input.split(/\r?\n/u, 1)[0] ?? input
}

function formatProbeError(error: unknown): string {
  if (error instanceof SshError) {
    return `${error.code}: ${error.message}`
  }

  return "unknown_openssh_error: tool probe failed"
}
