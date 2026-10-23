const { existsSync, readFileSync, unlinkSync, writeFileSync } = require("fs")
const { join, resolve } = require("path")
const { tmpdir } = require("os")
const { spawn, spawnSync } = require("child_process")
const { EventEmitter } = require("events")

let windowsTerminalAvailable = null

function createProcessRunner(config) {
  return {
    run: (command, args, cwd = config.rootDirectory, env = process.env) => runCommand({ command, args, cwd, env }, config),
    runCommand: (command) => runCommand(command, config),
    runSequential: (commandList) => runSequential(commandList, config),
    runParallel: (commandList) => runParallel(commandList, config),
    runInSeparateWindows: (commandList) => runInSeparateWindows(commandList, config),
    getLocalBinaryPath: (binaryName) => getLocalBinaryPath(binaryName, config)
  }
}

function runCommand(command, config) {
  if (process.platform === "win32") {
    return runCommandInWindowsTerminal(command, config)
  }

  return run(command.command, command.args, command.cwd, command.env)
}

function runSequential(commandList, config) {
  return commandList.reduce(
    (chain, command) => chain.then(() => runCommand(command, config)),
    Promise.resolve()
  )
}

function runParallel(commandList, config) {
  if (process.platform === "win32" && hasWindowsTerminal()) {
    const children = spawnWindowsTerminalTabGroup(commandList, config, {
      keepOpenAfterExit: true,
      waitForExit: true
    })

    return Promise.all(children.map((child, index) => waitForWindowsTerminalCommand(child, commandList[index])))
      .then(() => undefined)
  }

  return Promise.all(commandList.map((command) => runCommand(command, config)))
}

function runInSeparateWindows(commandList, config) {
  if (process.platform !== "win32") {
    return runParallel(commandList)
  }

  if (hasWindowsTerminal()) {
    const children = spawnWindowsTerminalTabGroup(commandList, config, {
      keepOpenAfterExit: true,
      waitForExit: false
    })
    return waitForSeparateWindowProcesses(children)
  }

  const children = commandList.map((command) => runCommandInSeparateWindow(command, config))
  return waitForSeparateWindowProcesses(children)
}

function runCommandInSeparateWindow(command, config) {
  if (process.platform !== "win32") {
    return runCommand(command, config)
  }

  return spawnWindowsInteractiveCommand(command, config, {
    keepOpenAfterExit: true,
    waitForExit: false
  })
}

function runCommandInWindowsTerminal(command, config) {
  const child = spawnWindowsInteractiveCommand(command, config, {
    keepOpenAfterExit: true,
    waitForExit: true
  })

  return waitForWindowsTerminalCommand(child, command)
}

function spawnWindowsInteractiveCommand(command, config, options) {
  if (hasWindowsTerminal()) {
    return spawnWindowsTerminalCommand(command, config, options)
  }

  return spawnWindowsCmdWindowCommand(command, config, options)
}

function spawnWindowsTerminalCommand(command, config, options) {
  const tab = createWindowsTerminalTab(command, config, options)
  const child = spawn("wt.exe", [
    "-w",
    "0",
    ...tab.args
  ], {
    cwd: tab.workingDirectory,
    detached: true,
    env: process.env,
    stdio: "ignore",
    windowsHide: false
  })

  copyProcessRunnerMetadata(tab.child, child)

  return child
}

function spawnWindowsTerminalTabGroup(commandList, config, options) {
  const tabs = commandList.map((command) => createWindowsTerminalTab(command, config, options))
  const args = [
    "-w",
    "0",
    ...tabs.flatMap((tab, index) => index === 0 ? tab.args : [";", ...tab.args])
  ]
  const launcher = spawn("wt.exe", args, {
    cwd: config.rootDirectory,
    detached: true,
    env: process.env,
    stdio: "ignore",
    windowsHide: false
  })
  const children = tabs.map((tab) => tab.child)

  launcher.on("error", (error) => {
    children.forEach((child) => child.emit("error", error))
  })

  launcher.on("exit", (code) => {
    if (code === 0 || code === null) return

    children.forEach((child) => {
      child.exitCode = code
      child.emit("error", new Error(`Не удалось запустить Windows Terminal, код ${code}`))
    })
  })

  return children
}

