/**
 * The GitHub integration block of the settings card: the credential, the
 * synchronized repositories, and a live connection test.
 *
 * This panel is what makes the integration configurable without editing a
 * profile patch: a token is pasted once and stored host-side in the harness
 * credential store, repositories are added by typing `owner/repo` (a pasted
 * GitHub URL or an SSH remote work too), and the connection test reports the
 * authenticated account and each repository's reachability before anything is
 * trusted. Every write goes through the setup API, so the same edits a person
 * makes here are the ones a model makes through the setup tools.
 *
 * @module dsh-task-board-github/client/SetupPanel
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  addProject,
  addRepository,
  GITHUB_PROXY_MODES,
  removeProject,
  removeRepository,
  updateProject,
  updateRepository,
  type GitHubConnectionReport,
  type GitHubCredentialStatus,
  type GitHubDeviceFlowStart,
  type GitHubProxyMode,
  type GitHubProxySource,
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
import { GitHubSummaryBlock } from './github/sections.tsx'
import { useGitHubSummary } from './github/summary.ts'
import type { GitHubSetupApi } from './setup-api.ts'
import type { TaskBoardGithubKey } from './locales.ts'
import css from './github.module.css'

/** The panel's copy reader. */
export type SetupPanelTranslate = (key: TaskBoardGithubKey, params?: Record<string, string>) => string

export interface GitHubSetupPanelProps {
  /** Locale reader of this extension's catalog. */
  t: SetupPanelTranslate
  /** Same-origin setup API. */
  api: GitHubSetupApi
  /** Whether the surrounding card is writable; a read-only page disables every control. */
  disabled?: boolean
}

