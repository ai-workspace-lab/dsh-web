/**
 * The setup operations behind this extension's settings card, its host routes
 * and its agent tools.
 *
 * One implementation serves every writer: the browser card, a model calling a
 * tool and a hand-edited profile patch all end up in the same configuration,
 * so the three cannot drift into three different ideas of what "configured"
 * means. Reads for the summary come from the live config (merged base and user
 * layers with defaults applied); writes go back through the Host settings
 * surface (see ./configuration.ts).
 *
 * @module dsh-task-board-github/host/setup
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  sanitizeProjectList,
  sanitizeProxySettings,
  sanitizeRepositoryList,
  type GitHubConnectionReport,
  type GitHubCreateRemoteTaskRequest,
  type GitHubCreateRemoteTaskResponse,
  type GitHubCredentialStatus,
  type GitHubDeviceFlowPollResult,
  type GitHubDeviceFlowStart,
  type GitHubLocalAuthImportResult,
  type GitHubProjectCheck,
  type GitHubProxyMode,
  type GitHubProxyStatus,
  type GitHubRepositoryCheck,
  type GitHubSetupSummary,
  type GitHubSyncHealth,
} from '../core/setup.ts'
import type {
  GitHubOrganizationSummary,
  GitHubProjectConfig,
  GitHubProjectOwnerType,
  GitHubRemoteProjectSummary,
  GitHubRemoteRepositorySummary,
  GitHubRepoConfig,
  GitHubTaskMetadata,
} from '../core/types.ts'
import { ME_ASSIGNEE, resolveProjectConfig, resolveRepoConfig } from '../core/types.ts'
import {
  composeIssuePrompt,
  isIssueIncluded,
  resolveProjectOptionForStatus,
} from '../core/projection.ts'
import { fingerprint } from '../core/prompt.ts'
import { workspaceIdForRepository } from '../core/workspace-match.ts'
import { createGitHubAuthManager } from './auth.ts'
import { GITHUB_API_BASE_URL, GitHubApiClient, GitHubApiError, proxyClientOptions } from './client.ts'
import { clearGitHubToken, describeGitHubCredential, resolveGitHubToken, setGitHubToken } from './credentials.ts'
import {
  findGitHubSettingsEntry,
  resolveSettingsFace,
  writeConfiguredProjects,
  writeConfiguredRepositories,
  writeProxySettings,
} from './configuration.ts'
import { resolveProxyConfiguration } from './proxy.ts'
import type { WorkspaceRegistryFace } from './service.ts'

/** How one repository is checked during a connection test. */
export interface GitHubSetupTarget {
  /** Repository owner; absent means every configured repository. */
  owner?: string
  /** Repository name; required with owner. */
  repository?: string
}

export interface GitHubSetupOptions {
  /** Host context: the credential seam and the settings surface are read from it. */
  ctx: Context
  /** Live repositories the running configuration serves. */
  repositories(): readonly GitHubRepoConfig[]
  /** Live Projects v2 the running configuration serves. */
  projects?(): readonly GitHubProjectConfig[]
  /** Configured OAuth App client id override. */
  oauthClientId?(): string | undefined
  /** Live reference name the token is resolved under. */
  tokenEnv(): string
  /** Whether the provider is mounted right now. */
  running(): boolean
  /**
   * Live sync health of the mounted provider, when one exists.
   *
   * Read at call time rather than captured, so the status route reports the
   * pass in flight right now instead of the one that happened to be running
   * when the settings surface was built.
   */
  health?(): GitHubSyncHealth | undefined
  /**
   * Called after a credential write, so the next request authenticates with
   * the new value instead of the one this process already read.
   */
  reload(): void
  /** Client seam for tests: builds the API client for one resolved token. */
  clientFor?(token: string | undefined): GitHubApiClient
  /** Environment seam for tests. */
  env?: Record<string, string | undefined>
  /** Live proxy mode, read at call time so a settings edit is followed. */
  proxyMode?(): GitHubProxyMode
  /** Live custom proxy URL, read at call time. */
  proxyUrl?(): string
  /**
   * System proxy detection seam.
   *
   * Absent reads the operating system's own proxy (cached, see ./proxy.ts). The
   * seam exists so a test never inherits the machine it happens to run on, and
   * so a deployment that would rather not spawn a child process can say "none".
   */
  detectSystemProxy?(): string | undefined
  /** Fetch seam for OAuth Device Flow tests. */
  authFetchFor?(): typeof fetch
  /** CLI token reader seam for `gh auth token` tests. */
  readCliToken?(): Promise<string | undefined>
  /** Optional host workspace registry for suggesting workspaceId on remote task creation. */
  workspaceRegistry?(): WorkspaceRegistryFace | undefined
  /** Hook to trigger an immediate background sync pass. */
  triggerSync?(): Promise<void>
  /** Deterministic clock seam for tests. */
  now?(): number
}

