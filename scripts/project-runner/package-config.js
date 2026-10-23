const { existsSync, readFileSync } = require("fs")
const { join } = require("path")
const { getPackageDirectoryNames } = require("./workspaces")

function getLocalhostPackagePorts(config) {
  const usedPorts = new Set()

  return {
    service: getLocalhostPackageKindPorts({
      config,
      packageKind: "service",
      packageNames: getPackageDirectoryNames(config.servicesDirectory)
        .filter((packageName) => packageName !== "database-migration"),
      usedPorts
    }),
    gateway: getLocalhostPackageKindPorts({
      config,
      packageKind: "gateway",
      packageNames: getPackageDirectoryNames(config.gatewaysDirectory),
      usedPorts
    })
  }
}

function getLocalhostPackageKindPorts(options) {
  const startPort = options.packageKind === "gateway" ? 4200 : 4101
  let nextPort = startPort

  return options.packageNames.reduce((ports, packageName) => {
    const configuredPort = getLocalhostPackageConfiguredPort(options.config, options.packageKind, packageName)
    const port = configuredPort || getNextAvailableLocalhostPort(options.usedPorts, nextPort)

    if (configuredPort && options.usedPorts.has(configuredPort)) {
      throw new Error(`Localhost port ${configuredPort} из ${options.packageKind}/${packageName}/${options.config.packageConfigFileName} уже используется другим package`)
    }

    options.usedPorts.add(port)
    nextPort = Number(port) + 1

    return {
      ...ports,
      [packageName]: port
    }
  }, {})
}

function getLocalhostPackageConfiguredPort(config, packageKind, packageName) {
  const packageDirectory = packageKind === "gateway"
    ? join(config.gatewaysDirectory, packageName)
    : join(config.servicesDirectory, packageName)
  const packageConfig = readOptionalPackageConfig(config, packageDirectory)
  const port = packageConfig?.development?.localhost?.port

  if (port === undefined || port === null || port === "") return null

  if (typeof port !== "string" || !/^\d+$/.test(port)) {
    throw new Error(`В ${packageKind}/${packageName}/${config.packageConfigFileName} development.localhost.port должен быть строкой с номером порта`)
  }

  return port
}

function getNextAvailableLocalhostPort(usedPorts, startPort) {
  let port = startPort

  while (usedPorts.has(String(port))) {
    port += 1
  }

  return String(port)
}

function getLocalhostPackagePort(localhostPackagePorts, packageKind, packageName) {
  const port = localhostPackagePorts[packageKind]?.[packageName]
  if (!port) throw new Error(`Не найден localhost port для ${packageKind}/${packageName}`)

  return port
}

function getDatabaseRuntimeUserConfigItems(config) {
  return getLocalhostRuntimePackageItems(config)
    .map((packageItem) => {
      const grants = readDatabaseGrantConfig(config, packageItem)

      return {
        packageKind: packageItem.packageKind,
        packageName: packageItem.packageName,
        userName: createRuntimeUserName(packageItem.packageKind, packageItem.packageName),
        password: createRuntimeUserPassword(packageItem.packageName),
        grants
      }
    })
}

function getLocalhostRuntimePackageItems(config) {
  return [
    ...getPackageDirectoryNames(config.servicesDirectory)
      .filter((packageName) => packageName !== "database-migration")
      .map((packageName) => ({
        packageKind: "service",
        packageName,
        packageDirectory: join(config.servicesDirectory, packageName)
      })),
    ...getPackageDirectoryNames(config.gatewaysDirectory)
      .map((packageName) => ({
        packageKind: "gateway",
        packageName,
        packageDirectory: join(config.gatewaysDirectory, packageName)
      }))
  ]
}

