/**
 * Host-side GitHub authentication manager (OAuth Device Flow + local CLI import).
 *
 * Cooperates with the optional `dsh-connectors` plugin when mounted via
 * `ctx.get('connectors')`, delegating Device Flow and SSO/local import to it.
 * When `dsh-connectors` is absent, provides a compact proxy-aware Device Flow
 * and `gh auth token` fallback storing credentials via `setGitHubToken`.
 *
 * Security: `device_code` and access tokens are kept strictly in Host memory /
 * credential store and are never returned to the browser.
 *
 * @module dsh-task-board-github/host/auth
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type {
  GitHubDeviceFlowPollResult,
  GitHubDeviceFlowStart,
  GitHubLocalAuthImportResult,
  GitHubProxyMode,
  GitHubSetupSummary,
} from '../core/setup.ts'
import { setGitHubToken } from './credentials.ts'
import { createProxyFetch, resolveProxyConfiguration } from './proxy.ts'

const execFileAsync = promisify(execFile)

export const DEFAULT_GITHUB_OAUTH_CLIENT_ID = 'Iv1.b507a08c87ecfe98'
export const DEFAULT_GITHUB_OAUTH_SCOPES = 'repo read:org read:user project'

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
const GITHUB_OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token'

/** Narrow structural face of `dsh-connectors` when mounted on `ctx.get('connectors')`. */
export interface ConnectorsGitHubFace {
  startGitHubDevice(options?: { clientId?: string; scopes?: string[] }): Promise<{
    flowId?: string
    deviceCode?: string
    userCode: string
    verificationUri: string
    verificationUriComplete?: string
    expiresIn: number
    interval: number
  }>
  pollGitHubDevice(input: { flowId?: string; deviceCode?: string; clientId?: string }): Promise<{
    status: 'pending' | 'authorized' | 'expired' | 'denied' | 'error'
    interval?: number
    accessToken?: string
    login?: string
    scopes?: string[]
    message?: string
  }>
  importGitHubSso?(): Promise<{
    ok: boolean
    login?: string
    scopes?: string[]
    message?: string
  }>
}

interface DeviceFlowEntry {
  flowId: string
  clientId: string
  deviceCode?: string
  connectorFlowId?: string
  delegated: boolean
  expiresAt: number
  interval: number
}

export interface GitHubAuthManagerOptions {
  ctx: Context
  tokenEnv(): string
  oauthClientId?(): string | undefined
  env?: Record<string, string | undefined>
  proxyMode?(): GitHubProxyMode
  proxyUrl?(): string
  detectSystemProxy?(): string | undefined
  authFetchFor?(): typeof fetch
  readCliToken?(): Promise<string | undefined>
  now?(): number
  onAuthorized(): Promise<GitHubSetupSummary>
  verifyToken?(token: string): Promise<{ login?: string; scopes?: string[] }>
}

export interface GitHubAuthManager {
  startDeviceAuth(options?: { clientId?: string; scopes?: string[] }): Promise<GitHubDeviceFlowStart>
  pollDeviceAuth(flowId: string): Promise<GitHubDeviceFlowPollResult>
  cancelDeviceAuth(flowId: string): boolean
  importLocalAuth(): Promise<GitHubLocalAuthImportResult>
}

/** Probe optional `dsh-connectors` service from context without requiring it. */
export function resolveConnectorsGitHubFace(ctx: Context): ConnectorsGitHubFace | undefined {
  try {
    const get = (ctx as { get?: (name: string) => unknown }).get
    if (typeof get !== 'function') return undefined
    const face = get.call(ctx, 'connectors') as ConnectorsGitHubFace | undefined
    if (face === undefined || face === null) return undefined
    return typeof face.startGitHubDevice === 'function' && typeof face.pollGitHubDevice === 'function'
      ? face
      : undefined
  } catch {
    return undefined
  }
}

async function defaultReadCliToken(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 5_000 })
    const token = stdout.trim()
    return token === '' ? undefined : token
  } catch {
    return undefined
  }
}