/** The setup surface the routes and tools share. */
export interface GitHubSetup {
  /** Credential facts, configured repositories and mount state. */
  status(): Promise<GitHubSetupSummary>
  /** Live connection test against GitHub. */
  test(target?: GitHubSetupTarget): Promise<GitHubConnectionReport>
  /** Store one token, then reload the provider. */
  setCredential(token: string): Promise<GitHubSetupSummary>
  /** Remove the stored token, then reload the provider. */
  clearCredential(): Promise<GitHubSetupSummary>
  /** Start an OAuth Device Flow authorization. */
  startDeviceAuth(options?: { clientId?: string; scopes?: string[] }): Promise<GitHubDeviceFlowStart>
  /** Poll an active OAuth Device Flow authorization. */
  pollDeviceAuth(flowId: string): Promise<GitHubDeviceFlowPollResult>
  /** Cancel an active OAuth Device Flow authorization. */
  cancelDeviceAuth(flowId: string): boolean
  /** Import a local GitHub credential from `dsh-connectors` or `gh auth token`. */
  importLocalAuth(): Promise<GitHubLocalAuthImportResult>
  /** The configured repository list as stored. */
  listRepositories(): GitHubRepoConfig[]
  /** Replace the configured repository list. */
  writeRepositories(value: unknown): Promise<GitHubRepoConfig[]>
  /** The configured Project v2 list as stored. */
  listProjects(): GitHubProjectConfig[]
  /** Replace the configured Project v2 list. */
  writeProjects(value: unknown): Promise<GitHubProjectConfig[]>
  /** Discover organizations the authenticated account belongs to. */
  discoverOrgs(): Promise<GitHubOrganizationSummary[]>
  /** Discover Projects v2 owned by the authenticated user or a specified organization/user. */
  discoverProjects(input?: { ownerType?: GitHubProjectOwnerType; owner?: string }): Promise<GitHubRemoteProjectSummary[]>
  /** Discover repositories accessible to the authenticated user or a specified organization. */
  discoverRepositories(input?: { org?: string }): Promise<GitHubRemoteRepositorySummary[]>
  /** Create a remote GitHub Issue or Project v2 item and return the board-ready payload. */
  createRemoteTask(input: GitHubCreateRemoteTaskRequest): Promise<GitHubCreateRemoteTaskResponse>
  /** Trigger an immediate background synchronization pass. */
  triggerSync(): Promise<{ ok: boolean }>
  /** Credential facts only, for callers that need nothing else. */
  credential(): Promise<GitHubCredentialStatus>
  /** Proxy configuration and what it resolves to right now. */
  proxy(): GitHubProxyStatus
  /** Store the proxy mode and custom URL, then reload the provider. */
  setProxy(value: unknown): Promise<GitHubSetupSummary>
}

/**
 * One expected setup failure: bad input, or a deployment that cannot serve the
 * write. The routes map it onto its status instead of reporting a 500, and the
 * tools render it as a refusal.
 */
