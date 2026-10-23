const { existsSync, readFileSync, writeFileSync } = require("fs")
const { join } = require("path")

function getPackageLocalEnv(packageDirectory, scriptName) {
  const envFileName = getPackageLocalEnvFileName(scriptName)
  const envFilePath = join(packageDirectory, envFileName)

  if (!existsSync(envFilePath)) return process.env

  return {
    ...process.env,
    ...parseEnvFile(readFileSync(envFilePath, "utf-8"))
  }
}

function getPackageLocalEnvFileName(scriptName) {
  if (
    process.env.NODE_ENV === "production" ||
    scriptName === "build" ||
    scriptName === "start:dist" ||
    scriptName.endsWith(":dist")
  ) {
    return ".prod.env"
  }

  return ".dev.env"
}

function parseEnvFile(data) {
  return data
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row && !row.startsWith("#"))
    .reduce((env, row) => {
      const separatorIndex = row.indexOf("=")
      if (separatorIndex === -1) return env

      const key = row.slice(0, separatorIndex).trim()
      const value = row.slice(separatorIndex + 1).trim()

      if (key) env[key] = value
      return env
    }, {})
}

function writeEnvFile(packageDirectory, envFileName, values, environmentName) {
  const envFilePath = join(packageDirectory, envFileName)
  const data = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")

  writeFileSync(envFilePath, `${data}\n`, "utf-8")
  console.log(`Сгенерирован ${environmentName} env: ${envFilePath}`)
}

function writeDevelopmentEnvFile(packageDirectory, values) {
  writeEnvFile(packageDirectory, ".dev.env", values, "development")
}

function writeProductionEnvFile(packageDirectory, values) {
  writeEnvFile(packageDirectory, ".prod.env", values, "production")
}

function updateEnvFile(data, nextValues) {
  const pendingKeys = new Set(Object.keys(nextValues))
  const lines = data.split(/\r?\n/)
  const updatedLines = lines.map((line) => {
    const separatorIndex = line.indexOf("=")
    if (separatorIndex === -1) return line

    const key = line.slice(0, separatorIndex).trim()
    if (!pendingKeys.has(key) || typeof nextValues[key] !== "string") return line

    pendingKeys.delete(key)
    return `${key}=${nextValues[key]}`
  })

  pendingKeys.forEach((key) => {
    if (typeof nextValues[key] === "string") updatedLines.push(`${key}=${nextValues[key]}`)
  })

  return updatedLines.join("\n")
}

module.exports = {
  getPackageLocalEnv,
  parseEnvFile,
  updateEnvFile,
  writeDevelopmentEnvFile,
  writeProductionEnvFile
}
