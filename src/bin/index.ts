#!/usr/bin/env node

import { DoctorService } from "../application/doctor/DoctorService"
import { OpenSshSessionService } from "../application/OpenSshSessionService"
import { NodeProcessRunner } from "../infrastructure/process/NodeProcessRunner"
import { runCli } from "../presentation/cli/runCli"
import { confirmHostKey, readSecret } from "../presentation/cli/terminalPrompts"

const processRunner = new NodeProcessRunner()
const doctorService = new DoctorService(processRunner)
const sessionService = new OpenSshSessionService(processRunner)

runCli(
  process.argv.slice(2),
  {
    runDoctor: () => doctorService.run(),
    connect: (connection, options) => sessionService.connect(connection, options),
    execute: (request) => sessionService.execute(request),
    upload: (request) => sessionService.upload(request),
    download: (request) => sessionService.download(request),
    files: (connection, options) => sessionService.files(connection, options),
    readSecret,
    confirmHostKey
  },
  (message) => process.stdout.write(message),
  (message) => process.stderr.write(message)
)
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unexpected CLI error"

    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