/** Build the Host-side GitHub authentication manager. */
export function createGitHubAuthManager(options: GitHubAuthManagerOptions): GitHubAuthManager {
  const flows = new Map<string, DeviceFlowEntry>()
  const env = options.env ?? process.env
  const now = options.now ?? (() => Date.now())

  const resolveAuthFetch = (): typeof fetch => {
    if (options.authFetchFor !== undefined) return options.authFetchFor()
    const resolved = resolveProxyConfiguration(GITHUB_DEVICE_CODE_URL, {
      mode: options.proxyMode?.() ?? 'auto',
      customUrl: options.proxyUrl?.() ?? '',
      env,
      ...(options.detectSystemProxy === undefined ? {} : { detect: options.detectSystemProxy }),
    })
    return resolved.url === undefined ? globalThis.fetch : createProxyFetch(resolved.url)
  }

  const effectiveClientId = (override?: string): string => {
    const trimmed = override?.trim()
    if (trimmed !== undefined && trimmed !== '') return trimmed
    const configured = options.oauthClientId?.()?.trim()
    if (configured !== undefined && configured !== '') return configured
    return DEFAULT_GITHUB_OAUTH_CLIENT_ID
  }

  const startDeviceAuth = async (reqOptions?: { clientId?: string; scopes?: string[] }): Promise<GitHubDeviceFlowStart> => {
    const connectors = resolveConnectorsGitHubFace(options.ctx)
    const clientId = effectiveClientId(reqOptions?.clientId)
    const scopes = reqOptions?.scopes && reqOptions.scopes.length > 0
      ? reqOptions.scopes
      : DEFAULT_GITHUB_OAUTH_SCOPES.split(' ')

    if (connectors !== undefined) {
      const started = await connectors.startGitHubDevice({ clientId, scopes })
      const flowId = randomUUID()
      flows.set(flowId, {
        flowId,
        clientId,
        delegated: true,
        ...(started.flowId !== undefined ? { connectorFlowId: started.flowId } : {}),
        ...(started.deviceCode !== undefined ? { deviceCode: started.deviceCode } : {}),
        expiresAt: now() + started.expiresIn * 1000,
        interval: started.interval,
      })
      return {
        flowId,
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        ...(started.verificationUriComplete !== undefined ? { verificationUriComplete: started.verificationUriComplete } : {}),
        expiresIn: started.expiresIn,
        interval: started.interval,
      }
    }

    const fetchImpl = resolveAuthFetch()
    const body = new URLSearchParams({
      client_id: clientId,
      scope: scopes.join(' '),
    })
    const response = await fetchImpl(GITHUB_DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })
    if (!response.ok) {
      throw new Error(`GitHub device flow start failed (${String(response.status)})`)
    }
    const data = await response.json() as {
      device_code?: string
      user_code?: string
      verification_uri?: string
      verification_uri_complete?: string
      expires_in?: number
      interval?: number
      error?: string
      error_description?: string
    }
    if (data.error || !data.device_code || !data.user_code || !data.verification_uri) {
      throw new Error(data.error_description ?? data.error ?? 'GitHub device flow returned an invalid response')
    }

    const flowId = randomUUID()
    const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 900
    const interval = typeof data.interval === 'number' && data.interval > 0 ? data.interval : 5
    flows.set(flowId, {
      flowId,
      clientId,
      deviceCode: data.device_code,
      delegated: false,
      expiresAt: now() + expiresIn * 1000,
      interval,
    })
    return {
      flowId,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      ...(data.verification_uri_complete !== undefined ? { verificationUriComplete: data.verification_uri_complete } : {}),
      expiresIn,
      interval,
    }
  }

  const pollDeviceAuth = async (flowId: string): Promise<GitHubDeviceFlowPollResult> => {
    const entry = flows.get(flowId)
    if (entry === undefined) {
      return { status: 'cancelled', message: 'device flow was cancelled or not found' }
    }
    if (now() >= entry.expiresAt) {
      flows.delete(flowId)
      return { status: 'expired', message: 'device authorization code expired' }
    }

    if (entry.delegated) {
      const connectors = resolveConnectorsGitHubFace(options.ctx)
      if (connectors === undefined) {
        flows.delete(flowId)
        return { status: 'error', message: 'dsh-connectors service became unavailable' }
      }
      const polled = await connectors.pollGitHubDevice({
        ...(entry.connectorFlowId !== undefined ? { flowId: entry.connectorFlowId } : {}),
        ...(entry.deviceCode !== undefined ? { deviceCode: entry.deviceCode } : {}),
        clientId: entry.clientId,
      })
      if (polled.status === 'pending') {
        if (typeof polled.interval === 'number' && polled.interval > 0) entry.interval = polled.interval
        return { status: 'pending', interval: entry.interval }
      }
      flows.delete(flowId)
      if (polled.status === 'authorized') {
        if (typeof polled.accessToken === 'string' && polled.accessToken.trim() !== '') {
          await setGitHubToken(options.ctx, options.tokenEnv(), polled.accessToken.trim())
        }
        const summary = await options.onAuthorized()
        return {
          status: 'authorized',
          ...(polled.login !== undefined ? { login: polled.login } : {}),
          ...(polled.scopes !== undefined ? { scopes: polled.scopes } : {}),
          summary,
        }
      }
      return {
        status: polled.status,
        message: polled.message ?? `GitHub authorization ${polled.status}`,
      }
    }

    const fetchImpl = resolveAuthFetch()
    const body = new URLSearchParams({
      client_id: entry.clientId,
      device_code: entry.deviceCode ?? '',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    const response = await fetchImpl(GITHUB_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })
    if (!response.ok) {
      return { status: 'error', message: `GitHub token poll failed (${String(response.status)})` }
    }
    const data = await response.json() as {
      access_token?: string
      scope?: string
      error?: string
      error_description?: string
      interval?: number
    }

    if (data.error === 'authorization_pending') {
      return { status: 'pending', interval: entry.interval }
    }
    if (data.error === 'slow_down') {
      entry.interval = typeof data.interval === 'number' && data.interval > entry.interval
        ? data.interval
        : entry.interval + 5
      return { status: 'pending', interval: entry.interval }
    }
    if (data.error === 'expired_token') {
      flows.delete(flowId)
      return { status: 'expired', message: data.error_description ?? 'device authorization code expired' }
    }
    if (data.error === 'access_denied') {
      flows.delete(flowId)
      return { status: 'denied', message: data.error_description ?? 'authorization was denied by the user' }
    }
    if (data.error || !data.access_token) {
      flows.delete(flowId)
      return { status: 'error', message: data.error_description ?? data.error ?? 'unexpected OAuth response' }
    }

    flows.delete(flowId)
    const token = data.access_token.trim()
    await setGitHubToken(options.ctx, options.tokenEnv(), token)
    const verified = options.verifyToken ? await options.verifyToken(token) : {}
    const parsedScopes = typeof data.scope === 'string' && data.scope.trim() !== ''
      ? data.scope.split(/[\s,]+/).filter(Boolean)
      : verified.scopes
    const summary = await options.onAuthorized()
    return {
      status: 'authorized',
      ...(verified.login !== undefined ? { login: verified.login } : {}),
      ...(parsedScopes !== undefined ? { scopes: parsedScopes } : {}),
      summary,
    }
  }

  const cancelDeviceAuth = (flowId: string): boolean => flows.delete(flowId)

  const importLocalAuth = async (): Promise<GitHubLocalAuthImportResult> => {
    const connectors = resolveConnectorsGitHubFace(options.ctx)
    if (connectors?.importGitHubSso !== undefined) {
      const imported = await connectors.importGitHubSso()
      if (!imported.ok) {
        return { ok: false, source: 'dsh-connectors', message: imported.message ?? 'no GitHub credential found in dsh-connectors' }
      }
      const summary = await options.onAuthorized()
      return {
        ok: true,
        source: 'dsh-connectors',
        ...(imported.login !== undefined ? { login: imported.login } : {}),
        ...(imported.scopes !== undefined ? { scopes: imported.scopes } : {}),
        summary,
      }
    }

    const readCliToken = options.readCliToken ?? defaultReadCliToken
    const token = await readCliToken()
    if (token === undefined || token.trim() === '') {
      return { ok: false, message: 'no token returned by `gh auth token`; sign in with GitHub CLI or use Device Flow' }
    }
    const trimmed = token.trim()
    await setGitHubToken(options.ctx, options.tokenEnv(), trimmed)
    const verified = options.verifyToken ? await options.verifyToken(trimmed) : {}
    const summary = await options.onAuthorized()
    return {
      ok: true,
      source: 'gh-cli',
      ...(verified.login !== undefined ? { login: verified.login } : {}),
      ...(verified.scopes !== undefined ? { scopes: verified.scopes } : {}),
      summary,
    }
  }

  return {
    startDeviceAuth,
    pollDeviceAuth,
    cancelDeviceAuth,
    importLocalAuth,
  }
}
