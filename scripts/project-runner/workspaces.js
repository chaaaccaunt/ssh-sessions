const { existsSync, readdirSync, readFileSync } = require("fs")
const { join } = require("path")

function createWorkspaceContext(config) {
  const frontendWorkspaceName = getPackageName(config.frontendPackageDirectory)
  const frontendWorkspaceNames = new Map(config.frontendPackageDirectories.map((directory) => [directory.split(/[\\/]/).pop(), getPackageName(directory)]))
  const serviceWorkspaceNames = getPackageWorkspaceNames(config.servicesDirectory)
  const gatewayWorkspaceNames = getPackageWorkspaceNames(config.gatewaysDirectory)
  const serviceWorkspaceOptions = getPackageWorkspaceOptions(config.servicesDirectory)
  const gatewayWorkspaceOptions = getPackageWorkspaceOptions(config.gatewaysDirectory)

  return {
    frontendWorkspaceName,
    frontendWorkspaceNames,
    serviceWorkspaceNames,
    gatewayWorkspaceNames,
    serviceWorkspaceOptions,
    getServiceWorkspaceName: (serviceName) => getServiceWorkspaceName(serviceWorkspaceNames, serviceName),
    getGatewayWorkspaceName: (gatewayName) => getGatewayWorkspaceName(gatewayWorkspaceNames, gatewayName),
    getAllServiceWorkspaceNames: () => Array.from(serviceWorkspaceNames.values()),
    getDevelopmentServiceWorkspaceNames: () => Array.from(serviceWorkspaceNames.values())
      .filter((workspaceName) => serviceWorkspaceOptions.get(workspaceName)?.runWithDevAll !== false),
    getAllGatewayWorkspaceNames: () => Array.from(gatewayWorkspaceNames.values()),
    getDevelopmentGatewayWorkspaceNames: () => Array.from(gatewayWorkspaceNames.values())
      .filter((workspaceName) => gatewayWorkspaceOptions.get(workspaceName)?.runWithDevAll !== false),
    getAllFrontendWorkspaceNames: () => Array.from(frontendWorkspaceNames.values()),
    getFrontendWorkspaceName: (name = "monolith") => getFrontendWorkspaceName(frontendWorkspaceNames, name),
    resolveWorkspaceName: (targetName) => resolveWorkspaceName({
      targetName,
      frontendWorkspaceName,
      frontendWorkspaceNames,
      serviceWorkspaceNames,
      gatewayWorkspaceNames
    }),
    getWorkspaceDirectory: (workspaceName) => getWorkspaceDirectory({
      config,
      workspaceName,
      frontendWorkspaceName,
      frontendWorkspaceNames,
      serviceWorkspaceNames,
      gatewayWorkspaceNames
    })
  }
}

function getPackageWorkspaceNames(packagesDirectory) {
  if (!existsSync(packagesDirectory)) return new Map()

  return new Map(readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const packageName = entry.name
      const workspaceName = getPackageName(join(packagesDirectory, packageName))
      return [packageName, workspaceName]
    })
    .filter((entry) => Boolean(entry[1])))
}

function getPackageWorkspaceOptions(packagesDirectory) {
  if (!existsSync(packagesDirectory)) return new Map()

  return new Map(readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const packageDirectory = join(packagesDirectory, entry.name)
      const packageJson = getPackageJson(packageDirectory)
      return [
        packageJson?.name,
        {
          runWithDevAll: packageJson?.boilerplate?.runWithDevAll !== false
        }
      ]
    })
    .filter(([workspaceName]) => Boolean(workspaceName)))
}

function getServiceWorkspaceName(serviceWorkspaceNames, serviceName) {
  const workspaceName = serviceWorkspaceNames.get(serviceName)

  if (!workspaceName) {
    throw new Error(`Backend-сервис не найден: ${serviceName}`)
  }

  return workspaceName
}

function getGatewayWorkspaceName(gatewayWorkspaceNames, gatewayName) {
  const workspaceName = gatewayWorkspaceNames.get(gatewayName)

  if (!workspaceName) {
    throw new Error(`Gateway не найден: ${gatewayName}`)
  }

  return workspaceName
}

function getFrontendWorkspaceName(frontendWorkspaceNames, frontendName) {
  const workspaceName = frontendWorkspaceNames.get(frontendName)
  if (!workspaceName) throw new Error(`Frontend не найден: ${frontendName}`)
  return workspaceName
}

function resolveWorkspaceName(options) {
  if (options.targetName === "frontend" || options.targetName === "monolith") return options.frontendWorkspaceName
  if (options.targetName.startsWith("frontend:")) return getFrontendWorkspaceName(options.frontendWorkspaceNames, options.targetName.slice("frontend:".length))
  if (options.targetName.startsWith("service:")) return getServiceWorkspaceName(options.serviceWorkspaceNames, options.targetName.slice("service:".length))
  if (options.targetName.startsWith("gateway:")) return getGatewayWorkspaceName(options.gatewayWorkspaceNames, options.targetName.slice("gateway:".length))
  if ([...options.frontendWorkspaceNames.values(), ...options.serviceWorkspaceNames.values(), ...options.gatewayWorkspaceNames.values()].includes(options.targetName)) return options.targetName

  throw new Error(`Workspace не найден: ${options.targetName}`)
}

function getWorkspaceDirectory(options) {
  for (const [frontendName, frontendWorkspaceName] of options.frontendWorkspaceNames) {
    if (frontendWorkspaceName === options.workspaceName) return options.config.frontendPackageDirectories.find((directory) => directory.endsWith(frontendName))
  }

  for (const [serviceName, serviceWorkspaceName] of options.serviceWorkspaceNames) {
    if (serviceWorkspaceName === options.workspaceName) return join(options.config.servicesDirectory, serviceName)
  }

  for (const [gatewayName, gatewayWorkspaceName] of options.gatewayWorkspaceNames) {
    if (gatewayWorkspaceName === options.workspaceName) return join(options.config.gatewaysDirectory, gatewayName)
  }

  throw new Error(`Workspace не найден: ${options.workspaceName}`)
}

function getPackageName(packageDirectory) {
  return getPackageJson(packageDirectory)?.name || null
}

function getPackageJson(packageDirectory) {
  const packageJsonPath = join(packageDirectory, "package.json")
  if (!existsSync(packageJsonPath)) return null

  return JSON.parse(readFileSync(packageJsonPath, "utf-8"))
}

function getPackageDirectoryNames(packagesDirectory) {
  if (!existsSync(packagesDirectory)) return []

  return readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((packageName) => existsSync(join(packagesDirectory, packageName, "package.json")))
    .sort((left, right) => left.localeCompare(right))
}

module.exports = {
  createWorkspaceContext,
  getPackageDirectoryNames
}
