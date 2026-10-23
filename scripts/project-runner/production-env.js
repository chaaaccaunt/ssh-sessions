const { existsSync, readFileSync } = require("fs")
const { isAbsolute, join, resolve } = require("path")
const { getRuntimePackageUid } = require("./package-config")
const { writeProductionEnvFile } = require("./env-files")

function writeProductionEnvFiles(context, target, configPathArgument) {
  const source = readProductionConfig(context.config, configPathArgument)
  const targets = getProductionTargets(context, target)

  const envFiles = targets.map((packageTarget) => {
    const packageId = `${packageTarget.kind}:${packageTarget.name}`
    const packageConfig = getRequiredPackageConfig(source.config, packageId, source.fileName)
    const values = packageTarget.kind === "frontend"
      ? packageConfig.env
      : createBackendProductionEnv(context.config, source.config, packageTarget, packageConfig, source.fileName)

    validateProductionEnv(values, packageId, source.fileName)
    return { packageDirectory: packageTarget.directory, values }
  })

  envFiles.forEach((envFile) => {
    writeProductionEnvFile(envFile.packageDirectory, envFile.values)
  })
}

function readProductionConfig(config, configPathArgument) {
  const configPath = configPathArgument
    ? (isAbsolute(configPathArgument) ? configPathArgument : resolve(config.rootDirectory, configPathArgument))
    : join(config.rootDirectory, config.rootProductionConfigFileName)

  if (!existsSync(configPath)) {
    throw new Error(`Не найден production config: ${configPath}. Создайте его по примеру ${config.rootProductionConfigExampleFileName}`)
  }

  let productionConfig

  try {
    productionConfig = JSON.parse(readFileSync(configPath, "utf-8"))
  } catch (error) {
    throw new Error(`Некорректный JSON в production config: ${configPath}`)
  }

  if (!productionConfig || typeof productionConfig !== "object" || Array.isArray(productionConfig)) {
    throw new Error(`Production config должен быть объектом: ${configPath}`)
  }

  validateEnvObject(productionConfig.commonBackendEnv, "commonBackendEnv", configPath)

  if (!productionConfig.packages || typeof productionConfig.packages !== "object" || Array.isArray(productionConfig.packages)) {
    throw new Error(`В ${configPath} должен быть объект packages`)
  }

  return {
    config: productionConfig,
    fileName: configPath
  }
}

function getProductionTargets(context, target) {
  if (target.kind === "all") {
    return [
      ...Array.from(context.workspaces.serviceWorkspaceNames, ([name, workspaceName]) => createTarget(context, "service", name, workspaceName)),
      ...Array.from(context.workspaces.gatewayWorkspaceNames, ([name, workspaceName]) => createTarget(context, "gateway", name, workspaceName)),
      ...Array.from(context.workspaces.frontendWorkspaceNames, ([name, workspaceName]) => createTarget(context, "frontend", name, workspaceName))
    ]
  }

  const workspaceName = target.kind === "service"
    ? context.workspaces.getServiceWorkspaceName(target.name)
    : target.kind === "gateway"
      ? context.workspaces.getGatewayWorkspaceName(target.name)
      : context.workspaces.getFrontendWorkspaceName(target.name)

  return [createTarget(context, target.kind, target.name, workspaceName)]
}

function createTarget(context, kind, name, workspaceName) {
  return {
    kind,
    name,
    directory: context.workspaces.getWorkspaceDirectory(workspaceName)
  }
}

function getRequiredPackageConfig(productionConfig, packageId, fileName) {
  const packageConfig = productionConfig.packages[packageId]

  if (!packageConfig || typeof packageConfig !== "object" || Array.isArray(packageConfig)) {
    throw new Error(`В ${fileName} не настроен packages.${packageId}`)
  }

  validateEnvObject(packageConfig.env, `packages.${packageId}.env`, fileName)

  if (!packageId.startsWith("frontend:") && packageId !== "service:database-migration") {
    validatePackageUrl(packageConfig.url, `packages.${packageId}.url`, fileName)
  } else if (packageConfig.url !== undefined) {
    validatePackageUrl(packageConfig.url, `packages.${packageId}.url`, fileName)
  }

  return packageConfig
}

function validatePackageUrl(value, path, fileName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`В ${fileName} должно быть задано ${path}`)
  }

  let url

  try {
    url = new URL(value)
  } catch (error) {
    throw new Error(`В ${fileName} ${path} должен быть абсолютным HTTP URL`)
  }

  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error(`В ${fileName} ${path} должен быть абсолютным HTTP URL без credentials, query и hash`)
  }
}