export class GitHubSetupError extends Error {
  /**
   * @param status - HTTP status the routes answer with.
   * @param code - stable machine-readable reason for a caller to branch on.
   * @param message - human-readable explanation.
   */
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'GitHubSetupError'
  }
}

/** Tokens shorter than this are typos; longer than this is not a token. */
const TOKEN_MIN_LENGTH = 8
const TOKEN_MAX_LENGTH = 512

/**
 * Build the setup operations for one activation.
 * @param options - the live configuration readers and the reload hook.
 * @returns the shared setup surface.
 */
export function createGitHubSetup(options: GitHubSetupOptions): GitHubSetup {
  const env = options.env ?? process.env
  const now = options.now ?? (() => Date.now())
  const credential = (): Promise<GitHubCredentialStatus> => describeGitHubCredential(options.ctx, options.tokenEnv(), env)

  const repositories = (): GitHubRepoConfig[] => options.repositories().map(config => ({ ...config }))
  const projects = (): GitHubProjectConfig[] => (options.projects?.() ?? []).map(config => ({ ...config }))

  /** The proxy this configuration resolves to for the API this client dials. */
  const proxy = (): GitHubProxyStatus => {
    const mode = options.proxyMode?.() ?? 'auto'
    const url = options.proxyUrl?.() ?? ''
    const resolved = resolveProxyConfiguration(GITHUB_API_BASE_URL, {
      mode,
      customUrl: url,
      env,
      ...(options.detectSystemProxy === undefined ? {} : { detect: options.detectSystemProxy }),
    })
    return {
      mode,
      url,
      ...(resolved.url === undefined ? {} : { effective: resolved.url }),
      ...(resolved.source === undefined ? {} : { source: resolved.source }),
    }
  }

  const status = async (): Promise<GitHubSetupSummary> => {
    const face = resolveSettingsFace(options.ctx)
    const health = options.health?.()
    const oauthClientId = options.oauthClientId?.()?.trim()
    return {
      credential: await credential(),
      repositories: repositories(),
      projects: projects(),
      ...(oauthClientId !== undefined && oauthClientId !== '' ? { oauthClientId } : {}),
      running: options.running(),
      settingsWritable: face !== undefined && face.writable !== false && findGitHubSettingsEntry(face) !== undefined,
      proxy: proxy(),
      ...(health === undefined ? {} : { health }),
    }
  }

  const clientFor = (token: string | undefined): GitHubApiClient => {
    if (options.clientFor !== undefined) return options.clientFor(token)
    // The proxy is resolved here, from the plugin configuration, instead of
    // being left to the client's own environment read: a mode of `direct` must
    // win over an inherited HTTPS_PROXY, and a detected system proxy must be
    // used where no variable names one.
    return new GitHubApiClient({
      token,
      tokenEnv: options.tokenEnv(),
      env,
      ...proxyClientOptions(resolveProxyConfiguration(GITHUB_API_BASE_URL, {
        mode: options.proxyMode?.() ?? 'auto',
        customUrl: options.proxyUrl?.() ?? '',
        env,
        ...(options.detectSystemProxy === undefined ? {} : { detect: options.detectSystemProxy }),
      })),
    })
  }

  const setProxy = async (value: unknown): Promise<GitHubSetupSummary> => {
    const settings = sanitizeProxySettings(value)
    if (settings === undefined) {
      throw new GitHubSetupError(400, 'invalid-proxy', 'the proxy settings are not the shape this extension stores')
    }
    await writeProxySettings(options.ctx, settings)
    options.reload()
    return await status()
  }

  const test = async (target?: GitHubSetupTarget): Promise<GitHubConnectionReport> => {
    const credStatus = await credential()
    const targets = selectTargets(options.repositories(), target)
    if (targets.length === 1 && target?.owner !== undefined && repositoryMissing(options.repositories(), target)) {
      // A one-off probe of a repository that is not configured yet: report it
      // like any other check instead of refusing the whole call, which is what
      // lets the card test a repository before it is added.
      targets.push({ owner: target.owner, repository: target.repository ?? '' })
    }
    const token = await resolveGitHubToken(options.ctx, options.tokenEnv(), env)
    if (token === undefined) {
      return { ok: false, credential: credStatus, checks: [] }
    }
    const client = clientFor(token)
    let login: string | undefined
    let scopes: string[] | undefined
    try {
      if (typeof client.getAuthenticatedUserWithScopes === 'function') {
        const user = await client.getAuthenticatedUserWithScopes()
        login = user.login
        scopes = user.scopes
      } else {
        const user = await client.getAuthenticatedUser()
        login = user.login
      }
    } catch (error) {
      return { ok: false, credential: credStatus, checks: [{ owner: '', repository: '', ok: false, message: describeError(error) }] }
    }
    const checks: GitHubRepositoryCheck[] = []
    for (const repository of targets) {
      if (repository.owner === '' || repository.repository === '') continue
      checks.push(await checkRepository(client, repository))
    }
    const configuredProjects = options.projects?.() ?? []
    const projectChecks: GitHubProjectCheck[] = []
    for (const project of configuredProjects) {
      projectChecks.push(await checkProject(client, project))
    }
    const ok = checks.every(check => check.ok) && projectChecks.every(check => check.ok)
    return {
      ok,
      login,
      ...(scopes !== undefined ? { scopes } : {}),
      credential: credStatus,
      checks,
      ...(projectChecks.length > 0 ? { projectChecks } : {}),
    }
  }

  const setCredential = async (token: string): Promise<GitHubSetupSummary> => {
    const value = normalizeTokenInput(token)
    await setGitHubToken(options.ctx, options.tokenEnv(), value)
    options.reload()
    return await status()
  }

  const clearCredential = async (): Promise<GitHubSetupSummary> => {
    await clearGitHubToken(options.ctx, options.tokenEnv())
    options.reload()
    return await status()
  }

  const writeRepositories = async (value: unknown): Promise<GitHubRepoConfig[]> => {
    const list = sanitizeRepositoryList(value)
    if (list === undefined) throw new GitHubSetupError(400, 'invalid-repositories', 'the repository list is not the shape this extension stores')
    const seen = new Set<string>()
    for (const repository of list) {
      const key = (repository.owner + '/' + repository.repository).toLowerCase()
      if (seen.has(key)) throw new GitHubSetupError(400, 'duplicate-repository', 'repository ' + repository.owner + '/' + repository.repository + ' is listed twice')
      seen.add(key)
    }
    await writeConfiguredRepositories(options.ctx, list)
    return list
  }

  const writeProjects = async (value: unknown): Promise<GitHubProjectConfig[]> => {
    const list = sanitizeProjectList(value)
    if (list === undefined) throw new GitHubSetupError(400, 'invalid-projects', 'the project list is not the shape this extension stores')
    const seen = new Set<string>()
    for (const project of list) {
      const key = `${project.ownerType}:${project.owner.toLowerCase()}#${String(project.projectNumber)}`
      if (seen.has(key)) throw new GitHubSetupError(400, 'duplicate-project', `project ${project.owner}#${String(project.projectNumber)} is listed twice`)
      seen.add(key)
    }
    await writeConfiguredProjects(options.ctx, list)
    return list
  }

  const auth = createGitHubAuthManager({
    ctx: options.ctx,
    tokenEnv: options.tokenEnv,
    ...(options.oauthClientId !== undefined ? { oauthClientId: options.oauthClientId } : {}),
    env,
    ...(options.proxyMode !== undefined ? { proxyMode: options.proxyMode } : {}),
    ...(options.proxyUrl !== undefined ? { proxyUrl: options.proxyUrl } : {}),
    ...(options.detectSystemProxy !== undefined ? { detectSystemProxy: options.detectSystemProxy } : {}),
    ...(options.authFetchFor !== undefined ? { authFetchFor: options.authFetchFor } : {}),
    ...(options.readCliToken !== undefined ? { readCliToken: options.readCliToken } : {}),
    now,
    onAuthorized: async () => {
      options.reload()
      return await status()
    },
    verifyToken: async (token) => {
      try {
        const client = clientFor(token)
        if (typeof client.getAuthenticatedUserWithScopes === 'function') {
          const user = await client.getAuthenticatedUserWithScopes()
          return { login: user.login, scopes: user.scopes }
        }
        const user = await client.getAuthenticatedUser()
        return { login: user.login }
      } catch {
        return {}
      }
    },
  })

  const requireAuthenticatedClient = async (): Promise<GitHubApiClient> => {
    const token = await resolveGitHubToken(options.ctx, options.tokenEnv(), env)
    if (token === undefined) {
      throw new GitHubSetupError(401, 'unauthenticated', 'no GitHub credential is configured')
    }
    return clientFor(token)
  }

  const discoverOrgs = async (): Promise<GitHubOrganizationSummary[]> => {
    const client = await requireAuthenticatedClient()
    return await client.listOrganizations()
  }

  const discoverProjects = async (input?: { ownerType?: GitHubProjectOwnerType; owner?: string }): Promise<GitHubRemoteProjectSummary[]> => {
    const client = await requireAuthenticatedClient()
    if (input?.ownerType === 'organization' && input.owner !== undefined && input.owner.trim() !== '') {
      return await client.listOrgProjects(input.owner.trim())
    }
    if (input?.owner !== undefined && input.owner.trim() !== '' && input.ownerType !== 'user') {
      return await client.listOrgProjects(input.owner.trim())
    }
    return await client.listUserProjects()
  }

  const discoverRepositories = async (input?: { org?: string }): Promise<GitHubRemoteRepositorySummary[]> => {
    const client = await requireAuthenticatedClient()
    const org = input?.org?.trim()
    if (org !== undefined && org !== '') {
      return await client.listOrgRepositories(org)
    }
    return await client.listUserRepositories()
  }

  const createRemoteTask = async (input: GitHubCreateRemoteTaskRequest): Promise<GitHubCreateRemoteTaskResponse> => {
    const title = (input.title ?? '').trim()
    if (title === '') {
      throw new GitHubSetupError(400, 'invalid-title', 'a task title is required')
    }
    const body = (input.body ?? '').trim()
    const client = await requireAuthenticatedClient()
    const hasCallerPrompt = typeof input.prompt === 'string' && input.prompt.trim() !== ''
    const syncedAt = now()

    if (input.mode === 'project-draft') {
      const projectOwner = (input.projectOwner ?? '').trim()
      const projectNumber = input.projectNumber
      if (projectOwner === '' || typeof projectNumber !== 'number' || !Number.isInteger(projectNumber) || projectNumber <= 0) {
        throw new GitHubSetupError(400, 'invalid-project', 'projectOwner and projectNumber are required for project-draft mode')
      }
      const ownerType: GitHubProjectOwnerType = input.projectOwnerType === 'user' ? 'user' : 'organization'
      const configuredProject = (options.projects?.() ?? []).find(
        p => p.ownerType === ownerType && p.owner.toLowerCase() === projectOwner.toLowerCase() && p.projectNumber === projectNumber,
      )
      const resolvedProject = resolveProjectConfig(configuredProject ?? { ownerType, owner: projectOwner, projectNumber })
      const project = await client.getProjectV2(ownerType, projectOwner, projectNumber)
      const createdDraft = await client.addProjectV2DraftIssue(project.id, { title, body })

      let statusOptionId: string | undefined
      let statusName: string | undefined
      if (input.status !== undefined && project.statusFieldId !== undefined) {
        const option = resolveProjectOptionForStatus(input.status, project.statusOptions, resolvedProject.statusMap)
        if (option !== undefined) {
          await client.updateProjectV2ItemStatus(project.id, createdDraft.itemId, project.statusFieldId, option.id)
          statusOptionId = option.id
          statusName = option.name
        }
      }

      const suggestedPrompt = [
        `GitHub Project #${String(project.number)} (${project.owner}: ${project.title}) Draft Item`,
        `URL: ${project.url}`,
        `Title: ${title}`,
        ...(body !== '' ? ['', 'Details:', body] : []),
      ].join('\n')
      const finalPrompt = hasCallerPrompt ? input.prompt!.trim() : suggestedPrompt

      const payload: GitHubTaskMetadata = {
        provider: 'github',
        owner: project.owner,
        repository: '',
        issueNumber: 0,
        issueUrl: project.url,
        remoteTitle: title,
        remoteBody: body,
        remoteLabels: [],
        lastSyncedAt: syncedAt,
        ...(!hasCallerPrompt ? { promptHash: fingerprint(suggestedPrompt) } : {}),
        project: {
          projectId: project.id,
          projectNumber: project.number,
          ownerType: project.ownerType,
          owner: project.owner,
          projectTitle: project.title,
          itemId: createdDraft.itemId,
          ...(project.statusFieldId !== undefined ? { statusFieldId: project.statusFieldId } : {}),
          ...(statusOptionId !== undefined ? { statusOptionId } : {}),
          ...(statusName !== undefined ? { statusName } : {}),
          isDraft: true,
          ...(createdDraft.draftIssueId !== undefined ? { draftIssueId: createdDraft.draftIssueId } : {}),
        },
      }

      return {
        title,
        description: body,
        prompt: finalPrompt,
        ...(input.status !== undefined ? { status: input.status } : {}),
        payload,
        suggestedPrompt,
      }
    }

    const owner = (input.owner ?? '').trim()
    const repository = (input.repository ?? '').trim()
    if (owner === '' || repository === '') {
      throw new GitHubSetupError(400, 'invalid-repository', 'owner and repository are required')
    }

    const configuredRepo = options.repositories().find(
      r => r.owner.toLowerCase() === owner.toLowerCase() && r.repository.toLowerCase() === repository.toLowerCase(),
    )
    const resolvedRepo = resolveRepoConfig(configuredRepo ?? { owner, repository })

    const labels = [...(input.labels ?? [])].map(l => l.trim()).filter(Boolean)
    if (configuredRepo !== undefined && resolvedRepo.inclusionLabel !== '' && !labels.includes(resolvedRepo.inclusionLabel)) {
      labels.push(resolvedRepo.inclusionLabel)
    }

    let assignees = [...(input.assignees ?? [])].map(a => a.trim()).filter(Boolean)
    if (assignees.some(a => a.toLowerCase() === ME_ASSIGNEE)) {
      const me = await client.getAuthenticatedUser()
      assignees = assignees.map(a => (a.toLowerCase() === ME_ASSIGNEE ? me.login : a))
    }

    const issue = await client.createIssue(owner, repository, {
      title,
      ...(body !== '' ? { body } : {}),
      ...(labels.length > 0 ? { labels } : {}),
      ...(assignees.length > 0 ? { assignees } : {}),
    })

    const issueLabels = issue.labels.map(l => (typeof l === 'string' ? l : l.name)).filter(Boolean)
    const generated = composeIssuePrompt(
      { number: issue.number, html_url: issue.html_url, title, body, labels: issueLabels },
      resolvedRepo,
    )
    const finalPrompt = hasCallerPrompt ? input.prompt!.trim() : generated.prompt
    const suggestedWorkspaceId = workspaceIdForRepository(repository, options.workspaceRegistry?.()?.list() ?? [])

    const payload: GitHubTaskMetadata = {
      provider: 'github',
      owner,
      repository,
      issueNumber: issue.number,
      ...(issue.node_id !== undefined ? { issueNodeId: issue.node_id } : {}),
      issueUrl: issue.html_url,
      remoteTitle: title,
      remoteBody: body,
      remoteState: 'open',
      remoteLabels: issueLabels,
      lastSyncedAt: syncedAt,
      ...(!hasCallerPrompt ? { promptHash: generated.promptHash } : {}),
    }

    if (input.mode === 'project-issue') {
      const projectOwner = (input.projectOwner ?? '').trim()
      const projectNumber = input.projectNumber
      if (projectOwner === '' || typeof projectNumber !== 'number' || !Number.isInteger(projectNumber) || projectNumber <= 0) {
        throw new GitHubSetupError(400, 'invalid-project', 'projectOwner and projectNumber are required for project-issue mode')
      }
      if (!issue.node_id) {
        throw new GitHubSetupError(502, 'missing-node-id', 'created issue did not include a GraphQL node_id')
      }
      const ownerType: GitHubProjectOwnerType = input.projectOwnerType === 'user' ? 'user' : 'organization'
      const configuredProject = (options.projects?.() ?? []).find(
        p => p.ownerType === ownerType && p.owner.toLowerCase() === projectOwner.toLowerCase() && p.projectNumber === projectNumber,
      )
      const resolvedProject = resolveProjectConfig(configuredProject ?? { ownerType, owner: projectOwner, projectNumber })
      const project = await client.getProjectV2(ownerType, projectOwner, projectNumber)
      const itemId = await client.addProjectV2ItemById(project.id, issue.node_id)

      let statusOptionId: string | undefined
      let statusName: string | undefined
      if (input.status !== undefined && project.statusFieldId !== undefined) {
        const option = resolveProjectOptionForStatus(input.status, project.statusOptions, resolvedProject.statusMap)
        if (option !== undefined) {
          await client.updateProjectV2ItemStatus(project.id, itemId, project.statusFieldId, option.id)
          statusOptionId = option.id
          statusName = option.name
        }
      }

      payload.project = {
        projectId: project.id,
        projectNumber: project.number,
        ownerType: project.ownerType,
        owner: project.owner,
        projectTitle: project.title,
        itemId,
        ...(project.statusFieldId !== undefined ? { statusFieldId: project.statusFieldId } : {}),
        ...(statusOptionId !== undefined ? { statusOptionId } : {}),
        ...(statusName !== undefined ? { statusName } : {}),
      }
    }

    return {
      title,
      description: body,
      prompt: finalPrompt,
      ...(input.status !== undefined ? { status: input.status } : {}),
      payload,
      suggestedPrompt: generated.prompt,
      ...(suggestedWorkspaceId !== undefined ? { suggestedWorkspaceId } : {}),
    }
  }

  const triggerSync = async (): Promise<{ ok: boolean }> => {
    if (options.triggerSync === undefined) return { ok: false }
    await options.triggerSync()
    return { ok: true }
  }

  return {
    status,
    test,
    setCredential,
    clearCredential,
    startDeviceAuth: auth.startDeviceAuth,
    pollDeviceAuth: auth.pollDeviceAuth,
    cancelDeviceAuth: auth.cancelDeviceAuth,
    importLocalAuth: auth.importLocalAuth,
    listRepositories: repositories,
    writeRepositories,
    listProjects: projects,
    writeProjects,
    discoverOrgs,
    discoverProjects,
    discoverRepositories,
    createRemoteTask,
    triggerSync,
    credential,
    proxy,
    setProxy,
  }
}

