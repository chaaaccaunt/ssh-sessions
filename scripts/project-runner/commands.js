const { createProcessRunner } = require("./process-runner")
const { getPackageLocalEnv } = require("./env-files")
const { getLocalhostDatabaseAdminCredentials, parseInitOptions, updateRuntimeDevelopmentEnvFiles, writeLocalhostDevelopmentEnvFiles } = require("./init-flow")
const { writeProductionEnvFiles } = require("./production-env")
const { showHelp } = require("./help")

function createCommands(context) {
  const processRunner = createProcessRunner(context.config)
  const commands = {
    help: {
      description: "Показать список команд",
      handler: () => showHelp(commands)
    },
    install: {
      description: "Установить зависимости: install [all|frontend|service <name>|gateway <name>]",
      handler: (args) => handleInstall(context, processRunner, args)
    },
    dev: {
      description: "Запустить разработку: dev [all|frontend|service <name>|gateway <name>]",
      handler: (args) => handleDevelopment(context, processRunner, args)
    },
    build: {
      description: "Собрать проект: build [all|frontend|service <name>|gateway <name>] [--config <path>]",
      handler: (args) => handleBuild(context, processRunner, args)
    },
    typecheck: {
      description: "Проверить типы: typecheck [all|shared|frontend|service <name>|gateway <name>]",
      handler: (args) => handleTypecheck(context, processRunner, args)
    },
    migrate: {
      description: "Выполнить миграции базы данных: migrate [dev|dist]",
      handler: (args) => handleMigrate(context, processRunner, args)
    },
    init: {
      description: "Инициализировать development env, пересоздать БД и запустить dev: init <db-host> <db-admin-user> <db-admin-password>",
      handler: (args) => handleInit(context, processRunner, args)
    },
    "start-dist": {
      description: "Запустить production bundle: start-dist [service <name>|gateway <name>]",
      handler: (args) => handleStartDist(context, processRunner, args)
    },
    workspace: {
      description: "Запустить workspace script: workspace <workspace|frontend|service:name|gateway:name> <script> [...args]",
      handler: (args) => handleWorkspace(context, processRunner, args)
    }
  }

  return commands
}

function handleInstall(context, processRunner, args) {
  const target = getTarget(args, "all")

  if (target.kind === "all") return processRunner.run("npm", ["install"])
  if (target.kind === "frontend") return runWorkspaceCommand(context, processRunner, context.workspaces.getFrontendWorkspaceName(target.name), "install")
  if (target.kind === "service") return runWorkspaceCommand(context, processRunner, context.workspaces.getServiceWorkspaceName(target.name), "install")
  if (target.kind === "gateway") return runWorkspaceCommand(context, processRunner, context.workspaces.getGatewayWorkspaceName(target.name), "install")

  throw new Error(`Неподдерживаемая цель установки: ${target.raw}`)
}

function handleDevelopment(context, processRunner, args) {
  const target = getTarget(args, "all")

  if (target.kind === "all") {
    return processRunner.runInSeparateWindows([
      ...context.workspaces.getDevelopmentServiceWorkspaceNames().map((workspaceName) => createWorkspaceCommand(context, workspaceName, "start")),
      ...context.workspaces.getDevelopmentGatewayWorkspaceNames().map((workspaceName) => createWorkspaceCommand(context, workspaceName, "start")),
      ...context.workspaces.getAllFrontendWorkspaceNames().map((workspaceName) => createWorkspaceCommand(context, workspaceName, "serve"))
    ])
  }

  if (target.kind === "frontend") return processRunner.runInSeparateWindows([createWorkspaceCommand(context, context.workspaces.getFrontendWorkspaceName(target.name), "serve")])
  if (target.kind === "service") return processRunner.runInSeparateWindows([createWorkspaceCommand(context, context.workspaces.getServiceWorkspaceName(target.name), "start")])
  if (target.kind === "gateway") return processRunner.runInSeparateWindows([createWorkspaceCommand(context, context.workspaces.getGatewayWorkspaceName(target.name), "start")])

  throw new Error(`Неподдерживаемая цель запуска: ${target.raw}`)
}

