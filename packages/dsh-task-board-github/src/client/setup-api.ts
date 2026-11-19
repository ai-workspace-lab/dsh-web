/**
 * Browser half of the setup API: the same-origin routes the Host serves for
 * configuration reads and writes.
 *
 * The settings card talks to the Host through this module instead of writing
 * the settings namespace itself, which is what keeps one write path: the card,
 * the host routes and the agent tools all reach ./host/setup.ts, so a value
 * typed in the card and a value written by a model produce the same stored
 * configuration. No response here carries a credential value — only whether
 * one is configured, where it came from and whether it is writable.
 *
 * @module dsh-task-board-github/client/setup-api
 */
import {
  GITHUB_PROXY_MODES,
  GITHUB_SETUP_API_PREFIX,
  type GitHubConnectionReport,
  type GitHubCreateRemoteTaskRequest,
  type GitHubCreateRemoteTaskResponse,
  type GitHubDeviceFlowPollResult,
  type GitHubDeviceFlowStart,
  type GitHubLocalAuthImportResult,
  type GitHubProxyMode,
  type GitHubProxySettings,
  type GitHubProxyStatus,
  type GitHubSetupSummary,
} from '../core/setup.ts'
import type {
  GitHubOrganizationSummary,
  GitHubProjectConfig,
  GitHubProjectOwnerType,
  GitHubRemoteProjectSummary,
  GitHubRemoteRepositorySummary,
  GitHubRepoConfig,
} from '../core/types.ts'

/** Hard ceiling for one setup call; a stalled host must not pile up requests. */
const SETUP_FETCH_TIMEOUT_MS = 15_000

/** Extended ceiling for remote GitHub discovery, manual sync, and remote task creation. */
const SETUP_LONG_FETCH_TIMEOUT_MS = 30_000

/**
 * The same route prefix in the form the browser should resolve: document
 * relative, so a GUI served from a sub-path reaches the Host under that same
 * entry directory.
 */
const SETUP_PATH_PREFIX = GITHUB_SETUP_API_PREFIX.slice(1)

/** The setup API as the card uses it. */
export interface GitHubSetupApi {
  /** Credential facts, configured repositories and mount state. */
  status(): Promise<GitHubSetupSummary>
  /** Live connection test against GitHub. */
  test(target?: { owner?: string; repository?: string }): Promise<GitHubConnectionReport>
  /** Store one token in the harness credential store. */
  setCredential(token: string): Promise<GitHubSetupSummary>
  /** Remove the stored token. */
  clearCredential(): Promise<GitHubSetupSummary>
  /** Read the configured repository list. */
  listRepositories(): Promise<GitHubRepoConfig[]>
  /** Replace the configured repository list. */
  writeRepositories(repositories: readonly GitHubRepoConfig[]): Promise<GitHubRepoConfig[]>
  /** Store the proxy mode and custom URL. */
  setProxy(settings: GitHubProxySettings): Promise<GitHubSetupSummary>
  /** Start an OAuth device flow login session. */
  startDeviceAuth(): Promise<GitHubDeviceFlowStart>
  /** Poll an active OAuth device flow login session. */
  pollDeviceAuth(flowId: string): Promise<GitHubDeviceFlowPollResult>
  /** Cancel an active OAuth device flow login session. */
  cancelDeviceAuth(flowId: string): Promise<void>
  /** Import an existing local GitHub credential (dsh-connectors or gh CLI). */
  importLocalAuth(): Promise<GitHubLocalAuthImportResult>
  /** Read the configured GitHub Projects v2 list. */
  listProjects(): Promise<GitHubProjectConfig[]>
  /** Replace the configured GitHub Projects v2 list. */
  writeProjects(projects: readonly GitHubProjectConfig[]): Promise<GitHubProjectConfig[]>
  /** Discover GitHub organizations accessible to the authenticated account. */
  discoverOrgs(): Promise<{ login: string; organizations: GitHubOrganizationSummary[] }>
  /** Discover GitHub Projects v2 for an organization or the authenticated user. */
  discoverProjects(owner: string, ownerType?: GitHubProjectOwnerType): Promise<GitHubRemoteProjectSummary[]>
  /** Discover GitHub repositories for an organization or the authenticated user. */
  discoverRepositories(owner?: string, ownerType?: GitHubProjectOwnerType): Promise<GitHubRemoteRepositorySummary[]>
  /** Create a remote GitHub Issue and/or Project v2 item. */
  createRemoteTask(request: GitHubCreateRemoteTaskRequest): Promise<GitHubCreateRemoteTaskResponse>
  /** Trigger an immediate synchronization pass on the host. */
  triggerSync(): Promise<{ synced: number; errors: string[] }>
}