function createWindowsTerminalTab(command, config, options) {
  const escapedCommand = getEscapedWindowsCommand(command)
  const windowTitle = getCommandWindowTitle(command)
  const workingDirectory = resolve(command.cwd || config.rootDirectory)
  const pidFilePath = createProcessPidFilePath(windowTitle)
  const exitCodeFilePath = options.waitForExit ? createProcessExitCodeFilePath(windowTitle) : null
  const wrapperScriptPath = createWindowsTerminalWrapperScriptFile({
    command,
    escapedCommand,
    exitCodeFilePath,
    keepOpenAfterExit: options.keepOpenAfterExit,
    pidFilePath,
    waitForExit: options.waitForExit,
    windowTitle
  })
  const args = [
    "new-tab",
    "--title",
    windowTitle,
    "--suppressApplicationTitle",
    "-d",
    workingDirectory,
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    wrapperScriptPath
  ]
  const child = new EventEmitter()

  child.exitCode = null
  child.processRunnerPidFilePath = pidFilePath
  child.processRunnerExitCodeFilePath = exitCodeFilePath
  child.processRunnerStartedAt = Date.now()
  child.processRunnerKeepOpenAfterExit = options.keepOpenAfterExit
  child.processRunnerWaitForExit = options.waitForExit

  return {
    args,
    child,
    workingDirectory
  }
}

function copyProcessRunnerMetadata(source, target) {
  target.processRunnerPidFilePath = source.processRunnerPidFilePath
  target.processRunnerExitCodeFilePath = source.processRunnerExitCodeFilePath
  target.processRunnerStartedAt = source.processRunnerStartedAt
  target.processRunnerKeepOpenAfterExit = source.processRunnerKeepOpenAfterExit
  target.processRunnerWaitForExit = source.processRunnerWaitForExit
}

function spawnWindowsCmdWindowCommand(command, config, options) {
  const escapedCommand = getEscapedWindowsCommand(command)
  const windowTitle = getCommandWindowTitle(command)
  const workingDirectory = resolve(command.cwd || config.rootDirectory)
  const exitCodeFilePath = options.waitForExit ? createProcessExitCodeFilePath(windowTitle) : null
  const commandToKeepOpen = createWindowsCmdWindowCommand({
    escapedCommand,
    exitCodeFilePath,
    keepOpenAfterExit: options.keepOpenAfterExit,
    waitForExit: options.waitForExit,
    windowTitle
  })

  const child = spawn("cmd.exe", ["/d", "/v:on", "/k", commandToKeepOpen], {
    cwd: workingDirectory,
    detached: true,
    env: command.env || process.env,
    stdio: "ignore",
    windowsHide: false
  })

  child.processRunnerExitCodeFilePath = exitCodeFilePath
  child.processRunnerStartedAt = Date.now()
  child.processRunnerKeepOpenAfterExit = options.keepOpenAfterExit
  child.processRunnerWaitForExit = options.waitForExit

  return child
}

function waitForWindowsTerminalCommand(child, command) {
  return new Promise((resolvePromise, rejectPromise) => {
    let isDone = false

    const cleanup = () => {
      clearInterval(monitor)
      child.off("error", handleError)
      child.off("exit", handleLauncherExit)
    }

    const finish = (callback) => {
      if (isDone) return
      isDone = true
      cleanup()
      removeProcessPidFile(child)
      removeProcessExitCodeFile(child)
      callback()
    }

    const handleError = (error) => {
      finish(() => rejectPromise(error))
    }

    const handleLauncherExit = () => {
      if (child.processRunnerPidFileWasCreated || child.processRunnerExitCodeFileWasCreated || Date.now() - child.processRunnerStartedAt <= 5000) return

      finish(() => rejectPromise(new Error(`Не удалось запустить отдельное окно для команды: ${command.command} ${command.args.join(" ")}`)))
    }

    const monitor = setInterval(() => {
      if (child.processRunnerPidFilePath && existsSync(child.processRunnerPidFilePath)) {
        child.processRunnerPidFileWasCreated = true
      }

      const exitCode = getTrackedProcessExitCode(child)
      if (exitCode === null) return

      child.processRunnerExitCodeFileWasCreated = true

      finish(() => {
        if (exitCode === 0) {
          resolvePromise()
          return
        }

        rejectPromise(new Error(`Команда завершилась с кодом ${exitCode}: ${command.command} ${command.args.join(" ")}`))
      })
    }, 500)

    child.on("error", handleError)
    child.on("exit", handleLauncherExit)
  })
}

