export const HOST_KEY_POLICIES = ["ask", "accept-new", "strict"] as const

export type HostKeyPolicy = (typeof HOST_KEY_POLICIES)[number]

export type SecretProvider = () => Promise<Uint8Array>

export interface SshConfigAuthStrategy {
  readonly kind: "ssh-config"
}

export interface PasswordAuthStrategy {
  readonly kind: "password"
  readonly user: string
  readonly getPassword: SecretProvider
}

export interface KeyAuthStrategy {
  readonly kind: "key"
  readonly user: string
  readonly keyName: string
  readonly getPassphrase?: SecretProvider
}

export type AuthStrategy =
  | SshConfigAuthStrategy
  | PasswordAuthStrategy
  | KeyAuthStrategy

export interface ConnectionTarget {
  readonly host: string
  readonly port?: number
  readonly configFile?: string
}

export interface ConnectionRequestInput {
  readonly target: ConnectionTarget
  readonly auth: AuthStrategy
  readonly hostKeyPolicy?: HostKeyPolicy
  readonly connectTimeoutMs?: number
  readonly overallTimeoutMs?: number
}

export interface ConnectionRequest {
  readonly target: ConnectionTarget
  readonly auth: AuthStrategy
  readonly hostKeyPolicy: HostKeyPolicy
  readonly connectTimeoutMs?: number
  readonly overallTimeoutMs?: number
}
