/**
 * Agent tool `task_board_github_create` tests:
 * - creating a repository issue task
 * - creating a project-issue task
 * - creating a project-draft task
 * - validation refusals on missing repository or project
 */
import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { TaskBoardExtension, TaskBoardExtensionHost } from '../src/core/contract.ts'
import type { GitHubCreateRemoteTaskRequest, GitHubCreateRemoteTaskResponse } from '../src/core/setup.ts'
import { readTaskGitHubMetadata } from '../src/core/types.ts'
import { GitHubApiClient } from '../src/host/client.ts'
import { GitHubSyncService } from '../src/host/service.ts'
import type { GitHubSetup } from '../src/host/setup.ts'
import { buildGitHubTools } from '../src/host/tools.ts'
import { FakeBoard } from './support/fake-board.ts'
import { FakeGitHubBackend } from './support/fake-github.ts'

function faceOf(board: FakeBoard): TaskBoardExtensionHost {
  let face: TaskBoardExtensionHost | undefined
  const stub: TaskBoardExtension = { id: 'github', apiVersion: 1, start: host => { face = host } }
  board.admit(stub)
  if (face === undefined) throw new Error('the fake board did not start the provider')
  return face
}

function findCreateTool(service: GitHubSyncService, setup: GitHubSetup): ToolDefinition {
  const tool = buildGitHubTools(service, setup).find(entry => entry.name === 'task_board_github_create')
  if (tool === undefined) throw new Error('task_board_github_create tool is not registered')
  return tool
}

async function run(tool: ToolDefinition, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await tool.execute(args, {} as never) as Record<string, unknown>
}

function makeSetupDouble(
  createRemoteTask: (input: GitHubCreateRemoteTaskRequest) => Promise<GitHubCreateRemoteTaskResponse>,
): GitHubSetup {
  return {
    status: async () => ({
      credential: { configured: true, writable: true, envName: 'GITHUB_TOKEN' },
      repositories: [],
      projects: [],
      running: true,
      settingsWritable: true,
      proxy: { mode: 'auto', url: '' },
    }),
    test: async () => ({
      ok: true,
      login: 'octocat',
      credential: { configured: true, writable: true, envName: 'GITHUB_TOKEN' },
      checks: [],
    }),
    setCredential: async () => { throw new Error('unused') },
    clearCredential: async () => { throw new Error('unused') },
    startDeviceAuth: async () => { throw new Error('unused') },
    pollDeviceAuth: async () => { throw new Error('unused') },
    cancelDeviceAuth: () => false,
    importLocalAuth: async () => ({ ok: false }),
    listRepositories: () => [],
    writeRepositories: async () => [],
    listProjects: () => [],
    writeProjects: async () => [],
    discoverOrgs: async () => [],
    discoverProjects: async () => [],
    discoverRepositories: async () => [],
    createRemoteTask,
    triggerSync: async () => ({ ok: true }),
    credential: async () => ({ configured: true, writable: true, envName: 'GITHUB_TOKEN' }),
    proxy: () => ({ mode: 'auto', url: '' }),
    setProxy: async () => { throw new Error('unused') },
  }
}