function handleBuild(context, processRunner, args) {
  const options = parseBuildOptions(args)
  const target = getTarget(options.targetArgs, "all")

  if (!["all", "frontend", "service", "gateway"].includes(target.kind)) {
    throw new Error(`Неподдерживаемая цель сборки: ${target.raw}`)
  }

  writeProductionEnvFiles(context, target, options.configPath)

  if (target.kind === "all") {
    return processRunner.runParallel([
      ...context.workspaces.getAllServiceWorkspaceNames().map((workspaceName) => createWorkspaceCommand(context, workspaceName, "build")),
      ...context.workspaces.getAllGatewayWorkspaceNames().map((workspaceName) => createWorkspaceCommand(context, workspaceName, "build")),
      ...context.workspaces.getAllFrontendWorkspaceNames().map((workspaceName) => createWorkspaceCommand(context, workspaceName, "build"))
    ])
  }

  if (target.kind === "frontend") return runWorkspaceCommand(context, processRunner, context.workspaces.getFrontendWorkspaceName(target.name), "build")
  if (target.kind === "service") return runWorkspaceCommand(context, processRunner, context.workspaces.getServiceWorkspaceName(target.name), "build")
  if (target.kind === "gateway") return runWorkspaceCommand(context, processRunner, context.workspaces.getGatewayWorkspaceName(target.name), "build")

  throw new Error(`Неподдерживаемая цель сборки: ${target.raw}`)
}

function parseBuildOptions(args) {
  const targetArgs = []
  let configPath

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--config") {
      targetArgs.push(args[index])
      continue
    }

    if (configPath || !args[index + 1]) {
      throw new Error("Формат параметра: --config <path>")
    }

    configPath = args[index + 1]
    index += 1
  }

  return { configPath, targetArgs }
}

function handleTypecheck(context, processRunner, args) {
  const target = getTarget(args, "all")

  if (target.kind === "all") {
    return processRunner.runParallel([
      createSharedTypecheckCommand(processRunner),
      ...context.workspaces.getAllServiceWorkspaceNames().map((workspaceName) => createWorkspaceCommand(context, workspaceName, "typecheck")),
      ...context.workspaces.getAllGatewayWorkspaceNames().map((workspaceName) => createWorkspaceCommand(context, workspaceName, "typecheck")),
      ...context.workspaces.getAllFrontendWorkspaceNames().map((workspaceName) => createWorkspaceCommand(context, workspaceName, "typecheck"))
    ])
  }

  if (target.kind === "shared") return processRunner.runCommand(createSharedTypecheckCommand(processRunner))
  if (target.kind === "frontend") return runWorkspaceCommand(context, processRunner, context.workspaces.getFrontendWorkspaceName(target.name), "typecheck")
  if (target.kind === "service") return runWorkspaceCommand(context, processRunner, context.workspaces.getServiceWorkspaceName(target.name), "typecheck")
  if (target.kind === "gateway") return runWorkspaceCommand(context, processRunner, context.workspaces.getGatewayWorkspaceName(target.name), "typecheck")

  throw new Error(`Неподдерживаемая цель проверки типов: ${target.raw}`)
}

function handleStartDist(context, processRunner, args) {
  const target = getTarget(args, "service", "monolith")

  if (target.kind === "service") return runWorkspaceCommand(context, processRunner, context.workspaces.getServiceWorkspaceName(target.name), "start:dist")
  if (target.kind === "gateway") return runWorkspaceCommand(context, processRunner, context.workspaces.getGatewayWorkspaceName(target.name), "start:dist")

  throw new Error("Production bundle запускается только для backend-сервиса или gateway")
}