function readDatabaseGrantConfig(config, packageItem) {
  const configPath = join(packageItem.packageDirectory, config.packageConfigFileName)
  const packageConfig = readRequiredPackageConfig(config, packageItem.packageDirectory)

  const runtimeGrants = packageConfig.database?.runtimeGrants

  if (!Array.isArray(runtimeGrants)) {
    throw new Error(`Package config должен содержать database.runtimeGrants array: ${configPath}`)
  }

  return runtimeGrants.map((grant) => normalizeDatabaseGrant(config, grant, configPath))
}

function getRuntimePackageUid(config, packageKind, packageName) {
  const packageDirectory = packageKind === "gateway"
    ? join(config.gatewaysDirectory, packageName)
    : join(config.servicesDirectory, packageName)
  const configPath = join(packageDirectory, config.packageConfigFileName)
  const packageConfig = readRequiredPackageConfig(config, packageDirectory)
  const packageUid = packageConfig.runtime?.packageUid

  if (typeof packageUid !== "string" || !/^[0-9a-fA-F-]{36}$/.test(packageUid)) {
    throw new Error(`В ${configPath} должен быть задан runtime.packageUid в формате UUID`)
  }

  return packageUid
}

function readRequiredPackageConfig(config, packageDirectory) {
  const configPath = join(packageDirectory, config.packageConfigFileName)
  if (!existsSync(configPath)) {
    throw new Error(`Не найден package-local config: ${configPath}`)
  }

  let packageConfig

  try {
    packageConfig = JSON.parse(readFileSync(configPath, "utf-8"))
  } catch (error) {
    throw new Error(`Некорректный JSON в ${configPath}`)
  }

  if (!packageConfig || typeof packageConfig !== "object" || Array.isArray(packageConfig)) {
    throw new Error(`Package config должен быть object: ${configPath}`)
  }

  return packageConfig
}

function readOptionalPackageConfig(config, packageDirectory) {
  const configPath = join(packageDirectory, config.packageConfigFileName)
  if (!existsSync(configPath)) return null

  return readRequiredPackageConfig(config, packageDirectory)
}

function normalizeDatabaseGrant(config, grant, configPath) {
  if (!grant || typeof grant !== "object" || Array.isArray(grant)) {
    throw new Error(`Database grant должен быть object: ${configPath}`)
  }

  if (typeof grant.table !== "string" || !/^[A-Za-z0-9_]+$/.test(grant.table)) {
    throw new Error(`Некорректное имя таблицы в ${configPath}: ${grant.table}`)
  }

  if (!Array.isArray(grant.operations) || !grant.operations.length) {
    throw new Error(`Database grant должен содержать operations array: ${configPath}.${grant.table}`)
  }

  const operations = grant.operations.map((operation) => {
    if (typeof operation !== "string") {
      throw new Error(`Database grant operation должен быть string: ${configPath}.${grant.table}`)
    }

    return operation.trim().toUpperCase()
  })
    .filter(Boolean)

  operations.forEach((operation) => {
    if (!config.allowedRuntimeGrantOperations.has(operation)) {
      throw new Error(`Недопустимая runtime operation в ${configPath}: ${operation}`)
    }
  })

  return {
    table: grant.table,
    operations
  }
}

function createRuntimeUserName(packageKind, packageName) {
  const suffix = packageKind === "gateway" ? "gw" : "svc"
  const normalizedPackageName = normalizePackageNameForDatabaseUser(packageName)
  const maxPackageNameLength = 32 - suffix.length - 1
  const shortenedPackageName = normalizedPackageName.slice(0, maxPackageNameLength).replace(/_+$/g, "")

  return `${shortenedPackageName}_${suffix}`
}

function createRuntimeUserPassword(packageName) {
  return `${normalizePackageNameForDatabaseUser(packageName)}_password`
}

function normalizePackageNameForDatabaseUser(packageName) {
  return packageName.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
}

module.exports = {
  getDatabaseRuntimeUserConfigItems,
  getRuntimePackageUid,
  getLocalhostPackagePort,
  getLocalhostPackagePorts
}