/** Render the integration block. */
export function GitHubSetupPanel({ t, api, disabled = false }: GitHubSetupPanelProps) {
  const mirror = useGitHubSummary()
  const [status, setStatus] = useState<GitHubSetupSummary | undefined>()
  const [statusError, setStatusError] = useState<string | undefined>()
  const [repositories, setRepositories] = useState<GitHubRepoConfig[]>([])
  const [repositoryError, setRepositoryError] = useState<string | undefined>()
  const [repositoryBusy, setRepositoryBusy] = useState(false)
  const [newRepository, setNewRepository] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newAssignee, setNewAssignee] = useState('')
  const [projects, setProjects] = useState<GitHubProjectConfig[]>([])
  const [projectError, setProjectError] = useState<string | undefined>()
  const [projectBusy, setProjectBusy] = useState(false)
  const [newProject, setNewProject] = useState('')
  const [newProjectDefaultRepo, setNewProjectDefaultRepo] = useState('')
  const [projectDefaultRepos, setProjectDefaultRepos] = useState<Record<string, string>>({})
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [token, setToken] = useState('')
  const [credentialError, setCredentialError] = useState<string | undefined>()
  const [credentialBusy, setCredentialBusy] = useState(false)
  const [credentialSaved, setCredentialSaved] = useState(false)
  const [deviceFlow, setDeviceFlow] = useState<GitHubDeviceFlowStart | undefined>()
  const [deviceStarting, setDeviceStarting] = useState(false)
  const [deviceCopied, setDeviceCopied] = useState(false)
  const [deviceLoginMessage, setDeviceLoginMessage] = useState<string | undefined>()
  const [localAuthBusy, setLocalAuthBusy] = useState(false)
  const [localAuthNotice, setLocalAuthNotice] = useState<string | undefined>()
  const [localAuthScopeWarn, setLocalAuthScopeWarn] = useState(false)
  const [syncingNow, setSyncingNow] = useState(false)
  const [syncNowNotice, setSyncNowNotice] = useState<string | undefined>()
  const [syncNowError, setSyncNowError] = useState<string | undefined>()
  const [discoverBusy, setDiscoverBusy] = useState(false)
  const [discoverError, setDiscoverError] = useState<string | undefined>()
  const [discoverLogin, setDiscoverLogin] = useState<string | undefined>()
  const [discoverOrgs, setDiscoverOrgs] = useState<GitHubOrganizationSummary[] | undefined>()
  const [discoverOwner, setDiscoverOwner] = useState<{ owner: string; ownerType: GitHubProjectOwnerType } | undefined>()
  const [discoverProjects, setDiscoverProjects] = useState<GitHubRemoteProjectSummary[]>([])
  const [discoverRepos, setDiscoverRepos] = useState<GitHubRemoteRepositorySummary[]>([])
  const [discoverTargetBusy, setDiscoverTargetBusy] = useState(false)
  const [report, setReport] = useState<GitHubConnectionReport | undefined>()
  const [testError, setTestError] = useState<string | undefined>()
  const [testing, setTesting] = useState(false)
  const [repositoriesOpen, setRepositoriesOpen] = useState(false)
  // The proxy block keeps its own draft: the select writes immediately, while
  // the URL box is committed on blur or Enter so a half-typed address is never
  // stored and never remounts the provider between keystrokes.
  const [proxyMode, setProxyMode] = useState<GitHubProxyMode>('auto')
  const [proxyUrlDraft, setProxyUrlDraft] = useState('')
  const [proxyError, setProxyError] = useState<string | undefined>()
  const [proxyBusy, setProxyBusy] = useState(false)
  // Points aria-controls at the disclosure regions below.
  const repositoriesRegionId = useId()
  const projectsRegionId = useId()
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const activeFlowIdRef = useRef<string | undefined>(undefined)
  const mountedRef = useRef(true)

  const clearPollTimer = useCallback((): void => {
    if (pollTimerRef.current !== undefined) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = undefined
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      activeFlowIdRef.current = undefined
      clearPollTimer()
    }
  }, [clearPollTimer])

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await api.status()
      if (!mountedRef.current) return
      setStatus(next)
      setRepositories(next.repositories)
      setProjects(next.projects ?? [])
      setProxyMode(next.proxy.mode)
      setProxyUrlDraft(next.proxy.url)
      setStatusError(undefined)
    } catch (error) {
      if (!mountedRef.current) return
      setStatus(undefined)
      setStatusError(messageOf(error))
    }
  }, [api])

  useEffect(() => { void load() }, [load])

  const write = async (next: readonly GitHubRepoConfig[], clearDraft = false): Promise<void> => {
    setRepositoryBusy(true)
    setRepositoryError(undefined)
    try {
      setRepositories(await api.writeRepositories(next))
      // Clear the draft only once the Host accepted it, so a refused write
      // leaves the user's typing in place to correct.
      if (clearDraft) {
        setNewRepository('')
        setNewLabel('')
        setNewAssignee('')
      }
    } catch (error) {
      setRepositoryError(messageOf(error))
    } finally {
      setRepositoryBusy(false)
    }
  }

  const add = (): void => {
    const edit = addRepository(repositories, newRepository, {
      ...(newLabel.trim() === '' ? {} : { inclusionLabel: newLabel.trim() }),
      ...(newAssignee.trim() === '' ? {} : { assignee: newAssignee.trim() }),
    })
    if (!edit.ok) {
      setRepositoryError(edit.message)
      return
    }
    void write(edit.repositories, true)
  }

  const toggleUnassigned = (repository: GitHubRepoConfig, include: boolean): void => {
    const edit = updateRepository(repositories, repository.owner + '/' + repository.repository, { includeUnassigned: include })
    if (!edit.ok) {
      setRepositoryError(edit.message)
      return
    }
    void write(edit.repositories)
  }

  const remove = (repository: GitHubRepoConfig): void => {
    const edit = removeRepository(repositories, repository.owner + '/' + repository.repository)
    if (!edit.ok) {
      setRepositoryError(edit.message)
      return
    }
    void write(edit.repositories)
  }

  const saveToken = async (): Promise<void> => {
    if (token.trim() === '') {
      setCredentialError(t('setup.tokenEmpty'))
      return
    }
    setCredentialBusy(true)
    setCredentialError(undefined)
    setCredentialSaved(false)
    try {
      const next = await api.setCredential(token)
      setStatus(next)
      setToken('')
      setCredentialSaved(true)
    } catch (error) {
      setCredentialError(messageOf(error))
    } finally {
      setCredentialBusy(false)
    }
  }

  const clearToken = async (): Promise<void> => {
    setCredentialBusy(true)
    setCredentialError(undefined)
    setCredentialSaved(false)
    try {
      setStatus(await api.clearCredential())
    } catch (error) {
      setCredentialError(messageOf(error))
    } finally {
      setCredentialBusy(false)
    }
  }

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTestError(undefined)
    try {
      setReport(await api.test())
    } catch (error) {
      setReport(undefined)
      setTestError(messageOf(error))
    } finally {
      setTesting(false)
    }
  }

  const saveProxy = async (mode: GitHubProxyMode, url: string): Promise<void> => {
    setProxyBusy(true)
    setProxyError(undefined)
    try {
      const next = await api.setProxy({ mode, url })
      setStatus(next)
      setProxyMode(next.proxy.mode)
      setProxyUrlDraft(next.proxy.url)
    } catch (error) {
      setProxyError(messageOf(error))
    } finally {
      setProxyBusy(false)
    }
  }

  const schedulePoll = useCallback((flowId: string, intervalSeconds: number): void => {
    clearPollTimer()
    const delayMs = Math.max(1000, intervalSeconds * 1000)
    pollTimerRef.current = setTimeout(() => {
      void (async () => {
        if (!mountedRef.current || activeFlowIdRef.current !== flowId) return
        try {
          const res = await api.pollDeviceAuth(flowId)
          if (!mountedRef.current || activeFlowIdRef.current !== flowId) return
          if (res.status === 'pending') {
            schedulePoll(flowId, res.interval ?? intervalSeconds)
            return
          }
          activeFlowIdRef.current = undefined
          setDeviceFlow(undefined)
          if (res.status === 'authorized') {
            setStatus(res.summary)
            setRepositories(res.summary.repositories)
            setProjects(res.summary.projects ?? [])
            if (res.login !== undefined && res.login !== '') {
              setDeviceLoginMessage(t('setup.deviceAuthorized', { login: res.login }))
            }
            void load()
          } else {
            setCredentialError(res.message)
          }
        } catch (error) {
          if (!mountedRef.current || activeFlowIdRef.current !== flowId) return
          activeFlowIdRef.current = undefined
          setDeviceFlow(undefined)
          setCredentialError(messageOf(error))
        }
      })()
    }, delayMs)
  }, [api, clearPollTimer, load, t])

  const startDeviceLogin = async (): Promise<void> => {
    setDeviceStarting(true)
    setCredentialError(undefined)
    setDeviceLoginMessage(undefined)
    setDeviceCopied(false)
    clearPollTimer()
    try {
      const flow = await api.startDeviceAuth()
      if (!mountedRef.current) return
      activeFlowIdRef.current = flow.flowId
      setDeviceFlow(flow)
      schedulePoll(flow.flowId, flow.interval)
    } catch (error) {
      if (!mountedRef.current) return
      setCredentialError(messageOf(error))
    } finally {
      if (mountedRef.current) setDeviceStarting(false)
    }
  }

  const cancelDeviceLogin = async (): Promise<void> => {
    const flow = deviceFlow
    activeFlowIdRef.current = undefined
    clearPollTimer()
    setDeviceFlow(undefined)
    if (flow !== undefined) {
      try { await api.cancelDeviceAuth(flow.flowId) } catch { /* best-effort */ }
    }
  }

  const copyDeviceCode = async (code: string): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(code)
      setDeviceCopied(true)
    } catch {
      // Clipboard may be unavailable in headless environments.
    }
  }

  const importLocalLogin = async (): Promise<void> => {
    setLocalAuthBusy(true)
    setCredentialError(undefined)
    setLocalAuthNotice(undefined)
    setLocalAuthScopeWarn(false)
    try {
      const res = await api.importLocalAuth()
      if (!mountedRef.current) return
      if (!res.ok) {
        setCredentialError(res.message ?? t('setup.testNoCredential'))
        return
      }
      if (res.summary !== undefined) {
        setStatus(res.summary)
        setRepositories(res.summary.repositories)
        setProjects(res.summary.projects ?? [])
      } else {
        void load()
      }
      const login = res.login ?? t('setup.credentialSourceUnknown')
      const source = res.source ?? t('setup.credentialSourceUnknown')
      setLocalAuthNotice(t('setup.localLoginSuccess', { login, source }))
      if (Array.isArray(res.scopes) && !res.scopes.includes('project') && !res.scopes.includes('read:project')) {
        setLocalAuthScopeWarn(true)
      }
    } catch (error) {
      if (!mountedRef.current) return
      setCredentialError(messageOf(error))
    } finally {
      if (mountedRef.current) setLocalAuthBusy(false)
    }
  }

  const handleSyncNow = async (): Promise<void> => {
    setSyncingNow(true)
    setSyncNowNotice(undefined)
    setSyncNowError(undefined)
    try {
      const res = await api.triggerSync()
      if (!mountedRef.current) return
      setSyncNowNotice(t('setup.syncNowResult', { count: String(res.synced) }))
      if (res.errors.length > 0) {
        setSyncNowError(res.errors.join('; '))
      }
      await load()
    } catch (error) {
      if (!mountedRef.current) return
      setSyncNowError(messageOf(error))
    } finally {
      if (mountedRef.current) setSyncingNow(false)
    }
  }

  const writeProjectsList = async (next: readonly GitHubProjectConfig[], clearDraft = false): Promise<void> => {
    setProjectBusy(true)
    setProjectError(undefined)
    try {
      setProjects(await api.writeProjects(next))
      if (clearDraft) {
        setNewProject('')
        setNewProjectDefaultRepo('')
      }
    } catch (error) {
      setProjectError(messageOf(error))
    } finally {
      setProjectBusy(false)
    }
  }

  const addProjectEntry = (): void => {
    const edit = addProject(projects, newProject)
    if (!edit.ok) {
      setProjectError(edit.message)
      return
    }
    const added = edit.projects[edit.projects.length - 1]
    if (added !== undefined && newProjectDefaultRepo.trim() !== '') {
      const key = `${added.ownerType}:${added.owner.toLowerCase()}#${String(added.projectNumber)}`
      setProjectDefaultRepos(prev => ({ ...prev, [key]: newProjectDefaultRepo.trim() }))
    }
    void writeProjectsList(edit.projects, true)
  }

  const toggleProjectDrafts = (project: GitHubProjectConfig, includeDrafts: boolean): void => {
    const slug = `${project.ownerType === 'user' ? 'user' : 'org'}/${project.owner}/projects/${String(project.projectNumber)}`
    const edit = updateProject(projects, slug, { includeDrafts })
    if (!edit.ok) {
      setProjectError(edit.message)
      return
    }
    void writeProjectsList(edit.projects)
  }

  const removeProjectEntry = (project: GitHubProjectConfig): void => {
    const slug = `${project.ownerType === 'user' ? 'user' : 'org'}/${project.owner}/projects/${String(project.projectNumber)}`
    const edit = removeProject(projects, slug)
    if (!edit.ok) {
      setProjectError(edit.message)
      return
    }
    void writeProjectsList(edit.projects)
  }

  const selectDiscoverOwner = async (owner: string, ownerType: GitHubProjectOwnerType): Promise<void> => {
    setDiscoverOwner({ owner, ownerType })
    setDiscoverTargetBusy(true)
    setDiscoverError(undefined)
    try {
      const [foundProjects, foundRepos] = await Promise.all([
        api.discoverProjects(owner, ownerType),
        api.discoverRepositories(ownerType === 'user' ? undefined : owner, ownerType),
      ])
      if (!mountedRef.current) return
      setDiscoverProjects(foundProjects)
      setDiscoverRepos(foundRepos)
    } catch (error) {
      if (!mountedRef.current) return
      setDiscoverError(messageOf(error))
    } finally {
      if (mountedRef.current) setDiscoverTargetBusy(false)
    }
  }

  const loadOrganizations = async (): Promise<void> => {
    setDiscoverBusy(true)
    setDiscoverError(undefined)
    try {
      const res = await api.discoverOrgs()
      if (!mountedRef.current) return
      setDiscoverLogin(res.login)
      setDiscoverOrgs(res.organizations)
      await selectDiscoverOwner(res.login, 'user')
    } catch (error) {
      if (!mountedRef.current) return
      setDiscoverError(messageOf(error))
    } finally {
      if (mountedRef.current) setDiscoverBusy(false)
    }
  }

  const toggleDiscoverProject = async (item: GitHubRemoteProjectSummary): Promise<void> => {
    const exists = projects.some(
      p => p.ownerType === item.ownerType && p.owner.toLowerCase() === item.owner.toLowerCase() && p.projectNumber === item.number,
    )
    const slug = `${item.ownerType === 'user' ? 'user' : 'org'}/${item.owner}/projects/${String(item.number)}`
    const edit = exists
      ? removeProject(projects, slug)
      : addProject(projects, slug, { title: item.title })
    if (!edit.ok) {
      setDiscoverError(edit.message)
      return
    }
    await writeProjectsList(edit.projects)
  }

  const toggleDiscoverRepository = async (item: GitHubRemoteRepositorySummary): Promise<void> => {
    const slug = `${item.owner}/${item.name}`
    const exists = repositories.some(
      r => r.owner.toLowerCase() === item.owner.toLowerCase() && r.repository.toLowerCase() === item.name.toLowerCase(),
    )
    const edit = exists ? removeRepository(repositories, slug) : addRepository(repositories, slug)
    if (!edit.ok) {
      setDiscoverError(edit.message)
      return
    }
    await write(edit.repositories)
  }

  const credential: GitHubCredentialStatus = status?.credential ?? {
    configured: mirror?.hasCredential === true,
    writable: false,
    envName: 'GITHUB_TOKEN',
  }
  const controlsDisabled = disabled || credentialBusy
  // The disclosure heading carries the fact the toggle is about (how many
  // repositories are behind it), so the accessible name has to include it
  // rather than replace it with the bare action.
  const repositoriesHeading = repositories.length === 0
    ? t('setup.repositoriesEmpty')
    : t('setup.repositoriesCount', { count: String(repositories.length) })
  const projectsHeading = projects.length === 0
    ? t('setup.projectsEmpty')
    : t('setup.projectsCount', { count: String(projects.length) })
  // What the Host says a request would actually dial, which is the only way a
  // user can tell that `auto` found the machine's system proxy. Absent means
  // nothing resolved: say which mode produced that instead of leaving a blank.
  const detected = status?.proxy
  const proxyLine = detected?.effective !== undefined
    ? t('setup.proxyDetected', { url: detected.effective, source: proxySourceLabel(t, detected.source) })
    : proxyMode === 'direct'
      ? t('setup.proxyDirectMode')
      : t('setup.proxyDirect')

  return (
    <div data-dsh-part="github-settings" className={css.setupPanel}>
      <h4 className={css.settingsSummaryTitle}>{t('summary.title')}</h4>

      {statusError !== undefined && (
        <p className={css.formError}>{t('setup.apiUnavailable', { error: statusError })}</p>
      )}

      {status?.health !== undefined && (
        <div className={css.setupSection} data-dsh-part="github-sync-health">
          <p className={css.setupLine} data-dsh-stale={status.health.staleSince !== undefined ? 'true' : undefined}>
            {status.health.staleSince !== undefined && status.health.lastSyncAt !== undefined
              ? t('setup.healthStale', { minutes: String(Math.floor((Date.now() - status.health.lastSyncAt) / 60000)) })
              : status.health.lastSyncAt !== undefined
                ? t('setup.healthOk', { at: new Date(status.health.lastSyncAt).toLocaleTimeString() })
                : t('setup.healthNever')}
          </p>
          {status.health.lastErrors.length > 0 && (
            <p className={css.formError}>{t('setup.healthErrors', { count: String(status.health.lastErrors.length) })}</p>
          )}
        </div>
      )}

      <div className={css.setupSection} data-dsh-part="github-credential">
        <p className={css.setupLine}>
          {credential.configured
            ? t('setup.credentialConfigured', { name: credential.envName, source: credential.source ?? t('setup.credentialSourceUnknown') })
            : t('setup.credentialMissing', { name: credential.envName })}
        </p>
        {credential.reason !== undefined && <p className={css.setupHint}>{credential.reason}</p>}
        <div className={css.setupRow}>
          <button
            type="button"
            className={css.primaryButton}
            data-dsh-part="github-device-login"
            disabled={controlsDisabled || deviceStarting || deviceFlow !== undefined}
            onClick={() => { void startDeviceLogin() }}
          >
            {deviceStarting ? t('setup.deviceLoginStarting') : t('setup.deviceLogin')}
          </button>
          <button
            type="button"
            className={css.ghostButton}
            data-dsh-part="github-local-login"
            disabled={controlsDisabled || localAuthBusy}
            onClick={() => { void importLocalLogin() }}
          >
            {localAuthBusy ? t('setup.localLoginImporting') : t('setup.localLogin')}
          </button>
          <button
            type="button"
            className={css.ghostButton}
            data-dsh-part="github-sync-now"
            disabled={disabled || syncingNow}
            onClick={() => { void handleSyncNow() }}
          >
            {syncingNow ? t('setup.syncingNow') : t('setup.syncNow')}
          </button>
        </div>
        {deviceFlow !== undefined && (
          <div className={css.deviceFlowBox} data-dsh-part="github-device-flow">
            <p className={css.setupLine}>
              {t('setup.deviceCodePrompt', { uri: deviceFlow.verificationUri })}{' '}
              <a href={deviceFlow.verificationUriComplete ?? deviceFlow.verificationUri} target="_blank" rel="noopener noreferrer" className={css.linkButton}>
                {deviceFlow.verificationUri}
              </a>
            </p>
            <div className={css.setupRow}>
              <code className={css.deviceCode} data-dsh-part="github-device-code">{deviceFlow.userCode}</code>
              <button
                type="button"
                className={css.ghostButton}
                data-dsh-part="github-device-copy"
                onClick={() => { void copyDeviceCode(deviceFlow.userCode) }}
              >
                {deviceCopied ? t('setup.deviceCopied') : t('setup.deviceCopyCode')}
              </button>
              <button
                type="button"
                className={css.ghostButton}
                data-dsh-part="github-device-cancel"
                onClick={() => { void cancelDeviceLogin() }}
              >
                {t('setup.deviceCancel')}
              </button>
            </div>
            <p className={css.setupHint}>{t('setup.devicePending')}</p>
          </div>
        )}
        {deviceLoginMessage !== undefined && <p className={css.setupHint}>{deviceLoginMessage}</p>}
        {localAuthNotice !== undefined && <p className={css.setupHint}>{localAuthNotice}</p>}
        {localAuthScopeWarn && <p className={css.formError}>{t('setup.localLoginMissingScope')}</p>}
        {syncNowNotice !== undefined && <p className={css.setupHint}>{syncNowNotice}</p>}
        {syncNowError !== undefined && <p className={css.formError}>{syncNowError}</p>}
        <div className={css.setupRow}>
          <input
            type="password"
            className={css.input}
            data-dsh-part="github-token"
            aria-label={t('setup.tokenLabel')}
            placeholder={t('setup.tokenPlaceholder')}
            value={token}
            autoComplete="off"
            spellCheck={false}
            disabled={controlsDisabled}
            onChange={event => setToken(event.target.value)}
          />
          <button
            type="button"
            className={css.primaryButton}
            data-dsh-part="github-token-save"
            disabled={controlsDisabled || token.trim() === ''}
            onClick={() => { void saveToken() }}
          >
            {credentialBusy ? t('setup.tokenSaving') : t('setup.tokenSave')}
          </button>
          {credential.configured && (
            <button type="button" className={css.ghostButton} disabled={controlsDisabled} onClick={() => { void clearToken() }}>
              {t('setup.tokenClear')}
            </button>
          )}
          <button type="button" className={css.ghostButton} disabled={disabled || testing} onClick={() => { void runTest() }}>
            {testing ? t('setup.testing') : t('setup.test')}
          </button>
        </div>
        <p className={css.setupHint}>{t('setup.tokenHint')}</p>
        {credentialError !== undefined && <p className={css.formError}>{credentialError}</p>}
        {credentialSaved && <p className={css.setupHint}>{t('setup.tokenSaved')}</p>}
        {testError !== undefined && <p className={css.formError}>{t('setup.testFailed', { error: testError })}</p>}
        {report !== undefined && (
          <div className={css.setupReport} data-dsh-part="github-test-report">
            <p className={css.setupLine}>
              {report.login === undefined
                ? t('setup.testNoCredential')
                : t('setup.testLogin', { login: report.login })}
            </p>
            {report.checks.map(check => (
              <p
                key={check.owner + '/' + check.repository}
                className={check.ok ? css.setupHint : css.formError}
                data-dsh-part="github-test-check"
              >
                {check.owner}/{check.repository} · {check.message}
              </p>
            ))}
            {(report.projectChecks ?? []).map(check => (
              <p
                key={`${check.ownerType}:${check.owner}#${String(check.projectNumber)}`}
                className={check.ok ? css.setupHint : css.formError}
                data-dsh-part="github-test-project-check"
              >
                {t('setup.testProjectCheck', {
                  owner: check.owner,
                  number: String(check.projectNumber),
                  message: check.message,
                })}
              </p>
            ))}
          </div>
        )}
      </div>

      <div className={css.setupSection} data-dsh-part="github-proxy">
        <p className={css.setupLine}>{t('setup.proxyTitle')}</p>
        <div className={css.setupRow}>
          <select
            className={css.input}
            data-dsh-part="github-proxy-mode"
            aria-label={t('setup.proxyModeLabel')}
            value={proxyMode}
            disabled={disabled || proxyBusy}
            onChange={event => {
              const next = event.target.value as GitHubProxyMode
              setProxyMode(next)
              void saveProxy(next, proxyUrlDraft)
            }}
          >
            {GITHUB_PROXY_MODES.map(mode => (
              <option key={mode} value={mode}>{proxyModeLabel(t, mode)}</option>
            ))}
          </select>
          {proxyMode === 'custom' && (
            <input
              type="text"
              className={css.input}
              data-dsh-part="github-proxy-url"
              aria-label={t('setup.proxyUrlLabel')}
              placeholder={t('setup.proxyUrlPlaceholder')}
              value={proxyUrlDraft}
              spellCheck={false}
              disabled={disabled || proxyBusy}
              onChange={event => setProxyUrlDraft(event.target.value)}
              onBlur={() => { if (proxyUrlDraft !== (status?.proxy.url ?? '')) void saveProxy(proxyMode, proxyUrlDraft) }}
              onKeyDown={event => { if (event.key === 'Enter') void saveProxy(proxyMode, proxyUrlDraft) }}
            />
          )}
        </div>
        <p className={css.setupLine} data-dsh-part="github-proxy-effective">{proxyLine}</p>
        <p className={css.setupHint}>{t('setup.proxyHint')}</p>
        {proxyError !== undefined && <p className={css.formError}>{proxyError}</p>}
      </div>

      <div className={css.setupSection} data-dsh-part="github-repositories">
        <button
          type="button"
          className={css.setupDisclosure}
          aria-expanded={repositoriesOpen}
          aria-controls={repositoriesRegionId}
          aria-label={(repositoriesOpen ? t('setup.repositoriesCollapse') : t('setup.repositoriesExpand')) + ': ' + repositoriesHeading}
          onClick={() => { setRepositoriesOpen(!repositoriesOpen) }}
        >
          <span className={css.setupDisclosureText}>{repositoriesHeading}</span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={repositoriesOpen ? css.setupChevron + ' ' + css.setupChevronOpen : css.setupChevron}
            aria-hidden="true"
          >
            <path
              d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z"
              fill="currentColor"
            />
          </svg>
        </button>
        {repositoriesOpen && (
        <div className={css.setupRepositoriesBody} id={repositoriesRegionId}>
        {repositories.map(repository => {
          const fullName = repository.owner + '/' + repository.repository
          const assignee = repository.assignee
          // The chip reads as a handle (@me, @octocat); the full "assignee"
          // wording stays available as the chip's title.
          const assigneeHandle = assignee !== undefined && assignee !== ''
            ? (assignee.startsWith('@') ? assignee : '@' + assignee)
            : undefined
          return (
            <div key={fullName} className={css.setupRepositoryRow} data-dsh-part="github-repository">
              <span className={css.setupRepository} title={fullName}>{fullName}</span>
              <span className={css.setupRepositoryTags}>
                <span className={css.cardTag}>{repository.inclusionLabel ?? 'dsh'}</span>
                {assigneeHandle !== undefined && (
                  <span className={css.cardTag} data-dsh-part="github-repository-assignee" title={t('setup.assignee')}>
                    {t('setup.assigneeChip', { login: assigneeHandle })}
                  </span>
                )}
                <button
                  type="button"
                  className={css.setupUnassignedToggle}
                  data-dsh-part="github-repository-unassigned-toggle"
                  aria-pressed={repository.includeUnassigned === true}
                  title={t('setup.unassignedChip')}
                  disabled={disabled || repositoryBusy}
                  onClick={() => { toggleUnassigned(repository, repository.includeUnassigned !== true) }}
                >
                  <span data-dsh-part="github-repository-unassigned">{t('setup.unassignedChip')}</span>
                </button>
              </span>
              <button
                type="button"
                className={css.setupRepositoryRemove}
                data-dsh-part="github-repository-remove"
                aria-label={t('setup.repositoryRemove')}
                title={t('setup.repositoryRemove')}
                disabled={disabled || repositoryBusy}
                onClick={() => { remove(repository) }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          )
        })}
        <div className={css.setupRow}>
          <input
            type="text"
            className={css.input}
            data-dsh-part="github-repository-input"
            aria-label={t('setup.repositoryLabel')}
            placeholder={t('setup.repositoryPlaceholder')}
            value={newRepository}
            spellCheck={false}
            disabled={disabled || repositoryBusy}
            onChange={event => setNewRepository(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') add() }}
          />
          <input
            type="text"
            className={css.input + ' ' + css.setupLabelInput}
            data-dsh-part="github-repository-label-input"
            aria-label={t('setup.inclusionLabel')}
            placeholder={t('setup.inclusionLabelPlaceholder')}
            value={newLabel}
            spellCheck={false}
            disabled={disabled || repositoryBusy}
            onChange={event => setNewLabel(event.target.value)}
          />
          <input
            type="text"
            className={css.input + ' ' + css.setupLabelInput}
            data-dsh-part="github-repository-assignee-input"
            aria-label={t('setup.assignee')}
            placeholder={t('setup.assigneePlaceholder')}
            value={newAssignee}
            spellCheck={false}
            disabled={disabled || repositoryBusy}
            onChange={event => setNewAssignee(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') add() }}
          />
          <button
            type="button"
            className={css.primaryButton}
            data-dsh-part="github-repository-add"
            disabled={disabled || repositoryBusy || newRepository.trim() === ''}
            onClick={add}
          >
            {t('setup.repositoryAdd')}
          </button>
        </div>
        <p className={css.setupHint}>{t('setup.repositoriesHint')}</p>
        {repositoryError !== undefined && <p className={css.formError}>{repositoryError}</p>}
        </div>
        )}
      </div>

      <div className={css.setupSection} data-dsh-part="github-projects">
        <button
          type="button"
          className={css.setupDisclosure}
          aria-expanded={projectsOpen}
          aria-controls={projectsRegionId}
          aria-label={(projectsOpen ? t('setup.projectsCollapse') : t('setup.projectsExpand')) + ': ' + projectsHeading}
          onClick={() => { setProjectsOpen(!projectsOpen) }}
        >
          <span className={css.setupDisclosureText}>{projectsHeading}</span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={projectsOpen ? css.setupChevron + ' ' + css.setupChevronOpen : css.setupChevron}
            aria-hidden="true"
          >
            <path
              d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z"
              fill="currentColor"
            />
          </svg>
        </button>
        {projectsOpen && (
          <div className={css.setupRepositoriesBody} id={projectsRegionId}>
            {projects.map(project => {
              const key = `${project.ownerType}:${project.owner.toLowerCase()}#${String(project.projectNumber)}`
              const display = `${project.owner}/${String(project.projectNumber)}${project.title ? ` · ${project.title}` : ''}`
              const defaultRepo = (project as GitHubProjectConfig & { defaultRepository?: string }).defaultRepository ?? projectDefaultRepos[key]
              return (
                <div key={key} className={css.setupRepositoryRow} data-dsh-part="github-project-row">
                  <span className={css.setupRepository} title={display}>{display}</span>
                  <span className={css.setupRepositoryTags}>
                    {defaultRepo !== undefined && defaultRepo !== '' && (
                      <span className={css.cardTag} data-dsh-part="github-project-default-repo">{defaultRepo}</span>
                    )}
                    <button
                      type="button"
                      className={css.setupUnassignedToggle}
                      data-dsh-part="github-project-drafts-toggle"
                      aria-pressed={project.includeDrafts !== false}
                      disabled={disabled || projectBusy}
                      onClick={() => { toggleProjectDrafts(project, project.includeDrafts === false) }}
                    >
                      {t('setup.projectDraftsChip')}
                    </button>
                  </span>
                  <button
                    type="button"
                    className={css.setupRepositoryRemove}
                    data-dsh-part="github-project-remove"
                    aria-label={t('setup.projectRemove')}
                    title={t('setup.projectRemove')}
                    disabled={disabled || projectBusy}
                    onClick={() => { removeProjectEntry(project) }}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                      <path d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              )
            })}
            <div className={css.setupRow}>
              <input
                type="text"
                className={css.input}
                data-dsh-part="github-project-input"
                aria-label={t('setup.projectInputLabel')}
                placeholder={t('setup.projectInputPlaceholder')}
                value={newProject}
                spellCheck={false}
                disabled={disabled || projectBusy}
                onChange={event => setNewProject(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') addProjectEntry() }}
              />
              <input
                type="text"
                className={css.input + ' ' + css.setupLabelInput}
                data-dsh-part="github-project-default-repo-input"
                aria-label={t('setup.projectDefaultRepoLabel')}
                placeholder={t('setup.projectDefaultRepoPlaceholder')}
                value={newProjectDefaultRepo}
                spellCheck={false}
                disabled={disabled || projectBusy}
                onChange={event => setNewProjectDefaultRepo(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') addProjectEntry() }}
              />
              <button
                type="button"
                className={css.primaryButton}
                data-dsh-part="github-project-add"
                disabled={disabled || projectBusy || newProject.trim() === ''}
                onClick={addProjectEntry}
              >
                {t('setup.projectAdd')}
              </button>
            </div>
            <p className={css.setupHint}>{t('setup.projectsHint')}</p>
            {projectError !== undefined && <p className={css.formError}>{projectError}</p>}
          </div>
        )}
      </div>

      <div className={css.setupSection} data-dsh-part="github-discover">
        <div className={css.setupRow}>
          <span className={css.setupLine}>{t('setup.discoverTitle')}</span>
          <button
            type="button"
            className={css.ghostButton}
            data-dsh-part="github-discover-load"
            disabled={disabled || discoverBusy}
            onClick={() => { void loadOrganizations() }}
          >
            {discoverBusy ? t('setup.discoverLoading') : t('setup.discoverLoad')}
          </button>
        </div>
        {discoverOrgs !== undefined && (
          <div>
            <div className={css.discoverOwnerTabs}>
              <button
                type="button"
                className={css.createBackendMode}
                data-dsh-part="github-discover-owner"
                aria-pressed={discoverOwner?.ownerType === 'user'}
                disabled={discoverTargetBusy}
                onClick={() => { void selectDiscoverOwner(discoverLogin ?? '', 'user') }}
              >
                {discoverLogin !== undefined && discoverLogin !== ''
                  ? `${t('setup.discoverPersonal')} (${discoverLogin})`
                  : t('setup.discoverPersonal')}
              </button>
              {discoverOrgs.map(org => (
                <button
                  key={org.login}
                  type="button"
                  className={css.createBackendMode}
                  data-dsh-part="github-discover-owner"
                  aria-pressed={discoverOwner?.ownerType === 'organization' && discoverOwner.owner === org.login}
                  disabled={discoverTargetBusy}
                  onClick={() => { void selectDiscoverOwner(org.login, 'organization') }}
                >
                  {org.login}
                </button>
              ))}
            </div>
            {discoverOwner !== undefined && (
              <div className={css.discoverGrid}>
                <p className={css.discoverSubheading}>{t('setup.discoverProjectsHeading')}</p>
                {discoverProjects.length === 0 ? (
                  <p className={css.setupHint}>{t('setup.discoverEmpty')}</p>
                ) : discoverProjects.map(item => {
                  const synced = projects.some(
                    p => p.ownerType === item.ownerType && p.owner.toLowerCase() === item.owner.toLowerCase() && p.projectNumber === item.number,
                  )
                  return (
                    <div key={item.id} className={css.setupRepositoryRow} data-dsh-part="github-discover-project">
                      <span className={css.setupRepository}>{item.owner}#{item.number} · {item.title}</span>
                      <button
                        type="button"
                        className={css.setupUnassignedToggle}
                        aria-pressed={synced}
                        disabled={disabled || projectBusy}
                        onClick={() => { void toggleDiscoverProject(item) }}
                      >
                        {synced ? t('setup.discoverSynced') : t('setup.discoverSync')}
                      </button>
                    </div>
                  )
                })}
                <p className={css.discoverSubheading}>{t('setup.discoverReposHeading')}</p>
                {discoverRepos.length === 0 ? (
                  <p className={css.setupHint}>{t('setup.discoverEmpty')}</p>
                ) : discoverRepos.map(item => {
                  const synced = repositories.some(
                    r => r.owner.toLowerCase() === item.owner.toLowerCase() && r.repository.toLowerCase() === item.name.toLowerCase(),
                  )
                  return (
                    <div key={item.fullName} className={css.setupRepositoryRow} data-dsh-part="github-discover-repo">
                      <span className={css.setupRepository}>{item.fullName}</span>
                      <button
                        type="button"
                        className={css.setupUnassignedToggle}
                        aria-pressed={synced}
                        disabled={disabled || repositoryBusy}
                        onClick={() => { void toggleDiscoverRepository(item) }}
                      >
                        {synced ? t('setup.discoverSynced') : t('setup.discoverSync')}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
        {discoverError !== undefined && <p className={css.formError}>{discoverError}</p>}
      </div>

      {statusError !== undefined && mirror !== undefined && (
        <div className={css.setupSection}>
          <GitHubSummaryBlock summary={mirror} />
        </div>
      )}
    </div>
  )
}

/** Read one failure the way the API phrased it. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One proxy mode, as the select labels it. */
function proxyModeLabel(t: SetupPanelTranslate, mode: GitHubProxyMode): string {
  if (mode === 'custom') return t('setup.proxyModeCustom')
  if (mode === 'direct') return t('setup.proxyModeDirect')
  return t('setup.proxyModeAuto')
}

/** Where a resolved proxy came from, as the detected line names it. */
function proxySourceLabel(t: SetupPanelTranslate, source: GitHubProxySource | undefined): string {
  if (source === 'env') return t('setup.proxySourceEnv')
  if (source === 'system') return t('setup.proxySourceSystem')
  return t('setup.proxySourceCustom')
}