/**
 * Validate a token a user or a model pasted.
 * @param token - the raw value.
 * @returns the trimmed token.
 * @throws when the value cannot be a GitHub token.
 */
export function normalizeTokenInput(token: string): string {
  const trimmed = token.trim()
  if (trimmed === '') throw new GitHubSetupError(400, 'empty-token', 'the token is empty')
  if (trimmed.length < TOKEN_MIN_LENGTH) throw new GitHubSetupError(400, 'short-token', 'the token is too short to be a GitHub token')
  if (trimmed.length > TOKEN_MAX_LENGTH) throw new GitHubSetupError(400, 'long-token', 'the token is too long to be a GitHub token')
  if (/\s/.test(trimmed)) throw new GitHubSetupError(400, 'whitespace-token', 'the token contains whitespace; paste the raw token only')
  return trimmed
}

/** The repositories one test call covers. */
function selectTargets(configured: readonly GitHubRepoConfig[], target?: GitHubSetupTarget): GitHubRepoConfig[] {
  if (target?.owner === undefined || target.repository === undefined || target.repository === '') {
    return configured.map(config => ({ ...config }))
  }
  const owner = target.owner.toLowerCase()
  const name = target.repository.toLowerCase()
  const hit = configured.find(config => config.owner.toLowerCase() === owner && config.repository.toLowerCase() === name)
  return hit === undefined ? [] : [{ ...hit }]
}