/**
 * Build the setup API client.
 * @param fetchImpl - fetch implementation (a test seam).
 * @returns the client.
 */
export function createGitHubSetupApi(fetchImpl: typeof fetch = fetch): GitHubSetupApi {
  const call = async (
    path: string,
    init: RequestInit = {},
    options: { timeoutMs?: number; allowOkFalse?: boolean } = {},
  ): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(SETUP_PATH_PREFIX + path, {
      ...init,
      ...(init.body === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
      signal: AbortSignal.timeout(options.timeoutMs ?? SETUP_FETCH_TIMEOUT_MS),
    })
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      payload = undefined
    }
    const body = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
    if (!response.ok || (options.allowOkFalse !== true && body.ok === false)) {
      throw new Error(typeof body.error === 'string' && body.error !== '' ? body.error : 'the Host refused the request (' + String(response.status) + ')')
    }
    return body
  }

  /** Parse the host's sync-health block, dropping it when absent or malformed. */
  const asHealth = (value: unknown): GitHubSetupSummary['health'] => {
    if (typeof value !== 'object' || value === null) return undefined
    const row = value as Record<string, unknown>
    if (typeof row.running !== 'boolean' || typeof row.inFlight !== 'boolean') return undefined
    return {
      running: row.running,
      inFlight: row.inFlight,
      ...(typeof row.lastSyncAt === 'number' ? { lastSyncAt: row.lastSyncAt } : {}),
      lastErrors: Array.isArray(row.lastErrors) ? row.lastErrors.filter((item): item is string => typeof item === 'string') : [],
      consecutiveEmptySyncs: typeof row.consecutiveEmptySyncs === 'number' ? row.consecutiveEmptySyncs : 0,
      ...(typeof row.staleSince === 'number' ? { staleSince: row.staleSince } : {}),
      ...(typeof row.staleAfterMs === 'number' ? { staleAfterMs: row.staleAfterMs } : {}),
    }
  }

  /**
   * Parse the host's proxy block, falling back to the schema default.
   *
   * The fallback has to be `auto`: a host that predates this field proxies
   * exactly as `auto` describes it, so the card must render the mode that
   * matches what is actually happening rather than a `direct` it invented.
   */
  const asProxy = (value: unknown): GitHubProxyStatus => {
    const row = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
    const mode = GITHUB_PROXY_MODES.includes(row.mode as GitHubProxyMode) ? row.mode as GitHubProxyMode : 'auto'
    const source = row.source === 'env' || row.source === 'system' || row.source === 'custom' ? row.source : undefined
    return {
      mode,
      url: typeof row.url === 'string' ? row.url : '',
      ...(typeof row.effective === 'string' && row.effective !== '' ? { effective: row.effective } : {}),
      ...(source === undefined ? {} : { source }),
    }
  }

  const asSummary = (body: Record<string, unknown>): GitHubSetupSummary => {
    const credential = typeof body.credential === 'object' && body.credential !== null ? body.credential as GitHubSetupSummary['credential'] : undefined
    const health = asHealth(body.health)
    return {
      credential: credential ?? { configured: false, writable: false, envName: 'GITHUB_TOKEN' },
      repositories: Array.isArray(body.repositories) ? body.repositories as GitHubRepoConfig[] : [],
      projects: Array.isArray(body.projects) ? body.projects as GitHubProjectConfig[] : [],
      ...(typeof body.oauthClientId === 'string' && body.oauthClientId !== '' ? { oauthClientId: body.oauthClientId } : {}),
      running: body.running === true,
      settingsWritable: body.settingsWritable === true,
      proxy: asProxy(body.proxy),
      ...(health === undefined ? {} : { health }),
    }
  }

  return {
    async status() {
      return asSummary(await call('/status'))
    },
    async test(target = {}) {
      const body = await call('/test', { method: 'POST', body: JSON.stringify(target) })
      const report = body.report
      if (typeof report !== 'object' || report === null) throw new Error('the Host returned no test report')
      return report as GitHubConnectionReport
    },
    async setCredential(token) {
      return asSummary(await call('/credential', { method: 'POST', body: JSON.stringify({ token }) }))
    },
    async clearCredential() {
      return asSummary(await call('/credential', { method: 'DELETE' }))
    },
    async listRepositories() {
      const body = await call('/repositories')
      return Array.isArray(body.repositories) ? body.repositories as GitHubRepoConfig[] : []
    },
    async writeRepositories(repositories) {
      const body = await call('/repositories', { method: 'PUT', body: JSON.stringify({ repositories }) })
      return Array.isArray(body.repositories) ? body.repositories as GitHubRepoConfig[] : []
    },
    async setProxy(settings) {
      return asSummary(await call('/proxy', { method: 'PUT', body: JSON.stringify(settings) }))
    },
    async startDeviceAuth() {
      const body = await call('/auth/device/start', { method: 'POST', body: JSON.stringify({}) })
      const flow = body.flow
      if (typeof flow !== 'object' || flow === null) throw new Error('the Host returned no device flow')
      return flow as GitHubDeviceFlowStart
    },
    async pollDeviceAuth(flowId) {
      const body = await call('/auth/device/poll', { method: 'POST', body: JSON.stringify({ flowId }) })
      const result = body.result
      if (typeof result !== 'object' || result === null) throw new Error('the Host returned no device poll result')
      return result as GitHubDeviceFlowPollResult
    },
    async cancelDeviceAuth(flowId) {
      await call('/auth/device/cancel', { method: 'POST', body: JSON.stringify({ flowId }) })
    },
    async importLocalAuth() {
      const body = await call('/auth/import-local', { method: 'POST' }, { allowOkFalse: true })
      return body as unknown as GitHubLocalAuthImportResult
    },
    async listProjects() {
      const body = await call('/projects')
      return Array.isArray(body.projects) ? body.projects as GitHubProjectConfig[] : []
    },
    async writeProjects(projects) {
      const body = await call('/projects', { method: 'PUT', body: JSON.stringify({ projects }) })
      return Array.isArray(body.projects) ? body.projects as GitHubProjectConfig[] : []
    },
    async discoverOrgs() {
      const body = await call('/discover/orgs', {}, { timeoutMs: SETUP_LONG_FETCH_TIMEOUT_MS })
      const rawOrgs = Array.isArray(body.organizations)
        ? body.organizations
        : Array.isArray(body.orgs)
          ? body.orgs
          : []
      return {
        login: typeof body.login === 'string' ? body.login : '',
        organizations: rawOrgs as GitHubOrganizationSummary[],
      }
    },
    async discoverProjects(owner, ownerType) {
      const params = new URLSearchParams()
      if (owner.trim() !== '') params.set('owner', owner.trim())
      if (ownerType !== undefined) params.set('ownerType', ownerType)
      const qs = params.toString()
      const body = await call('/discover/projects' + (qs === '' ? '' : '?' + qs), {}, { timeoutMs: SETUP_LONG_FETCH_TIMEOUT_MS })
      return Array.isArray(body.projects) ? body.projects as GitHubRemoteProjectSummary[] : []
    },
    async discoverRepositories(owner, ownerType) {
      const params = new URLSearchParams()
      if (owner !== undefined && owner.trim() !== '' && ownerType !== 'user') {
        params.set('org', owner.trim())
      }
      const qs = params.toString()
      const body = await call('/discover/repositories' + (qs === '' ? '' : '?' + qs), {}, { timeoutMs: SETUP_LONG_FETCH_TIMEOUT_MS })
      return Array.isArray(body.repositories) ? body.repositories as GitHubRemoteRepositorySummary[] : []
    },
    async createRemoteTask(request) {
      const body = await call('/tasks/create-remote', { method: 'POST', body: JSON.stringify(request) }, { timeoutMs: SETUP_LONG_FETCH_TIMEOUT_MS })
      return body as unknown as GitHubCreateRemoteTaskResponse
    },
    async triggerSync() {
      const body = await call('/sync', { method: 'POST' }, { timeoutMs: SETUP_LONG_FETCH_TIMEOUT_MS })
      return {
        synced: typeof body.synced === 'number' ? body.synced : 0,
        errors: Array.isArray(body.errors) ? body.errors.filter((item): item is string => typeof item === 'string') : [],
      }
    },
  }
}
