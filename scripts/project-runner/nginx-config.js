const { X509Certificate } = require("crypto")
const { execFileSync } = require("child_process")
const { existsSync, readFileSync, readdirSync, statSync, writeFileSync } = require("fs")
const { join } = require("path")
const { getLocalhostPackagePort } = require("./package-config")

const apiTemplateFileName = "development.api.template.conf"
const frontendTemplateFileName = "development.frontend.template.conf"
const siteAdminTemplateFileName = "development.site-admin.template.conf"
const letsEncryptCertificateDirectory = "/etc/letsencrypt/live"
const certificateResolverExecutable = "/usr/local/bin/multi-site-certificates"
const letsEncryptOptionsPath = "/etc/letsencrypt/options-ssl-nginx.conf"
const letsEncryptDhParametersPath = "/etc/letsencrypt/ssl-dhparams.pem"

function writeDevelopmentNginxConfigFiles(config, localhostPackagePorts) {
  const frontendEndpoint = parseDevelopmentEndpoint(config.localhostHttpOrigin, "localhost.httpOrigin")
  const apiEndpoint = parseDevelopmentEndpoint(config.baseUrl, "localhost.baseUrl")

  validateDistinctEndpoints(frontendEndpoint, apiEndpoint)

  const frontendNginx = createEndpointNginxConfiguration(frontendEndpoint, "localhost.httpOrigin")
  const apiNginx = createEndpointNginxConfiguration(apiEndpoint, "localhost.baseUrl")

  writeNginxConfig(config, apiTemplateFileName, "development.api.conf", {
    FRONTEND_ALLOWED_ORIGIN: frontendEndpoint.origin,
    API_LISTEN_DIRECTIVE: apiNginx.listenDirective,
    API_SERVER_NAME: apiEndpoint.hostname,
    API_SSL_CONFIGURATION: apiNginx.sslConfiguration,
    API_HTTP_REDIRECT_SERVER: apiNginx.httpRedirectServer,
    AUTHORIZATION_GATEWAY_PORT: getLocalhostPackagePort(localhostPackagePorts, "gateway", "authorization"),
    CHAT_REALTIME_GATEWAY_PORT: getLocalhostPackagePort(localhostPackagePorts, "gateway", "chat-realtime"),
    FILES_GATEWAY_PORT: getLocalhostPackagePort(localhostPackagePorts, "gateway", "files"),
    INTERNAL_ADMIN_GATEWAY_PORT: getLocalhostPackagePort(localhostPackagePorts, "gateway", "internal-admin"),
    MAX_NAVIGATOR_GATEWAY_PORT: getLocalhostPackagePort(localhostPackagePorts, "gateway", "max-navigator"),
    EXTERNAL_ADMIN_GATEWAY_PORT: getLocalhostPackagePort(localhostPackagePorts, "gateway", "external-admin"),
    PUBLIC_GATEWAY_PORT: getLocalhostPackagePort(localhostPackagePorts, "gateway", "public")
  })

  writeNginxConfig(config, frontendTemplateFileName, "development.frontend.conf", {
    FRONTEND_LISTEN_DIRECTIVE: frontendNginx.listenDirective,
    FRONTEND_SERVER_NAME: frontendEndpoint.hostname,
    FRONTEND_SSL_CONFIGURATION: frontendNginx.sslConfiguration,
    FRONTEND_HTTP_REDIRECT_SERVER: frontendNginx.httpRedirectServer,
    FRONTEND_UPSTREAM_NAME: "boilerplate_frontend_dev",
    FRONTEND_UPSTREAM_PORT: config.localhostFrontendDevServerPort,
    SITE_ADMIN_PATH: config.localhostSiteAdminHttpPath,
    SITE_ADMIN_PATH_WITH_TRAILING_SLASH: `${config.localhostSiteAdminHttpPath}/`,
    SITE_ADMIN_UPSTREAM_NAME: "boilerplate_site_admin_dev",
    SITE_ADMIN_UPSTREAM_PORT: config.localhostSiteAdminDevServerPort
  })

  writeNginxConfig(config, siteAdminTemplateFileName, "development.site-admin.conf", {})
}

function parseDevelopmentEndpoint(value, configPath) {
  let url

  try {
    url = new URL(value)
  } catch (error) {
    throw new Error(`В development config значение ${configPath} должно быть абсолютным HTTP URL`)
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`В development config значение ${configPath} должно использовать протокол http или https`)
  }

  if (url.username || url.password) {
    throw new Error(`В development config значение ${configPath} не должно содержать credentials`)
  }

  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`В development config значение ${configPath} не должно содержать path, query или hash`)
  }

  return {
    hostname: url.hostname,
    listenPort: url.port || (url.protocol === "https:" ? "443" : "80"),
    protocol: url.protocol,
    origin: url.origin
  }
}

