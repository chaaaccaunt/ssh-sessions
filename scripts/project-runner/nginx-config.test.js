const assert = require("node:assert/strict")
const test = require("node:test")
const { createEndpointNginxConfiguration, parseDevelopmentEndpoint } = require("./nginx-config")

test("HTTPS endpoint uses a suitable Let's Encrypt certificate", () => {
  const endpoint = parseDevelopmentEndpoint("https://api.example.test", "test.endpoint")
  const configuration = createEndpointNginxConfiguration(
    endpoint,
    "test.endpoint",
    (hostnames) => {
      assert.deepEqual(hostnames, ["api.example.test"])
      return {
        fullchainPath: "/etc/letsencrypt/live/example.test/fullchain.pem",
        privateKeyPath: "/etc/letsencrypt/live/example.test/privkey.pem"
      }
    },
    () => ({
      optionsPath: "/etc/letsencrypt/options-ssl-nginx.conf",
      dhParametersPath: "/etc/letsencrypt/ssl-dhparams.pem"
    })
  )

  assert.equal(configuration.listenDirective, "listen 443 ssl;")
  assert.match(configuration.sslConfiguration, /ssl_certificate \/etc\/letsencrypt\/live\/example\.test\/fullchain\.pem;/)
  assert.match(configuration.sslConfiguration, /include \/etc\/letsencrypt\/options-ssl-nginx\.conf;/)
  assert.match(configuration.sslConfiguration, /ssl_dhparam \/etc\/letsencrypt\/ssl-dhparams\.pem;/)
  assert.match(configuration.httpRedirectServer, /return 308 https:\/\/api\.example\.test\$request_uri;/)
})

test("HTTP endpoint does not resolve or configure a certificate", () => {
  const endpoint = parseDevelopmentEndpoint("http://example.test:8080", "test.endpoint")
  const configuration = createEndpointNginxConfiguration(endpoint, "test.endpoint", () => {
    throw new Error("Certificate resolver must not be called for HTTP")
  })

  assert.equal(configuration.listenDirective, "listen 8080;")
  assert.equal(configuration.sslConfiguration, "")
  assert.equal(configuration.httpRedirectServer, "")
})

test("HTTPS endpoint without a certificate keeps external TLS termination", () => {
  const endpoint = parseDevelopmentEndpoint("https://example.test", "test.endpoint")
  const originalWarn = console.warn
  console.warn = () => undefined

  try {
    const configuration = createEndpointNginxConfiguration(endpoint, "test.endpoint", () => null)
    assert.equal(configuration.listenDirective, "listen 80;")
    assert.equal(configuration.sslConfiguration, "")
    assert.equal(configuration.httpRedirectServer, "")
  } finally {
    console.warn = originalWarn
  }
})