function handleMigrate(context, processRunner, args) {
  const [mode = "dev"] = args

  if (mode === "dev") return runWorkspaceCommand(context, processRunner, context.workspaces.getServiceWorkspaceName("database-migration"), "start")
  if (mode === "dist") return runWorkspaceCommand(context, processRunner, context.workspaces.getServiceWorkspaceName("database-migration"), "start:dist")

  throw new Error("Формат команды: migrate [dev|dist]")
}

function handleInit(context, processRunner, args) {
  const options = parseInitOptions(args, context.config)

  const migrationWorkspaceName = context.workspaces.getServiceWorkspaceName("database-migration")
  const migrationWorkspaceDirectory = context.workspaces.getWorkspaceDirectory(migrationWorkspaceName)
  const adminCredentials = getLocalhostDatabaseAdminCredentials(options.credentials, migrationWorkspaceDirectory)

  return Promise.resolve()
    .then(() => {
      writeLocalhostDevelopmentEnvFiles(context.config, adminCredentials.userName, adminCredentials.password, options)
    })
    .then(() => runLocalhostDatabaseReset(context, processRunner))
    .then(() => handleDevelopment(context, processRunner, ["all"]))
}

function runLocalhostDatabaseReset(context, processRunner) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Пересоздание базы данных запрещено в production-среде")
  }

  const migrationWorkspaceName = context.workspaces.getServiceWorkspaceName("database-migration")
  const migrationWorkspaceDirectory = context.workspaces.getWorkspaceDirectory(migrationWorkspaceName)

  updateRuntimeDevelopmentEnvFiles(context.config, migrationWorkspaceDirectory)

  return processRunner.runCommand(createWorkspaceCommand(context, migrationWorkspaceName, "initialize-development"))
}

function handleWorkspace(context, processRunner, args) {
  const [targetName, scriptName, ...scriptArgs] = args

  if (!targetName || !scriptName) {
    throw new Error("Формат команды: workspace <workspace|frontend|service:name|gateway:name> <script> [...args]")
  }

  return runWorkspaceCommand(context, processRunner, context.workspaces.resolveWorkspaceName(targetName), scriptName, scriptArgs)
}

function getTarget(args, defaultKind, defaultName) {
  const [kind = defaultKind, name = defaultName] = args

  if (kind === "all") return { kind: "all", raw: kind }
  if (kind === "shared") return { kind: "shared", raw: kind }
  if (kind === "frontend" || kind === "monolith") return { kind: "frontend", name: kind === "monolith" ? "monolith" : (name || "monolith"), raw: `${kind}${name ? ` ${name}` : ""}` }
  if (kind.startsWith("frontend:")) return { kind: "frontend", name: kind.slice("frontend:".length), raw: kind }
  if (kind === "service") return { kind: "service", name: name || "monolith", raw: `${kind} ${name || "monolith"}` }
  if (kind === "gateway") return { kind: "gateway", name: name || "monolith", raw: `${kind} ${name || "monolith"}` }
  if (kind.startsWith("service:")) return { kind: "service", name: kind.slice("service:".length), raw: kind }
  if (kind.startsWith("gateway:")) return { kind: "gateway", name: kind.slice("gateway:".length), raw: kind }

  return { kind, name, raw: args.join(" ") }
}

function createSharedTypecheckCommand(processRunner) {
  const executable = processRunner.getLocalBinaryPath("tsc")

  return {
    command: executable,
    args: ["-p", "shared/tsconfig.json", "--noEmit"]
  }
}

function createWorkspaceCommand(context, workspaceName, scriptName, scriptArgs = []) {
  const cwd = context.workspaces.getWorkspaceDirectory(workspaceName)

  return {
    command: "npm",
    args: ["run", scriptName, ...scriptArgs],
    workspaceName,
    cwd,
    env: getPackageLocalEnv(cwd, scriptName)
  }
}

function runWorkspaceCommand(context, processRunner, workspaceName, scriptName, scriptArgs = []) {
  return processRunner.runCommand(createWorkspaceCommand(context, workspaceName, scriptName, scriptArgs))
}

module.exports = {
  createCommands
}