function waitForSeparateWindowProcesses(children) {
  if (!children.length) return Promise.resolve()

  const aliveChildren = new Set(children)

  console.log("Dev-процессы запущены в отдельных окнах или вкладках. Нажмите Ctrl+C здесь, чтобы остановить все запущенные процессы.")

  return new Promise((resolvePromise, rejectPromise) => {
    let isStopping = false

    const monitor = setInterval(() => {
      children.forEach((child) => {
        if (!child.processRunnerPidFilePath) return

        if (existsSync(child.processRunnerPidFilePath)) {
          child.processRunnerPidFileWasCreated = true
          return
        }

        if (child.processRunnerPidFileWasCreated || (child.exitCode !== null && Date.now() - child.processRunnerStartedAt > 5000)) {
          aliveChildren.delete(child)
        }
      })

      finishIfDone()
    }, 1000)

    const cleanup = () => {
      clearInterval(monitor)
      process.off("SIGINT", stop)
      process.off("SIGTERM", stop)
    }

    const finishIfDone = () => {
      if (aliveChildren.size > 0) return
      cleanup()
      resolvePromise()
    }

    const stop = () => {
      if (isStopping) return
      isStopping = true

      console.log("Останавливаю dev-процессы...")

      stopSeparateWindowProcesses(Array.from(aliveChildren))
        .then(() => {
          cleanup()
          resolvePromise()
        })
        .catch((error) => {
          cleanup()
          rejectPromise(error)
        })
    }

    children.forEach((child) => {
      child.on("exit", () => {
        if (child.processRunnerPidFilePath) return

        aliveChildren.delete(child)
        finishIfDone()
      })

      child.on("error", (error) => {
        aliveChildren.delete(child)
        cleanup()
        rejectPromise(error)
      })
    })

    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
    process.stdin.resume()
  })
}

function stopSeparateWindowProcesses(children) {
  return Promise.all(children.map((child) => stopSeparateWindowProcess(child)))
    .then(() => undefined)
}

function stopSeparateWindowProcess(child) {
  const trackedPid = getTrackedProcessPid(child)
  const pid = trackedPid || child.pid

  return stopProcessTree(pid)
    .then(() => removeProcessPidFile(child))
}

function stopProcessTree(pid) {
  if (!pid) return Promise.resolve()

  if (process.platform !== "win32") {
    process.kill(-pid, "SIGTERM")
    return Promise.resolve()
  }

  return new Promise((resolvePromise) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    })

    child.on("exit", () => resolvePromise())
    child.on("error", () => resolvePromise())
  })
}

function getTrackedProcessPid(child) {
  if (!child.processRunnerPidFilePath || !existsSync(child.processRunnerPidFilePath)) return null

  const rawPid = readFileSync(child.processRunnerPidFilePath, "utf-8").trim()
  if (!/^\d+$/.test(rawPid)) return null

  return Number(rawPid)
}

function removeProcessPidFile(child) {
  if (!child.processRunnerPidFilePath || !existsSync(child.processRunnerPidFilePath)) return

  try {
    unlinkSync(child.processRunnerPidFilePath)
  } catch (error) {
    // Temp pid file cleanup is best-effort: the target process may have removed it already.
  }
}

