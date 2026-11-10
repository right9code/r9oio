import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  deleteProviderKey,
  hasStoredKey,
  loadProviderKey,
  saveProviderKey,
} from '../../services/api/auth/api_key_manager.js'
import { openBrowser } from '../browser.js'

export const E2B_DASHBOARD_URL = 'https://e2b.dev/dashboard?tab=keys'

export const E2B_SECURITY_PROVIDER = 'e2b-security' as const
export const E2B_SECURITY_DISPLAY_NAME = 'E2B Security'

const E2B_ACCESS_TOKEN_KEY = 'e2b-security_access_token'
const E2B_CLI_CONFIG_PATH = join(homedir(), '.e2b', 'config.json')

export type E2BSecurityAuth = {
  apiKey?: string
  accessToken?: string
  source:
    | 'environment'
    | 'stored'
    | 'e2b-cli-config'
    | 'environment+stored'
    | 'environment+e2b-cli-config'
    | 'stored+e2b-cli-config'
    | 'mixed'
    | 'missing'
}

export function saveE2BSecurityCredential(secret: string): void {
  const trimmed = secret.trim()
  if (!trimmed) return

  if (looksLikeAccessToken(trimmed)) {
    saveE2BSecurityAccessToken(trimmed)
    return
  }

  saveE2BSecurityApiKey(trimmed)
}

export function saveE2BSecurityApiKey(secret: string): void {
  const trimmed = secret.trim()
  if (!trimmed) return
  saveProviderKey(E2B_SECURITY_PROVIDER, trimmed)
  deleteProviderKey(E2B_ACCESS_TOKEN_KEY)
}

export function saveE2BSecurityAccessToken(secret: string): void {
  const trimmed = secret.trim()
  if (!trimmed) return
  saveProviderKey(E2B_ACCESS_TOKEN_KEY, trimmed)
  deleteProviderKey(E2B_SECURITY_PROVIDER)
}

export function clearE2BSecurityCredentials(): void {
  deleteProviderKey(E2B_SECURITY_PROVIDER)
  deleteProviderKey(E2B_ACCESS_TOKEN_KEY)
}

export function openE2BDashboardInBrowser(): Promise<boolean> {
  return openBrowser(E2B_DASHBOARD_URL)
}

export function hasStoredE2BSecurityCredential(): boolean {
  return hasStoredKey(E2B_SECURITY_PROVIDER) || hasStoredKey(E2B_ACCESS_TOKEN_KEY)
}

export function getE2BSecurityAuth(): E2BSecurityAuth {
  const envAuth = {
    apiKey: process.env.E2B_API_KEY,
    accessToken: process.env.E2B_ACCESS_TOKEN,
  }
  const storedAuth = {
    apiKey: loadProviderKey(E2B_SECURITY_PROVIDER) ?? undefined,
    accessToken: loadProviderKey(E2B_ACCESS_TOKEN_KEY) ?? undefined,
  }
  const cliAuth = readE2BCliAuth()

  const apiKey = envAuth.apiKey ?? storedAuth.apiKey ?? cliAuth.apiKey
  const accessToken =
    envAuth.accessToken ?? storedAuth.accessToken ?? cliAuth.accessToken

  if (!apiKey && !accessToken) {
    return { source: 'missing' }
  }

  const sources = new Set<string>()
  if (envAuth.apiKey || envAuth.accessToken) sources.add('environment')
  if (storedAuth.apiKey || storedAuth.accessToken) sources.add('stored')
  if (cliAuth.apiKey || cliAuth.accessToken) sources.add('e2b-cli-config')

  const sourceText = [...sources].join('+')
  const source = isKnownAuthSource(sourceText) ? sourceText : 'mixed'
  return {
    apiKey,
    accessToken,
    source: source || 'mixed',
  }
}

function isKnownAuthSource(value: string): value is E2BSecurityAuth['source'] {
  return [
    'environment',
    'stored',
    'e2b-cli-config',
    'environment+stored',
    'environment+e2b-cli-config',
    'stored+e2b-cli-config',
    'mixed',
    'missing',
  ].includes(value)
}

export function hasE2BSecurityAuth(): boolean {
  const auth = getE2BSecurityAuth()
  return Boolean(auth.apiKey || auth.accessToken)
}

export function getE2BSecurityStatusLines(): string[] {
  const auth = getE2BSecurityAuth()
  const stored = hasStoredE2BSecurityCredential()
  const cli = readE2BCliAuth()

  return [
    `E2B auth: ${auth.source === 'missing' ? 'missing' : 'available'}`,
    `Source: ${formatSource(auth.source)}`,
    `E2B_API_KEY: ${auth.apiKey ? redactSecret(auth.apiKey) : 'missing'}`,
    `E2B_ACCESS_TOKEN: ${
      auth.accessToken ? redactSecret(auth.accessToken) : 'missing'
    }`,
    `Stored credential: ${stored ? 'yes' : 'no'}`,
    `E2B CLI config: ${
      cli.apiKey || cli.accessToken ? `found at ${E2B_CLI_CONFIG_PATH}` : 'not found'
    }`,
  ]
}

export function formatE2BSecurityBadge(): string {
  const auth = getE2BSecurityAuth()
  if (auth.source === 'missing') return '[   -   ]'
  if (auth.source === 'stored') return '[API Key saved]'
  if (auth.source === 'e2b-cli-config') return '[CLI auth]'
  if (auth.source.startsWith('environment')) return '[Env auth]'
  return '[Auth ready]'
}

function readE2BCliAuth(): { apiKey?: string; accessToken?: string } {
  if (!existsSync(E2B_CLI_CONFIG_PATH)) return {}

  try {
    const parsed = JSON.parse(readFileSync(E2B_CLI_CONFIG_PATH, 'utf8')) as {
      teamApiKey?: string
      apiKey?: string
      accessToken?: string
    }
    return {
      apiKey: parsed.teamApiKey ?? parsed.apiKey,
      accessToken: parsed.accessToken,
    }
  } catch {
    return {}
  }
}

function looksLikeAccessToken(secret: string): boolean {
  return (
    secret.startsWith('sk_') ||
    secret.startsWith('sk-') ||
    secret.toLowerCase().includes('access_token')
  )
}

function formatSource(source: E2BSecurityAuth['source']): string {
  switch (source) {
    case 'missing':
      return 'missing'
    case 'environment':
      return 'environment variables'
    case 'stored':
      return 'Tau stored credential'
    case 'e2b-cli-config':
      return 'E2B CLI config'
    case 'environment+stored':
      return 'environment variables + Tau stored credential'
    case 'environment+e2b-cli-config':
      return 'environment variables + E2B CLI config'
    case 'stored+e2b-cli-config':
      return 'Tau stored credential + E2B CLI config'
    case 'mixed':
      return 'mixed sources'
  }
}

function redactSecret(value: string): string {
  if (value.length <= 8) return 'set'
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}
