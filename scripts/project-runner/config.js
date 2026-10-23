const { existsSync, readFileSync } = require("fs")
const { join, resolve } = require("path")

const rootDirectory = resolve(__dirname, "../..")
const frontendPackageDirectory = join(rootDirectory, "monolith")
const siteAdminPackageDirectory = join(rootDirectory, "site-admin")
const servicesDirectory = join(rootDirectory, "services")
const gatewaysDirectory = join(rootDirectory, "gateways")
const nginxDirectory = join(rootDirectory, "nginx")
const packageConfigFileName = "package.config.json"
const rootDevelopmentConfigFileName = "development.config.json"
const rootDevelopmentConfigExampleFileName = "development.config_example.json"
const rootProductionConfigFileName = "production.config.json"
const rootProductionConfigExampleFileName = "production.config_example.json"
const localhostNoNginxHttpOrigin = "http://localhost:8080"
const defaultDatabaseDialect = "mysql"
const defaultDatabaseHost = "localhost"
const defaultDatabaseServiceHost = "%"
const defaultDatabasePorts = {
  mysql: "3306",
  postgres: "5432"
}
function createProjectConfig() {
  const developmentConfig = getDevelopmentConfig()
  const siteAdminHttpUrl = new URL(developmentConfig.localhost.siteAdminHttpOrigin)
  const siteAdminHttpPath = normalizeHttpPath(siteAdminHttpUrl.pathname)

  return {
    rootDirectory,
    frontendPackageDirectory,
    frontendPackageDirectories: [frontendPackageDirectory, siteAdminPackageDirectory],
    siteAdminPackageDirectory,
    servicesDirectory,
    gatewaysDirectory,
    nginxDirectory,
    packageConfigFileName,
    rootDevelopmentConfigFileName,
    rootDevelopmentConfigExampleFileName,
    rootProductionConfigFileName,
    rootProductionConfigExampleFileName,
    localhostDatabaseName: "boilerplate_dev",
    localhostDatabaseDialect: getLocalhostDatabaseDialect(developmentConfig),
    localhostDatabaseHost: getLocalhostDatabaseHost(developmentConfig),
    localhostDatabasePort: getLocalhostDatabasePort(developmentConfig),
    localhostDatabaseServiceHost: getLocalhostDatabaseServiceHost(developmentConfig),
    localhostNoNginx: getLocalhostNoNginx(developmentConfig),
    localhostDebug: getLocalhostDebug(developmentConfig),
    localhostMockData: getLocalhostMockData(developmentConfig),
    localhostPublicUserCookieDomain: developmentConfig.localhost.publicUserCookieDomain,
    localhostHttpOrigin: developmentConfig.localhost.httpOrigin,
    localhostSiteAdminHttpOrigin: siteAdminHttpUrl.origin,
    localhostSiteAdminHttpUrl: `${siteAdminHttpUrl.origin}${siteAdminHttpPath}`,
    localhostSiteAdminHttpPath: siteAdminHttpPath,
    baseUrl: developmentConfig.localhost.baseUrl,
    localhostNoNginxHttpOrigin,
    localhostFrontendDevServerPort: "8081",
    localhostSiteAdminDevServerPort: "8082",
    localhostCookieName: "authorization",
    localhostPublicUserCookieName: "authorization_user",
    localhostJwtSecret: "localhost-development-jwt-secret",
    localhostJwtAudience: "boilerplate-ts-localhost",
    localhostJwtIssuer: "boilerplate-ts-localhost",
    localhostLogCollectorSocketHost: "localhost",
    localhostLogCollectorSocketPort: "4304",
    localhostPackages: getLocalhostPackages(developmentConfig),
    localhostMigrationUser: {
      userName: "migration_service",
      password: "migration_service"
    },
    allowedRuntimeGrantOperations: new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "INDEX", "REFERENCES"])
  }
}

function getDevelopmentConfig() {
  const configPath = join(rootDirectory, rootDevelopmentConfigFileName)
  const fallbackConfigPath = join(rootDirectory, rootDevelopmentConfigExampleFileName)
  const sourceConfigPath = existsSync(configPath) ? configPath : fallbackConfigPath
  const sourceConfigFileName = existsSync(configPath) ? rootDevelopmentConfigFileName : rootDevelopmentConfigExampleFileName

  if (!existsSync(sourceConfigPath)) {
    throw new Error(`Не найден корневой ${rootDevelopmentConfigFileName} или fallback ${rootDevelopmentConfigExampleFileName}`)
  }

  const config = JSON.parse(readFileSync(sourceConfigPath, "utf-8"))
  const localhost = config.localhost

  if (!localhost || typeof localhost !== "object" || Array.isArray(localhost)) {
    throw new Error(`В ${sourceConfigFileName} должен быть объект localhost`)
  }

  validateRequiredDevelopmentConfigValue(localhost.publicUserCookieDomain, "localhost.publicUserCookieDomain", sourceConfigFileName)
  validateRequiredDevelopmentConfigValue(localhost.httpOrigin, "localhost.httpOrigin", sourceConfigFileName)
  validateRequiredDevelopmentConfigValue(localhost.siteAdminHttpOrigin, "localhost.siteAdminHttpOrigin", sourceConfigFileName)
  validateRequiredDevelopmentConfigValue(localhost.baseUrl, "localhost.baseUrl", sourceConfigFileName)
  validateOptionalDevelopmentConfigBoolean(localhost.noNginx, "localhost.noNginx", sourceConfigFileName)
  validateOptionalDevelopmentConfigBoolean(localhost.debug, "localhost.debug", sourceConfigFileName)
  validateOptionalDevelopmentConfigBoolean(localhost.mockData, "localhost.mockData", sourceConfigFileName)
  validateOptionalDatabaseConfig(localhost.database, sourceConfigFileName)
  validateOptionalPackagesConfig(localhost.packages, sourceConfigFileName)
  validateSiteAdminHttpUrl(localhost.httpOrigin, localhost.siteAdminHttpOrigin, sourceConfigFileName)

  return config
}

