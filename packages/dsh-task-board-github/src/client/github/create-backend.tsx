/**
 * Task-create backend picker contributed to the board's NewTaskModal.
 *
 * Lets a user create a card backed by a GitHub Issue, a GitHub Project v2
 * repository issue, or a GitHub Project v2 draft issue directly from the
 * board's create dialog, while keeping Local board as the default.
 *
 * @module dsh-task-board-github/client/github/create-backend
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TaskBoardExtensionDispatch, TaskBoardExtensionPayload } from '../../core/contract.ts'
import { parseProjectInput, parseRepositoryInput, type GitHubCreateRemoteTaskRequest } from '../../core/setup.ts'
import {
  GITHUB_EXTENSION_ID,
  type GitHubProjectOwnerType,
  type GitHubRemoteProjectSummary,
  type GitHubRemoteRepositorySummary,
} from '../../core/types.ts'
import { t } from '../locales.ts'
import { createGitHubSetupApi, type GitHubSetupApi } from '../setup-api.ts'
import { useGitHubSummary } from './summary.ts'
import css from '../github.module.css'

export type CreateBackendMode = 'local' | 'issue' | 'project'
export type ProjectCreateKind = 'project-issue' | 'project-draft'

export interface GitHubCreateBackendDraft {
  title: string
  description: string
  prompt: string
  tags: readonly string[]
  workspaceId?: string
}

export interface GitHubCreateBackendPrepared {
  payload: TaskBoardExtensionPayload
  prompt?: string
  workspaceId?: string
}

export interface GitHubCreateBackendSelection {
  extensionId: string
  label: string
  prepareCreate(draft: GitHubCreateBackendDraft): Promise<GitHubCreateBackendPrepared>
}

export interface GitHubCreateBackendSectionProps {
  title?: string
  description?: string
  prompt?: string
  tags?: readonly string[]
  workspaceId?: string
  pending?: boolean
  selected?: GitHubCreateBackendSelection
  onSelect: (backend: GitHubCreateBackendSelection | undefined) => void
  dispatch?: TaskBoardExtensionDispatch
  api?: GitHubSetupApi
}

let defaultCreateBackendApi: GitHubSetupApi | undefined

/** Wire the host setup API used when the seat renders without an explicit `api` prop. */
export function setCreateBackendApi(api: GitHubSetupApi | undefined): void {
  defaultCreateBackendApi = api
}

interface RepoOption {
  slug: string
  owner: string
  repository: string
}

interface ProjectOption {
  key: string
  ownerType: GitHubProjectOwnerType
  owner: string
  projectNumber: number
  label: string
  defaultRepository?: string
}