function createEndpointNginxConfiguration(
  endpoint,
  configPath,
  certificateResolver = resolveLetsEncryptCertificate,
  sslDefaultsResolver = resolveLetsEncryptNginxDefaults
) {
  if (endpoint.protocol !== "https:") {
    return {
      listenDirective: `listen ${endpoint.listenPort};`,
      sslConfiguration: "",
      httpRedirectServer: ""
    }
  }

  const certificate = certificateResolver([endpoint.hostname])
  if (!certificate) {
    console.warn(`Для ${configPath} не найден подходящий сертификат Let's Encrypt; ожидается внешнее завершение TLS`)
    return {
      listenDirective: `listen ${endpoint.listenPort === "443" ? "80" : endpoint.listenPort};`,
      sslConfiguration: "",
      httpRedirectServer: ""
    }
  }

  const sslDefaults = sslDefaultsResolver()
  const sslConfiguration = [
    `  ssl_certificate ${certificate.fullchainPath};`,
    `  ssl_certificate_key ${certificate.privateKeyPath};`
  ]

  if (sslDefaults) {
    sslConfiguration.push(
      `  include ${sslDefaults.optionsPath};`,
      `  ssl_dhparam ${sslDefaults.dhParametersPath};`
    )
  } else {
    sslConfiguration.push("  ssl_protocols TLSv1.2 TLSv1.3;")
  }

  return {
    listenDirective: `listen ${endpoint.listenPort} ssl;`,
    sslConfiguration: sslConfiguration.join("\n"),
    httpRedirectServer: endpoint.listenPort === "80" ? "" : [
      "",
      "server {",
      "  listen 80;",
      `  server_name ${endpoint.hostname};`,
      `  return 308 ${endpoint.origin}$request_uri;`,
      "}"
    ].join("\n")
  }
}

function resolveLetsEncryptNginxDefaults() {
  if (!existsSync(letsEncryptOptionsPath) || !existsSync(letsEncryptDhParametersPath)) return null

  return {
    optionsPath: letsEncryptOptionsPath,
    dhParametersPath: letsEncryptDhParametersPath
  }
}

function resolveLetsEncryptCertificate(hostnames) {
  return findReadableLetsEncryptCertificate(hostnames) || resolveLetsEncryptCertificateWithHelper(hostnames)
}

function findReadableLetsEncryptCertificate(hostnames) {
  let certificateNames

  try {
    certificateNames = readdirSync(letsEncryptCertificateDirectory).sort()
  } catch (error) {
    return null
  }

  for (const certificateName of certificateNames) {
    if (!/^[A-Za-z0-9.-]+$/.test(certificateName)) continue

    const fullchainPath = join(letsEncryptCertificateDirectory, certificateName, "fullchain.pem")
    const privateKeyPath = join(letsEncryptCertificateDirectory, certificateName, "privkey.pem")

    try {
      const certificate = new X509Certificate(readFileSync(fullchainPath))
      statSync(privateKeyPath)
      const now = Date.now()
      if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) continue
      if (!hostnames.every((hostname) => certificate.checkHost(hostname))) continue

      return { fullchainPath, privateKeyPath }
    } catch (error) {
      continue
    }
  }

  return null
}

function resolveLetsEncryptCertificateWithHelper(hostnames) {
  if (!existsSync(certificateResolverExecutable)) return null

  let output
  try {
    output = execFileSync(certificateResolverExecutable, hostnames, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"]
    })
  } catch (error) {
    if (error && error.status !== 2) {
      console.warn(`Не удалось проверить сертификаты Let's Encrypt через ${certificateResolverExecutable}`)
    }
    return null
  }

  const [fullchainPath, privateKeyPath, ...unexpectedLines] = output.trim().split(/\r?\n/)
  if (unexpectedLines.length || !isSafeCertificatePath(fullchainPath, "fullchain.pem") || !isSafeCertificatePath(privateKeyPath, "privkey.pem")) {
    console.warn(`Получен некорректный ответ от ${certificateResolverExecutable}`)
    return null
  }

  const fullchainDirectory = fullchainPath.slice(0, -"/fullchain.pem".length)
  const privateKeyDirectory = privateKeyPath.slice(0, -"/privkey.pem".length)
  if (fullchainDirectory !== privateKeyDirectory) return null

  return { fullchainPath, privateKeyPath }
}

function isSafeCertificatePath(value, fileName) {
  return (
    typeof value === "string" &&
    /^\/etc\/letsencrypt\/live\/[A-Za-z0-9.-]+\/[A-Za-z0-9.-]+$/.test(value) &&
    value.endsWith(`/${fileName}`)
  )
}

function validateDistinctEndpoints(frontendEndpoint, apiEndpoint) {
  if (frontendEndpoint.hostname === apiEndpoint.hostname && frontendEndpoint.listenPort === apiEndpoint.listenPort) {
    throw new Error("localhost.httpOrigin и localhost.baseUrl должны использовать разные hostname или port для раздельных nginx server blocks")
  }
}

function writeNginxConfig(config, templateFileName, outputFileName, values) {
  const templatePath = join(config.nginxDirectory, templateFileName)
  const outputPath = join(config.nginxDirectory, outputFileName)
  const template = readFileSync(templatePath, "utf-8")
  const output = Object.entries(values).reduce(
    (result, [key, value]) => result.split(`{{${key}}}`).join(String(value)),
    template
  )

  const unresolvedPlaceholder = output.match(/\{\{[A-Z0-9_]+\}\}/)
  if (unresolvedPlaceholder) {
    throw new Error(`Не задано значение nginx template placeholder ${unresolvedPlaceholder[0]} в ${templatePath}`)
  }

  writeFileSync(outputPath, output, "utf-8")
  console.log(`Сгенерирован nginx config: ${outputPath}`)
}

module.exports = {
  createEndpointNginxConfiguration,
  parseDevelopmentEndpoint,
  writeDevelopmentNginxConfigFiles
}