function getTrackedProcessExitCode(child) {
  if (!child.processRunnerExitCodeFilePath || !existsSync(child.processRunnerExitCodeFilePath)) return null

  let rawExitCode

  try {
    rawExitCode = readFileSync(child.processRunnerExitCodeFilePath, "utf-8").trim()
  } catch (error) {
    if (error && (error.code === "EBUSY" || error.code === "ENOENT")) return null

    throw error
  }

  if (!/^-?\d+$/.test(rawExitCode)) return null

  return Number(rawExitCode)
}

function removeProcessExitCodeFile(child) {
  if (!child.processRunnerExitCodeFilePath || !existsSync(child.processRunnerExitCodeFilePath)) return

  try {
    unlinkSync(child.processRunnerExitCodeFilePath)
  } catch (error) {
    // Temp exit code file cleanup is best-effort: the target process may have removed it already.
  }
}

function hasWindowsTerminal() {
  if (windowsTerminalAvailable !== null) return windowsTerminalAvailable

  const result = spawnSync("where.exe", ["wt.exe"], {
    stdio: "ignore",
    windowsHide: true
  })

  windowsTerminalAvailable = result.status === 0
  return windowsTerminalAvailable
}

function run(command, args, cwd, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const spawnCommand = getSpawnCommand(command, args)
    const child = spawn(spawnCommand.command, spawnCommand.args, {
      cwd,
      env: getSpawnEnv(env),
      shell: false,
      stdio: "inherit"
    })

    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }

      rejectPromise(new Error(`Команда завершилась с кодом ${code}: ${command} ${args.join(" ")}`))
    })

    child.on("error", rejectPromise)
  })
}

function getSpawnCommand(command, args) {
  if (process.platform !== "win32") {
    return { command, args }
  }

  const commandLine = [getWindowsExecutableCommand(command), ...args].map(escapeCmdArgument).join(" ")

  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", commandLine]
  }
}

function getWindowsExecutableCommand(command) {
  if (command !== "npm") return command

  return "npm.cmd"
}

function getSpawnEnv(env) {
  return Object.fromEntries(
    Object.entries(env || process.env)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)])
  )
}

function getLocalBinaryPath(binaryName, config) {
  const executableName = process.platform === "win32" ? `${binaryName}.cmd` : binaryName
  const executablePath = resolve(config.rootDirectory, "node_modules", ".bin", executableName)

  if (!existsSync(executablePath)) {
    throw new Error(`Не найден ${executableName}. Сначала установите зависимости командой: npm run project -- install`)
  }

  return executablePath
}

function getCommandWindowTitle(command) {
  const runIndex = command.args.indexOf("run")

  if (command.workspaceName && runIndex !== -1) {
    const workspaceTitle = command.workspaceName.replace(/^boilerplate-ts-(?:service-|gateway-)?/, "")

    return `${workspaceTitle}:${command.args[runIndex + 1]}`
  }

  return "boilerplate-ts"
}

function createProcessPidFilePath(windowTitle) {
  const safeTitle = windowTitle.replace(/[^A-Za-z0-9_-]+/g, "_")
  return join(tmpdir(), `boilerplate-ts-${safeTitle}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.pid`)
}

function createProcessExitCodeFilePath(windowTitle) {
  const safeTitle = windowTitle.replace(/[^A-Za-z0-9_-]+/g, "_")
  return join(tmpdir(), `boilerplate-ts-${safeTitle}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.exit`)
}

function createProcessScriptFilePath(windowTitle) {
  const safeTitle = windowTitle.replace(/[^A-Za-z0-9_-]+/g, "_")
  return join(tmpdir(), `boilerplate-ts-${safeTitle}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`)
}

function createWindowsTerminalWrapperScriptFile(options) {
  const scriptFilePath = createProcessScriptFilePath(options.windowTitle)
  const script = createWindowsTerminalWrapperScript(options)

  writeFileSync(scriptFilePath, `\uFEFF${script}`, "utf-8")

  return scriptFilePath
}