/** Whether a one-off target names a repository the configuration does not carry. */
function repositoryMissing(configured: readonly GitHubRepoConfig[], target: GitHubSetupTarget): boolean {
  const owner = target.owner?.toLowerCase()
  const name = target.repository?.toLowerCase()
  return !configured.some(config => config.owner.toLowerCase() === owner && config.repository.toLowerCase() === name)
}

/**
 * Check one repository: identity, default branch, and how many of its open
 * issues the board would take.
 *
 * The count is computed by the same inclusion rule the sync applies — the
 * inclusion label, or assignment to the configured login — so a repository
 * whose board feed comes from assignees reports a number instead of a
 * misleading zero.
 */
async function checkRepository(client: GitHubApiClient, repository: GitHubRepoConfig): Promise<GitHubRepositoryCheck> {
  const owner = repository.owner
  const name = repository.repository
  const config = resolveRepoConfig(repository)
  try {
    const found = await client.getRepository(owner, name)
    let assignee = config.assignee
    if (assignee === ME_ASSIGNEE) {
      const user = await client.getAuthenticatedUser()
      assignee = user.login.trim().toLowerCase()
    }
    const effective = assignee === undefined ? config : { ...config, assignee }
    const issues = await client.listOpenIssues(owner, name)
    const included = issues.filter(issue => isIssueIncluded(issue, effective)).length
    const channels = 'label "' + config.inclusionLabel + '"'
      + (assignee === undefined ? '' : ' or assignment to ' + assignee)
      + (config.includeUnassigned ? ' or no assignee' : '')
    return {
      owner,
      repository: name,
      ok: true,
      message: String(included) + ' open issues are on the board (' + channels + ')',
      ...(typeof found.default_branch === 'string' ? { defaultBranch: found.default_branch } : {}),
      ...(typeof found.private === 'boolean' ? { private: found.private } : {}),
      ...(assignee === undefined ? {} : { assignee }),
      ...(config.includeUnassigned ? { includeUnassigned: true } : {}),
      openIssues: included,
    }
  } catch (error) {
    return { owner, repository: name, ok: false, message: describeError(error) }
  }
}

async function checkProject(client: GitHubApiClient, project: GitHubProjectConfig): Promise<GitHubProjectCheck> {
  try {
    const detail = await client.getProjectV2(project.ownerType, project.owner, project.projectNumber)
    return {
      ownerType: project.ownerType,
      owner: project.owner,
      projectNumber: project.projectNumber,
      ok: true,
      title: detail.title,
      itemCount: detail.items.length,
      message: `${detail.title} (${String(detail.items.length)} items)`,
    }
  } catch (error) {
    return {
      ownerType: project.ownerType,
      owner: project.owner,
      projectNumber: project.projectNumber,
      ok: false,
      message: describeError(error),
    }
  }
}

/** Phrase one failure for a person reading the card or a model reading a tool result. */
function describeError(error: unknown): string {
  if (error instanceof GitHubApiError) {
    if (error.status === 401) return 'GitHub rejected the credential (401): the token is invalid or expired'
    if (error.status === 403) return 'GitHub refused the request (403): the token lacks a required scope, or the rate limit is exhausted'
    if (error.status === 404) return 'GitHub answered 404: the repository does not exist, or this token cannot see it'
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}