function validateOptionalPackagesConfig(packages, configFileName) {
  if (packages === undefined) return

  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    throw new Error(`В ${configFileName} localhost.packages должен быть объектом`)
  }

  Object.entries(packages).forEach(([packageId, packageConfig]) => {
    if (!/^(service|gateway|frontend):[a-z0-9-]+$/.test(packageId)) {
      throw new Error(`В ${configFileName} некорректный package id: ${packageId}`)
    }

    if (!packageConfig || typeof packageConfig !== "object" || Array.isArray(packageConfig)) {
      throw new Error(`В ${configFileName} localhost.packages.${packageId} должен быть объектом`)
    }

    if (packageConfig.url !== undefined) parseHttpUrl(packageConfig.url, `localhost.packages.${packageId}.url`, configFileName)
    validateOptionalEnvConfig(packageConfig.env, `localhost.packages.${packageId}.env`, configFileName)
  })
}

function validateOptionalEnvConfig(env, path, configFileName) {
  if (env === undefined) return

  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error(`В ${configFileName} ${path} должен быть объектом`)
  }

  Object.entries(env).forEach(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string" || /[\r\n]/.test(value)) {
      throw new Error(`В ${configFileName} ${path}.${key} должен быть строковой env-переменной`)
    }
  })
}

function validateSiteAdminHttpUrl(httpOriginValue, siteAdminHttpUrlValue, configFileName) {
  const httpOrigin = parseHttpUrl(httpOriginValue, "localhost.httpOrigin", configFileName)
  const siteAdminHttpUrl = parseHttpUrl(siteAdminHttpUrlValue, "localhost.siteAdminHttpOrigin", configFileName)
  const siteAdminHttpPath = normalizeHttpPath(siteAdminHttpUrl.pathname)

  if (siteAdminHttpUrl.origin !== httpOrigin.origin) {
    throw new Error(`В ${configFileName} localhost.siteAdminHttpOrigin должен использовать тот же origin, что и localhost.httpOrigin`)
  }

  if (siteAdminHttpPath === "/") {
    throw new Error(`В ${configFileName} localhost.siteAdminHttpOrigin должен содержать path внешней панели`)
  }

  if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(siteAdminHttpPath)) {
    throw new Error(`В ${configFileName} path localhost.siteAdminHttpOrigin содержит недопустимые символы`)
  }
}

function parseHttpUrl(value, path, configFileName) {
  let url

  try {
    url = new URL(value)
  } catch (error) {
    throw new Error(`В ${configFileName} ${path} должен быть абсолютным HTTP URL`)
  }

  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error(`В ${configFileName} ${path} должен быть абсолютным HTTP URL без credentials, query и hash`)
  }

  return url
}

function normalizeHttpPath(pathname) {
  return pathname === "/" ? "/" : pathname.replace(/\/+$/, "")
}

function validateRequiredDevelopmentConfigValue(value, path, configFileName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`В ${configFileName} должно быть задано строковое значение ${path}`)
  }
}

function validateOptionalDatabaseConfig(database, configFileName) {
  if (database === undefined) return

  if (!database || typeof database !== "object" || Array.isArray(database)) {
    throw new Error(`В ${configFileName} localhost.database должен быть объектом`)
  }

  if (database.dialect !== undefined && database.dialect !== "mysql" && database.dialect !== "postgres") {
    throw new Error(`В ${configFileName} localhost.database.dialect должен быть mysql или postgres`)
  }

  validateOptionalDevelopmentConfigString(database.host, "localhost.database.host", configFileName)
  validateOptionalDevelopmentConfigString(database.port, "localhost.database.port", configFileName)
  validateOptionalDevelopmentConfigString(database.serviceHost, "localhost.database.serviceHost", configFileName)
}

function validateOptionalDevelopmentConfigString(value, path, configFileName) {
  if (value !== undefined && (typeof value !== "string" || !value.trim())) {
    throw new Error(`В ${configFileName} должно быть задано строковое значение ${path}`)
  }
}

function validateOptionalDevelopmentConfigBoolean(value, path, configFileName) {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`В ${configFileName} должно быть задано boolean-значение ${path}`)
  }
}

function getLocalhostDatabaseConfig(developmentConfig) {
  return developmentConfig.localhost.database || {}
}

function getLocalhostDatabaseDialect(developmentConfig) {
  return getLocalhostDatabaseConfig(developmentConfig).dialect || defaultDatabaseDialect
}

function getLocalhostDatabaseHost(developmentConfig) {
  return getLocalhostDatabaseConfig(developmentConfig).host || defaultDatabaseHost
}

function getLocalhostDatabasePort(developmentConfig) {
  const dialect = getLocalhostDatabaseDialect(developmentConfig)
  return getLocalhostDatabaseConfig(developmentConfig).port || defaultDatabasePorts[dialect]
}

function getLocalhostDatabaseServiceHost(developmentConfig) {
  return getLocalhostDatabaseConfig(developmentConfig).serviceHost || defaultDatabaseServiceHost
}

function getLocalhostNoNginx(developmentConfig) {
  return developmentConfig.localhost.noNginx === true
}

function getLocalhostDebug(developmentConfig) {
  return developmentConfig.localhost.debug !== false
}

function getLocalhostMockData(developmentConfig) {
  return developmentConfig.localhost.mockData === true
}

function getLocalhostPackages(developmentConfig) {
  return developmentConfig.localhost.packages || {}
}

module.exports = {
  createProjectConfig
}