function createWindowsTerminalWrapperScript(options) {
  const commandLine = `title ${escapeCmdTitle(options.windowTitle)} && ${options.escapedCommand}`
  const environmentBootstrap = createWindowsPowerShellEnvironmentBootstrap(options.command.env)
  const script = options.waitForExit ? [
    `$Host.UI.RawUI.WindowTitle = ${escapePowerShellSingleQuotedString(options.windowTitle)}`,
    "$scriptPath = $PSCommandPath",
    ...environmentBootstrap,
    `Set-Content -LiteralPath ${escapePowerShellSingleQuotedString(options.pidFilePath)} -Value $PID`,
    "$exitCode = 0",
    "try {",
    `  cmd.exe /d /s /c ${escapePowerShellSingleQuotedString(commandLine)}`,
    "  $exitCode = $LASTEXITCODE",
    "  if ($null -eq $exitCode) { $exitCode = 0 }",
    "} catch {",
    "  $exitCode = 1",
    "  Write-Error $_",
    "} finally {",
    `  Set-Content -LiteralPath ${escapePowerShellSingleQuotedString(options.exitCodeFilePath)} -Value $exitCode`,
    `  Remove-Item -LiteralPath ${escapePowerShellSingleQuotedString(options.pidFilePath)} -ErrorAction SilentlyContinue`,
    "}",
    `Write-Host ${escapePowerShellSingleQuotedString("Команда завершилась. Нажмите Enter, чтобы закрыть вкладку.")}`,
    "Read-Host | Out-Null",
    "Remove-Item -LiteralPath $scriptPath -ErrorAction SilentlyContinue",
    "exit $exitCode"
  ] : [
    `$Host.UI.RawUI.WindowTitle = ${escapePowerShellSingleQuotedString(options.windowTitle)}`,
    "$scriptPath = $PSCommandPath",
    ...environmentBootstrap,
    `Set-Content -LiteralPath ${escapePowerShellSingleQuotedString(options.pidFilePath)} -Value $PID`,
    "try {",
    `  cmd.exe /d /k ${escapePowerShellSingleQuotedString(commandLine)}`,
    "} finally {",
    `  Remove-Item -LiteralPath ${escapePowerShellSingleQuotedString(options.pidFilePath)} -ErrorAction SilentlyContinue`,
    "  Remove-Item -LiteralPath $scriptPath -ErrorAction SilentlyContinue",
    "}"
  ]

  return script.join("\r\n")
}

function createWindowsPowerShellEnvironmentBootstrap(env) {
  return Object.entries(env || {})
    .filter(([, value]) => value !== undefined)
    .filter(([key, value]) => process.env[key] !== String(value))
    .map(([key, value]) => `$env:${key} = ${escapePowerShellSingleQuotedString(value)}`)
}

function createWindowsCmdWindowCommand(options) {
  const commandLine = `title ${escapeCmdTitle(options.windowTitle)} && ${options.escapedCommand}`

  if (!options.waitForExit) return commandLine

  const waitCommand = options.keepOpenAfterExit
    ? "echo. & echo Команда завершилась. Введите exit или закройте окно."
    : "exit /b !BOILERPLATE_EXIT_CODE!"

  return [
    commandLine,
    "set BOILERPLATE_EXIT_CODE=!ERRORLEVEL!",
    `> ${escapeCmdArgument(options.exitCodeFilePath)} echo !BOILERPLATE_EXIT_CODE!`,
    waitCommand
  ].join(" & ")
}

function getEscapedWindowsCommand(command) {
  return [getWindowsExecutableCommand(command.command), ...command.args].map(escapeCmdArgument).join(" ")
}

function escapeCmdArgument(value) {
  if (/^[A-Za-z0-9_./:\\=-]+$/.test(value)) return value
  return `"${String(value).replace(/"/g, '""')}"`
}

function escapeCmdTitle(value) {
  return String(value).replace(/[&|<>^"]/g, "")
}

function escapePowerShellSingleQuotedString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

module.exports = {
  createProcessRunner
}