describe('task_board_github_create tool', () => {
  it('operator creates a repository issue task and materializes it with matched workspaceId', async () => {
    // Given a running sync service and a setup surface that creates a repo issue
    const board = new FakeBoard()
    const backend = new FakeGitHubBackend()
    const service = new GitHubSyncService({
      host: faceOf(board),
      client: new GitHubApiClient({ token: 'test-token', fetch: backend.fetch }),
      now: () => 1_000,
    })
    const createSpy = vi.fn(async (input: GitHubCreateRemoteTaskRequest): Promise<GitHubCreateRemoteTaskResponse> => ({
      title: input.title,
      description: input.body ?? '',
      prompt: `Work on ${input.title}`,
      status: input.status,
      suggestedPrompt: `Work on ${input.title}`,
      suggestedWorkspaceId: 'ws-dsh-web',
      payload: {
        provider: 'github',
        owner: input.owner!,
        repository: input.repository!,
        issueNumber: 101,
        issueUrl: `https://github.com/${input.owner}/${input.repository}/issues/101`,
        remoteTitle: input.title,
        remoteBody: input.body ?? '',
        remoteState: 'open',
        remoteLabels: input.labels ?? [],
        lastSyncedAt: 1_000,
      },
    }))
    const tool = findCreateTool(service, makeSetupDouble(createSpy))

    // When the agent creates a task in issue mode
    const result = await run(tool, {
      mode: 'issue',
      title: 'Fix login redirect',
      description: 'Handle OAuth callback',
      repository: 'deepseek-ai/dsh-web',
      labels: ['bug'],
      assignee: '@me',
      status: 'todo',
    })

    // Then the remote issue is created and materialized on the board with workspaceId
    expect(createSpy).toHaveBeenCalledWith({
      mode: 'issue',
      owner: 'deepseek-ai',
      repository: 'dsh-web',
      title: 'Fix login redirect',
      body: 'Handle OAuth callback',
      status: 'todo',
      labels: ['bug'],
      assignees: ['@me'],
    })
    expect(result).toMatchObject({
      ok: true,
      task: {
        title: 'Fix login redirect',
        status: 'todo',
        github: { owner: 'deepseek-ai', repository: 'dsh-web', issueNumber: 101 },
      },
    })
    const created = [...board.records.values()][0]!
    expect(created.workspaceId).toBe('ws-dsh-web')
    expect(readTaskGitHubMetadata(created)?.issueNumber).toBe(101)
  })

  it('operator creates a project-issue task linked to both a repository issue and a Project v2 item', async () => {
    // Given a running sync service and setup surface supporting project-issue mode
    const board = new FakeBoard()
    const backend = new FakeGitHubBackend()
    const service = new GitHubSyncService({
      host: faceOf(board),
      client: new GitHubApiClient({ token: 'test-token', fetch: backend.fetch }),
    })
    const createSpy = vi.fn(async (input: GitHubCreateRemoteTaskRequest): Promise<GitHubCreateRemoteTaskResponse> => ({
      title: input.title,
      description: input.body ?? '',
      prompt: `Project issue: ${input.title}`,
      status: 'running',
      suggestedPrompt: `Project issue: ${input.title}`,
      payload: {
        provider: 'github',
        owner: input.owner!,
        repository: input.repository!,
        issueNumber: 202,
        issueUrl: `https://github.com/${input.owner}/${input.repository}/issues/202`,
        remoteTitle: input.title,
        remoteBody: input.body ?? '',
        remoteState: 'open',
        remoteLabels: [],
        project: {
          projectId: 'PVT_1',
          projectNumber: input.projectNumber!,
          ownerType: input.projectOwnerType!,
          owner: input.projectOwner!,
          itemId: 'PVTI_202',
          statusName: 'In Progress',
        },
      },
    }))
    const tool = findCreateTool(service, makeSetupDouble(createSpy))

    // When the agent creates a task in project-issue mode
    const result = await run(tool, {
      mode: 'project-issue',
      title: 'Add Project v2 sync',
      repository: 'deepseek-ai/dsh-web',
      project: 'https://github.com/orgs/deepseek-ai/projects/5',
      status: 'running',
    })

    // Then the created card carries both issue and project metadata
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'project-issue',
      owner: 'deepseek-ai',
      repository: 'dsh-web',
      projectOwnerType: 'organization',
      projectOwner: 'deepseek-ai',
      projectNumber: 5,
      status: 'running',
    }))
    expect(result).toMatchObject({
      ok: true,
      task: {
        status: 'running',
        github: {
          issueNumber: 202,
          project: { projectId: 'PVT_1', projectNumber: 5, itemId: 'PVTI_202' },
        },
      },
    })
  })

  it('operator creates a project-draft task inside a Project v2 without a repository', async () => {
    // Given a running sync service and setup surface supporting project-draft mode
    const board = new FakeBoard()
    const backend = new FakeGitHubBackend()
    const service = new GitHubSyncService({
      host: faceOf(board),
      client: new GitHubApiClient({ token: 'test-token', fetch: backend.fetch }),
    })
    const createSpy = vi.fn(async (input: GitHubCreateRemoteTaskRequest): Promise<GitHubCreateRemoteTaskResponse> => ({
      title: input.title,
      description: input.body ?? '',
      prompt: `Draft: ${input.title}`,
      status: 'backlog',
      suggestedPrompt: `Draft: ${input.title}`,
      payload: {
        provider: 'github',
        owner: input.projectOwner!,
        repository: '',
        issueNumber: 0,
        issueUrl: `https://github.com/orgs/${input.projectOwner}/projects/${String(input.projectNumber)}`,
        remoteTitle: input.title,
        remoteBody: input.body ?? '',
        remoteLabels: [],
        project: {
          projectId: 'PVT_1',
          projectNumber: input.projectNumber!,
          ownerType: input.projectOwnerType!,
          owner: input.projectOwner!,
          itemId: 'PVTI_draft_1',
          isDraft: true,
          draftIssueId: 'DI_1',
        },
      },
    }))
    const tool = findCreateTool(service, makeSetupDouble(createSpy))

    // When the agent creates a task in project-draft mode
    const result = await run(tool, {
      mode: 'project-draft',
      title: 'Explore architecture',
      description: 'Draft notes',
      project: 'org/deepseek-ai/projects/5',
      status: 'backlog',
    })

    // Then the card is materialized as a draft project card
    expect(result).toMatchObject({
      ok: true,
      task: {
        title: 'Explore architecture',
        status: 'backlog',
        github: {
          project: { isDraft: true, itemId: 'PVTI_draft_1', draftIssueId: 'DI_1' },
        },
      },
    })
  })

  it('operator refuses invalid mode arguments before calling createRemoteTask', async () => {
    // Given a setup surface that should never be called on invalid input
    const board = new FakeBoard()
    const backend = new FakeGitHubBackend()
    const service = new GitHubSyncService({
      host: faceOf(board),
      client: new GitHubApiClient({ token: 'test-token', fetch: backend.fetch }),
    })
    const createSpy = vi.fn()
    const tool = findCreateTool(service, makeSetupDouble(createSpy))

    // When repository is missing for issue mode or project is missing for project-draft mode
    const missingRepo = await run(tool, { mode: 'issue', title: 'Missing repo' })
    const missingProject = await run(tool, { mode: 'project-draft', title: 'Missing project' })

    // Then both return structured refusals and createRemoteTask is never called
    expect(missingRepo).toMatchObject({ ok: false, code: 'invalid-repository' })
    expect(missingProject).toMatchObject({ ok: false, code: 'invalid-project' })
    expect(createSpy).not.toHaveBeenCalled()
  })
})