function validateEnvObject(env, path, fileName) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error(`В ${fileName} ${path} должен быть объектом`)
  }

  Object.entries(env).forEach(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string" || /[\r\n]/.test(value)) {
      throw new Error(`В ${fileName} ${path}.${key} должен быть строковой env-переменной`)
    }
  })
}

function createBackendProductionEnv(projectConfig, productionConfig, target, packageConfig, fileName) {
  const packageId = `${target.kind}:${target.name}`
  const packageUid = target.kind === "service" && target.name === "database-migration"
    ? {}
    : { VAR_PACKAGE_UID: getRuntimePackageUid(projectConfig, target.kind, target.name) }

  return {
    ...productionConfig.commonBackendEnv,
    ...packageUid,
    ...createProductionDependencyEnv(productionConfig, packageId, fileName),
    ...packageConfig.env
  }
}

function createProductionDependencyEnv(productionConfig, packageId, fileName) {
  const url = (dependencyId) => getRequiredDependencyUrl(productionConfig, dependencyId, packageId, fileName)

  const dependencies = {
    "service:cms": () => ({ VAR_REGIONAL_NAVIGATOR_SERVICE_URL: url("service:regional-navigator") }),
    "service:log-collector": () => ({ VAR_CHAT_REALTIME_GATEWAY_URL: url("gateway:chat-realtime") }),
    "service:notifications": () => ({ VAR_CHAT_REALTIME_GATEWAY_URL: url("gateway:chat-realtime") }),
    "service:provisioning": () => ({
      VAR_CMS_SERVICE_URL: url("service:cms"),
      VAR_PROVISIONING_PUBLIC_RENDERER_URL: url("gateway:public-renderer"),
      VAR_PROVISIONING_AUTHORIZATION_GATEWAY_URL: url("gateway:authorization"),
      VAR_PROVISIONING_FILES_GATEWAY_URL: url("gateway:files"),
      VAR_PROVISIONING_EXTERNAL_ADMIN_GATEWAY_URL: url("gateway:external-admin")
    }),
    "gateway:authorization": () => ({ VAR_NOTIFICATIONS_SERVICE_URL: url("service:notifications") }),
    "gateway:chat-realtime": () => ({ VAR_CHAT_SERVICE_URL: url("service:chat") }),
    "gateway:external-admin": () => ({ VAR_CMS_SERVICE_URL: url("service:cms") }),
    "gateway:files": () => ({ VAR_CHAT_REALTIME_GATEWAY_URL: url("gateway:chat-realtime") }),
    "gateway:internal-admin": () => ({
      VAR_CMS_SERVICE_URL: url("service:cms"),
      VAR_PROVISIONING_SERVICE_URL: url("service:provisioning"),
      VAR_REGIONAL_NAVIGATOR_SERVICE_URL: url("service:regional-navigator")
    }),
    "gateway:max-navigator": () => ({ VAR_REGIONAL_NAVIGATOR_SERVICE_URL: url("service:regional-navigator") }),
    "gateway:public": () => ({
      VAR_USERS_SERVICE_URL: url("service:users"),
      VAR_CHAT_SERVICE_URL: url("service:chat"),
      VAR_LOG_COLLECTOR_SERVICE_URL: url("service:log-collector"),
      VAR_NOTIFICATIONS_SERVICE_URL: url("service:notifications")
    })
  }

  return dependencies[packageId]?.() || {}
}

function getRequiredDependencyUrl(productionConfig, dependencyId, consumerId, fileName) {
  const dependencyConfig = productionConfig.packages[dependencyId]
  if (!dependencyConfig) throw new Error(`В ${fileName} не настроен dependency ${dependencyId} для ${consumerId}`)

  validatePackageUrl(dependencyConfig.url, `packages.${dependencyId}.url`, fileName)
  return dependencyConfig.url
}

function validateProductionEnv(values, packageId, fileName) {
  Object.entries(values).forEach(([key, value]) => {
    if (!value.trim() || value === "УкажитеЗначение" || value.includes("CHANGE_ME")) {
      throw new Error(`В ${fileName} не заполнено packages.${packageId}: ${key}`)
    }
  })
}

module.exports = {
  writeProductionEnvFiles
}