/** Compact inline Task Backend picker rendered inside NewTaskModal. */
export function GitHubCreateBackendSection(props: GitHubCreateBackendSectionProps) {
  const api = useMemo(() => props.api ?? defaultCreateBackendApi ?? createGitHubSetupApi(), [props.api])
  const summary = useGitHubSummary()

  const [mode, setMode] = useState<CreateBackendMode>('local')
  const [projectKind, setProjectKind] = useState<ProjectCreateKind>('project-issue')
  const [selectedRepo, setSelectedRepo] = useState('')
  const [customRepo, setCustomRepo] = useState('')
  const [selectedProject, setSelectedProject] = useState('')
  const [customProject, setCustomProject] = useState('')
  const [labelsInput, setLabelsInput] = useState('')
  const [assigneeInput, setAssigneeInput] = useState('')

  const [statusRepos, setStatusRepos] = useState<RepoOption[]>([])
  const [statusProjects, setStatusProjects] = useState<ProjectOption[]>([])
  const [statusLoaded, setStatusLoaded] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [browseError, setBrowseError] = useState<string | undefined>()
  const [discoveredRepos, setDiscoveredRepos] = useState<GitHubRemoteRepositorySummary[]>([])
  const [discoveredProjects, setDiscoveredProjects] = useState<GitHubRemoteProjectSummary[]>([])

  const onSelectRef = useRef(props.onSelect)
  onSelectRef.current = props.onSelect

  // Lazy-load full setup status when switched away from local board.
  useEffect(() => {
    if (mode === 'local' || statusLoaded) return
    let active = true
    void (async () => {
      try {
        const next = await api.status()
        if (!active) return
        setStatusRepos(next.repositories.map(r => ({
          slug: `${r.owner}/${r.repository}`,
          owner: r.owner,
          repository: r.repository,
        })))
        setStatusProjects((next.projects ?? []).map(p => ({
          key: `${p.ownerType}:${p.owner.toLowerCase()}#${String(p.projectNumber)}`,
          ownerType: p.ownerType,
          owner: p.owner,
          projectNumber: p.projectNumber,
          label: `${p.owner}#${String(p.projectNumber)}${p.title ? ` · ${p.title}` : ''}`,
          ...((p as { defaultRepository?: string }).defaultRepository ? { defaultRepository: (p as { defaultRepository?: string }).defaultRepository } : {}),
        })))
        setStatusLoaded(true)
      } catch {
        // Summary from mirror still provides configured items if status is unreachable.
      }
    })()
    return () => { active = false }
  }, [api, mode, statusLoaded])

  const repoOptions = useMemo<RepoOption[]>(() => {
    const map = new Map<string, RepoOption>()
    for (const r of summary?.repositories ?? []) {
      const slug = `${r.owner}/${r.repository}`
      map.set(slug.toLowerCase(), { slug, owner: r.owner, repository: r.repository })
    }
    for (const r of statusRepos) {
      map.set(r.slug.toLowerCase(), r)
    }
    for (const r of discoveredRepos) {
      const slug = `${r.owner}/${r.name}`
      if (!map.has(slug.toLowerCase())) {
        map.set(slug.toLowerCase(), { slug, owner: r.owner, repository: r.name })
      }
    }
    return [...map.values()]
  }, [summary?.repositories, statusRepos, discoveredRepos])

  const projectOptions = useMemo<ProjectOption[]>(() => {
    const map = new Map<string, ProjectOption>()
    for (const p of summary?.projects ?? []) {
      const key = `${p.ownerType}:${p.owner.toLowerCase()}#${String(p.projectNumber)}`
      map.set(key, {
        key,
        ownerType: p.ownerType,
        owner: p.owner,
        projectNumber: p.projectNumber,
        label: `${p.owner}#${String(p.projectNumber)}${p.title ? ` · ${p.title}` : ''}`,
        ...(p.defaultRepository !== undefined ? { defaultRepository: p.defaultRepository } : {}),
      })
    }
    for (const p of statusProjects) {
      map.set(p.key, p)
    }
    for (const p of discoveredProjects) {
      const key = `${p.ownerType}:${p.owner.toLowerCase()}#${String(p.number)}`
      if (!map.has(key)) {
        map.set(key, {
          key,
          ownerType: p.ownerType,
          owner: p.owner,
          projectNumber: p.number,
          label: `${p.owner}#${String(p.number)}${p.title ? ` · ${p.title}` : ''}`,
        })
      }
    }
    return [...map.values()]
  }, [summary?.projects, statusProjects, discoveredProjects])

  // Auto-select first configured option when none is chosen yet.
  useEffect(() => {
    if (selectedRepo === '' && repoOptions.length > 0) {
      setSelectedRepo(repoOptions[0]!.slug)
    }
  }, [repoOptions, selectedRepo])

  useEffect(() => {
    if (selectedProject === '' && projectOptions.length > 0) {
      const first = projectOptions[0]!
      setSelectedProject(first.key)
      if (first.defaultRepository !== undefined && first.defaultRepository !== '') {
        setSelectedRepo(first.defaultRepository)
      }
    }
  }, [projectOptions, selectedProject])

  const resolvedRepo = useMemo(() => {
    if (customRepo.trim() !== '') return parseRepositoryInput(customRepo)
    if (selectedRepo !== '') return parseRepositoryInput(selectedRepo)
    return undefined
  }, [customRepo, selectedRepo])

  const resolvedProject = useMemo(() => {
    if (customProject.trim() !== '') return parseProjectInput(customProject)
    if (selectedProject !== '') {
      const found = projectOptions.find(p => p.key === selectedProject)
      if (found !== undefined) {
        return {
          ownerType: found.ownerType,
          owner: found.owner,
          projectNumber: found.projectNumber,
        }
      }
    }
    return undefined
  }, [customProject, projectOptions, selectedProject])

  const handleBrowse = async (): Promise<void> => {
    setBrowsing(true)
    setBrowseError(undefined)
    try {
      const { login, organizations } = await api.discoverOrgs()
      const owners: Array<{ owner: string; ownerType: GitHubProjectOwnerType }> = [
        { owner: login, ownerType: 'user' },
        ...organizations.map(o => ({ owner: o.login, ownerType: 'organization' as const })),
      ]
      const [projLists, repoLists] = await Promise.all([
        Promise.all(owners.map(o => api.discoverProjects(o.owner, o.ownerType).catch(() => []))),
        Promise.all(owners.map(o => api.discoverRepositories(o.ownerType === 'user' ? undefined : o.owner, o.ownerType).catch(() => []))),
      ])
      setDiscoveredProjects(projLists.flat())
      setDiscoveredRepos(repoLists.flat())
    } catch (error) {
      setBrowseError(error instanceof Error ? error.message : String(error))
    } finally {
      setBrowsing(false)
    }
  }

  // Publish selection whenever mode or target parameters change.
  useEffect(() => {
    if (mode === 'local') {
      onSelectRef.current(undefined)
      return
    }
    if (mode === 'issue') {
      if (resolvedRepo === undefined) {
        onSelectRef.current(undefined)
        return
      }
      const labels = labelsInput.split(',').map(s => s.trim()).filter(Boolean)
      const assignee = assigneeInput.trim()
      const targetSlug = `${resolvedRepo.owner}/${resolvedRepo.repository}`
      onSelectRef.current({
        extensionId: GITHUB_EXTENSION_ID,
        label: `GitHub: ${targetSlug}`,
        prepareCreate: async (draft) => {
          const request: GitHubCreateRemoteTaskRequest = {
            mode: 'issue',
            owner: resolvedRepo.owner,
            repository: resolvedRepo.repository,
            title: draft.title,
            ...(draft.description !== '' ? { body: draft.description } : {}),
            ...(draft.prompt !== '' ? { prompt: draft.prompt } : {}),
            ...(labels.length > 0 ? { labels } : {}),
            ...(assignee !== '' ? { assignees: [assignee] } : {}),
          }
          const res = await api.createRemoteTask(request)
          return {
            payload: res.payload as unknown as TaskBoardExtensionPayload,
            ...(draft.prompt.trim() === '' && res.suggestedPrompt ? { prompt: res.suggestedPrompt } : {}),
            ...(res.suggestedWorkspaceId ? { workspaceId: res.suggestedWorkspaceId } : {}),
          }
        },
      })
      return
    }
    // mode === 'project'
    if (resolvedProject === undefined || (projectKind === 'project-issue' && resolvedRepo === undefined)) {
      onSelectRef.current(undefined)
      return
    }
    const labels = labelsInput.split(',').map(s => s.trim()).filter(Boolean)
    const assignee = assigneeInput.trim()
    const projectLabel = `${resolvedProject.owner}#${String(resolvedProject.projectNumber)}`
    onSelectRef.current({
      extensionId: GITHUB_EXTENSION_ID,
      label: projectKind === 'project-draft' ? `Project Draft: ${projectLabel}` : `Project Issue: ${projectLabel}`,
      prepareCreate: async (draft) => {
        const request: GitHubCreateRemoteTaskRequest = {
          mode: projectKind,
          projectOwnerType: resolvedProject.ownerType,
          projectOwner: resolvedProject.owner,
          projectNumber: resolvedProject.projectNumber,
          ...(projectKind === 'project-issue' && resolvedRepo !== undefined
            ? { owner: resolvedRepo.owner, repository: resolvedRepo.repository }
            : {}),
          title: draft.title,
          ...(draft.description !== '' ? { body: draft.description } : {}),
          ...(draft.prompt !== '' ? { prompt: draft.prompt } : {}),
          ...(labels.length > 0 ? { labels } : {}),
          ...(assignee !== '' ? { assignees: [assignee] } : {}),
        }
        const res = await api.createRemoteTask(request)
        return {
          payload: res.payload as unknown as TaskBoardExtensionPayload,
          ...(draft.prompt.trim() === '' && res.suggestedPrompt ? { prompt: res.suggestedPrompt } : {}),
          ...(res.suggestedWorkspaceId ? { workspaceId: res.suggestedWorkspaceId } : {}),
        }
      },
    })
  }, [api, assigneeInput, labelsInput, mode, projectKind, resolvedProject, resolvedRepo])

  const targetValid = mode === 'local'
    || (mode === 'issue' && resolvedRepo !== undefined)
    || (mode === 'project' && resolvedProject !== undefined && (projectKind === 'project-draft' || resolvedRepo !== undefined))

  const disabled = props.pending === true

  return (
    <div className={css.createBackendSection} data-dsh-part="github-create-backend">
      <div className={css.setupRow} style={{ justifyContent: 'space-between', margin: 0 }}>
        <span className={css.fieldLabel}>{t('create.title')}</span>
        {mode !== 'local' && (
          <button
            type="button"
            className={css.ghostButton}
            data-dsh-part="github-create-browse"
            disabled={disabled || browsing}
            onClick={() => { void handleBrowse() }}
          >
            {browsing ? t('create.browsingGithub') : t('create.browseGithub')}
          </button>
        )}
      </div>
      <div className={css.createBackendModes}>
        <button
          type="button"
          className={css.createBackendMode}
          data-dsh-part="github-create-mode-local"
          aria-pressed={mode === 'local'}
          disabled={disabled}
          onClick={() => setMode('local')}
        >
          {t('create.modeLocal')}
        </button>
        <button
          type="button"
          className={css.createBackendMode}
          data-dsh-part="github-create-mode-issue"
          aria-pressed={mode === 'issue'}
          disabled={disabled}
          onClick={() => setMode('issue')}
        >
          {t('create.modeIssue')}
        </button>
        <button
          type="button"
          className={css.createBackendMode}
          data-dsh-part="github-create-mode-project"
          aria-pressed={mode === 'project'}
          disabled={disabled}
          onClick={() => setMode('project')}
        >
          {t('create.modeProject')}
        </button>
      </div>

      {mode === 'project' && (
        <>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('create.projectLabel')}</span>
            {projectOptions.length > 0 && (
              <select
                className={css.input}
                data-dsh-part="github-create-project-select"
                value={selectedProject}
                disabled={disabled}
                onChange={event => {
                  const key = event.target.value
                  setSelectedProject(key)
                  setCustomProject('')
                  const found = projectOptions.find(p => p.key === key)
                  if (found?.defaultRepository !== undefined && found.defaultRepository !== '') {
                    setSelectedRepo(found.defaultRepository)
                    setCustomRepo('')
                  }
                }}
              >
                {projectOptions.map(option => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
            )}
            <input
              type="text"
              className={css.input}
              data-dsh-part="github-create-project-input"
              placeholder={t('create.projectCustomPlaceholder')}
              value={customProject}
              spellCheck={false}
              disabled={disabled}
              onChange={event => setCustomProject(event.target.value)}
            />
          </label>
          <div className={css.createBackendModes}>
            <button
              type="button"
              className={css.createBackendMode}
              data-dsh-part="github-create-kind-issue"
              aria-pressed={projectKind === 'project-issue'}
              disabled={disabled}
              onClick={() => setProjectKind('project-issue')}
            >
              {t('create.projectKindIssue')}
            </button>
            <button
              type="button"
              className={css.createBackendMode}
              data-dsh-part="github-create-kind-draft"
              aria-pressed={projectKind === 'project-draft'}
              disabled={disabled}
              onClick={() => setProjectKind('project-draft')}
            >
              {t('create.projectKindDraft')}
            </button>
          </div>
        </>
      )}

      {(mode === 'issue' || (mode === 'project' && projectKind === 'project-issue')) && (
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('create.repoLabel')}</span>
          {repoOptions.length > 0 && (
            <select
              className={css.input}
              data-dsh-part="github-create-repo-select"
              value={selectedRepo}
              disabled={disabled}
              onChange={event => {
                setSelectedRepo(event.target.value)
                setCustomRepo('')
              }}
            >
              {repoOptions.map(option => (
                <option key={option.slug} value={option.slug}>{option.slug}</option>
              ))}
            </select>
          )}
          <input
            type="text"
            className={css.input}
            data-dsh-part="github-create-repo-input"
            placeholder={t('create.repoCustomPlaceholder')}
            value={customRepo}
            spellCheck={false}
            disabled={disabled}
            onChange={event => setCustomRepo(event.target.value)}
          />
        </label>
      )}

      {(mode === 'issue' || (mode === 'project' && projectKind === 'project-issue')) && (
        <div className={css.setupRow} style={{ margin: 0 }}>
          <input
            type="text"
            className={css.input}
            data-dsh-part="github-create-labels"
            aria-label={t('create.labelsLabel')}
            placeholder={t('create.labelsPlaceholder')}
            value={labelsInput}
            spellCheck={false}
            disabled={disabled}
            onChange={event => setLabelsInput(event.target.value)}
          />
          <input
            type="text"
            className={css.input + ' ' + css.setupLabelInput}
            data-dsh-part="github-create-assignee"
            aria-label={t('create.assigneeLabel')}
            placeholder={t('create.assigneePlaceholder')}
            value={assigneeInput}
            spellCheck={false}
            disabled={disabled}
            onChange={event => setAssigneeInput(event.target.value)}
          />
        </div>
      )}

      {browseError !== undefined && <p className={css.formError}>{browseError}</p>}
      {!targetValid && <p className={css.setupHint}>{t('create.targetInvalid')}</p>}
    </div>
  )
}
