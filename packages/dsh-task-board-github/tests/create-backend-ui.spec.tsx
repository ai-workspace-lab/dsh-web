// @vitest-environment jsdom
/**
 * Task-create backend picker UI: verifies Local board, GitHub Issue,
 * GitHub Project + Issue, and GitHub Project Draft modes, plus onSelect and
 * prepareCreate behavior.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubCreateRemoteTaskRequest, GitHubSetupSummary } from '../src/core/setup.ts'
import { GITHUB_EXTENSION_ID } from '../src/core/types.ts'
import { GitHubCreateBackendSection, type GitHubCreateBackendSelection } from '../src/client/github/create-backend.tsx'
import { setSummary } from '../src/client/github/summary.ts'
import type { GitHubSetupApi } from '../src/client/setup-api.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

beforeEach(() => {
  document.documentElement.lang = 'en'
  setSummary({
    enabled: true,
    hasCredential: true,
    repositories: [
      { owner: 'deepseek-ai', repository: 'dsh-web', inclusionLabel: 'dsh', prCreationEnabled: false, hasCredential: true },
    ],
    projects: [
      { ownerType: 'organization', owner: 'deepseek-ai', projectNumber: 7, title: 'Roadmap', defaultRepository: 'deepseek-ai/dsh-web' },
    ],
  })
})

afterEach(() => {
  setSummary(undefined)
  for (const root of roots.splice(0)) {
    act(() => { root.unmount() })
  }
  document.body.replaceChildren()
})

function mockSetupApi(createdRequests: GitHubCreateRemoteTaskRequest[] = []): GitHubSetupApi {
  const summary: GitHubSetupSummary = {
    credential: { configured: true, writable: true, envName: 'GITHUB_TOKEN', source: 'store' },
    repositories: [{ owner: 'deepseek-ai', repository: 'dsh-web', inclusionLabel: 'dsh' }],
    projects: [{ ownerType: 'organization', owner: 'deepseek-ai', projectNumber: 7, title: 'Roadmap' }],
    running: true,
    settingsWritable: true,
    proxy: { mode: 'auto', url: '' },
  }
  return {
    status: async () => summary,
    test: async () => ({ ok: true, credential: summary.credential, checks: [] }),
    setCredential: async () => summary,
    clearCredential: async () => summary,
    listRepositories: async () => summary.repositories,
    writeRepositories: async repos => [...repos],
    setProxy: async () => summary,
    startDeviceAuth: async () => ({ flowId: 'f1', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }),
    pollDeviceAuth: async () => ({ status: 'pending', interval: 5 }),
    cancelDeviceAuth: async () => {},
    importLocalAuth: async () => ({ ok: false, message: 'none' }),
    listProjects: async () => summary.projects,
    writeProjects: async projs => [...projs],
    discoverOrgs: async () => ({ login: 'octocat', organizations: [{ login: 'deepseek-ai' }] }),
    discoverProjects: async () => [],
    discoverRepositories: async () => [],
    createRemoteTask: async (request) => {
      createdRequests.push(request)
      return {
        title: request.title,
        description: request.body ?? '',
        prompt: request.prompt ?? 'Suggested prompt from GitHub',
        suggestedPrompt: 'Suggested prompt from GitHub',
        suggestedWorkspaceId: 'ws-dsh-web',
        payload: {
          provider: 'github',
          owner: request.owner ?? '',
          repository: request.repository ?? '',
          issueNumber: request.mode === 'project-draft' ? 0 : 42,
          issueUrl: 'https://github.com/deepseek-ai/dsh-web/issues/42',
          remoteLabels: request.labels ?? [],
          ...(request.projectOwner !== undefined ? {
            project: {
              projectId: 'PVT_1',
              projectNumber: request.projectNumber ?? 1,
              ownerType: request.projectOwnerType ?? 'organization',
              owner: request.projectOwner,
              itemId: 'PVTI_1',
              isDraft: request.mode === 'project-draft',
            },
          } : {}),
        },
      }
    },
    triggerSync: async () => ({ synced: 0, errors: [] }),
  }
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function renderSection(api: GitHubSetupApi, onSelect: (sel: GitHubCreateBackendSelection | undefined) => void) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<GitHubCreateBackendSection api={api} onSelect={onSelect} />)
  })
  return container
}

describe('GitHubCreateBackendSection', () => {
  it('operator defaults to Local board and calls onSelect(undefined)', async () => {
    // Given a rendered backend picker with configured summary
    const onSelect = vi.fn()
    const api = mockSetupApi()
    const container = await renderSection(api, onSelect)

    // When initially mounted
    const localBtn = container.querySelector('[data-dsh-part="github-create-mode-local"]') as HTMLButtonElement

    // Then Local mode is pressed and onSelect was called with undefined
    expect(localBtn.getAttribute('aria-pressed')).toBe('true')
    expect(onSelect).toHaveBeenLastCalledWith(undefined)
  })

  it('operator creates a GitHub Issue via prepareCreate when GitHub Issue mode is selected', async () => {
    // Given a backend picker and request recorder
    const created: GitHubCreateRemoteTaskRequest[] = []
    let latestSelection: GitHubCreateBackendSelection | undefined
    const api = mockSetupApi(created)
    const container = await renderSection(api, sel => { latestSelection = sel })

    // When the user switches to GitHub Issue and fills labels and assignee
    const issueBtn = container.querySelector('[data-dsh-part="github-create-mode-issue"]') as HTMLButtonElement
    await act(async () => { issueBtn.click() })
    const labelsInput = container.querySelector('[data-dsh-part="github-create-labels"]') as HTMLInputElement
    const assigneeInput = container.querySelector('[data-dsh-part="github-create-assignee"]') as HTMLInputElement
    await act(async () => {
      setInputValue(labelsInput, 'bug, dsh')
      setInputValue(assigneeInput, '@me')
    })

    // Then onSelect provides a GitHub selection and prepareCreate calls createRemoteTask
    expect(latestSelection?.extensionId).toBe(GITHUB_EXTENSION_ID)
    const prepared = await latestSelection!.prepareCreate({
      title: 'Fix login',
      description: 'Details',
      prompt: '',
      tags: [],
    })
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      mode: 'issue',
      owner: 'deepseek-ai',
      repository: 'dsh-web',
      labels: ['bug', 'dsh'],
      assignees: ['@me'],
    })
    expect(prepared.prompt).toBe('Suggested prompt from GitHub')
    expect(prepared.workspaceId).toBe('ws-dsh-web')
  })

  it('operator creates a Project Issue and a Project Draft in GitHub Project mode', async () => {
    // Given a backend picker
    const created: GitHubCreateRemoteTaskRequest[] = []
    let latestSelection: GitHubCreateBackendSelection | undefined
    const api = mockSetupApi(created)
    const container = await renderSection(api, sel => { latestSelection = sel })

    // When the user switches to GitHub Project (Repo Issue + Project by default)
    const projectBtn = container.querySelector('[data-dsh-part="github-create-mode-project"]') as HTMLButtonElement
    await act(async () => { projectBtn.click() })

    // Then prepareCreate sends mode project-issue with project and repo
    await latestSelection!.prepareCreate({ title: 'Proj Issue', description: '', prompt: 'Custom', tags: [] })
    expect(created[0]).toMatchObject({
      mode: 'project-issue',
      projectOwner: 'deepseek-ai',
      projectNumber: 7,
      owner: 'deepseek-ai',
      repository: 'dsh-web',
    })

    // When the user switches item kind to Draft Issue
    const draftBtn = container.querySelector('[data-dsh-part="github-create-kind-draft"]') as HTMLButtonElement
    await act(async () => { draftBtn.click() })

    // Then prepareCreate sends mode project-draft without repo
    await latestSelection!.prepareCreate({ title: 'Draft Item', description: '', prompt: '', tags: [] })
    expect(created[1]).toMatchObject({
      mode: 'project-draft',
      projectOwner: 'deepseek-ai',
      projectNumber: 7,
    })
    expect(created[1]!.repository).toBeUndefined()
  })
})
