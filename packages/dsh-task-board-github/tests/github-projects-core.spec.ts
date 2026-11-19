/**
 * Core & API client tests for GitHub Projects v2:
 * - Metadata validation & normalization for Issue and DraftIssue items
 * - Status mapping & projection/reconciliation
 * - GraphQL & REST discovery/mutation methods on GitHubApiClient
 *
 * @module tests/github-projects-core.spec
 */
import { describe, expect, it } from 'vitest'
import {
  materializeTaskFromProjectItem,
  reconcileProjectItemWithTask,
  resolveProjectOptionForStatus,
  resolveStatusFromProjectOption,
} from '../src/core/projection.ts'
import {
  isGitHubTaskMetadata,
  normalizeGitHubMetadata,
  resolveProjectConfig,
  type GitHubProjectDetailPayload,
  type GitHubProjectItemPayload,
} from '../src/core/types.ts'
import { GitHubApiClient, GitHubApiError } from '../src/host/client.ts'
import { FakeGitHubBackend } from './support/fake-github.ts'

describe('Project v2 metadata & projection', () => {
  const projectMeta: Pick<GitHubProjectDetailPayload, 'id' | 'number' | 'title' | 'ownerType' | 'owner' | 'statusFieldId'> = {
    id: 'PVT_kwDO1',
    number: 7,
    title: 'Roadmap',
    ownerType: 'organization',
    owner: 'deepseek-ai',
    statusFieldId: 'PVTSSF_1',
  }

  it('operator validates and normalizes DraftIssue metadata while keeping strict rules for standard issues', () => {
    // Given a DraftIssue metadata object and an invalid standard issue with issueNumber 0
    const draftMeta = {
      provider: 'github',
      owner: 'deepseek-ai',
      repository: '',
      issueNumber: 0,
      issueUrl: 'https://github.com/orgs/deepseek-ai/projects/7',
      remoteLabels: [],
      project: {
        projectId: 'PVT_kwDO1',
        projectNumber: 7,
        ownerType: 'organization',
        owner: 'deepseek-ai',
        itemId: 'PVTI_draft_1',
        isDraft: true,
        draftIssueId: 'DI_1',
      },
      unknownField: 'dropped',
    }
    const invalidIssue = {
      provider: 'github',
      owner: 'deepseek-ai',
      repository: '',
      issueNumber: 0,
      issueUrl: 'https://github.com/deepseek-ai/dsh/issues/1',
      remoteLabels: [],
    }

    // When validating and normalizing both payloads
    const normalizedDraft = normalizeGitHubMetadata(draftMeta)
    const validInvalidIssue = isGitHubTaskMetadata(invalidIssue)

    // Then DraftIssue metadata is accepted and preserved while non-draft with empty repo is rejected
    expect(isGitHubTaskMetadata(draftMeta)).toBe(true)
    expect(normalizedDraft?.project?.isDraft).toBe(true)
    expect(normalizedDraft?.project?.draftIssueId).toBe('DI_1')
    expect((normalizedDraft as unknown as Record<string, unknown>).unknownField).toBeUndefined()
    expect(validInvalidIssue).toBe(false)
  })

  it('operator maps Project v2 Status options case-insensitively to and from TaskStatus', () => {
    // Given a resolved project config with default statusMap and remote options
    const config = resolveProjectConfig({ ownerType: 'organization', owner: 'deepseek-ai', projectNumber: 7 })
    const options = [
      { id: 'opt_1', name: 'Backlog' },
      { id: 'opt_2', name: 'Todo' },
      { id: 'opt_3', name: 'In Progress' },
      { id: 'opt_4', name: 'Done' },
      { id: 'opt_5', name: 'Blocked' },
    ]

    // When resolving statuses in both directions
    const fromInProgress = resolveStatusFromProjectOption(' in progress ', config.statusMap)
    const fromUnknown = resolveStatusFromProjectOption('Triage', config.statusMap)
    const optionForRunning = resolveProjectOptionForStatus('running', options, config.statusMap)

    // Then both directions match case-insensitively and unknown falls back to todo
    expect(fromInProgress).toBe('running')
    expect(fromUnknown).toBe('todo')
    expect(optionForRunning).toEqual({ id: 'opt_3', name: 'In Progress' })
  })

  it('operator materializes and reconciles both Issue and DraftIssue project items while preserving edited prompts', () => {
    // Given a resolved project config, an Issue item, and a DraftIssue item
    const config = resolveProjectConfig({ ownerType: 'organization', owner: 'deepseek-ai', projectNumber: 7 })
    const issueItem: GitHubProjectItemPayload = {
      itemId: 'PVTI_1',
      statusOptionId: 'opt_3',
      statusName: 'In Progress',
      contentType: 'Issue',
      isDraft: false,
      issueNumber: 42,
      issueNodeId: 'I_42',
      owner: 'deepseek-ai',
      repository: 'dsh',
      title: 'Implement project sync',
      body: 'Add GraphQL support',
      state: 'open',
      url: 'https://github.com/deepseek-ai/dsh/issues/42',
      labels: ['enhancement'],
    }
    const draftItem: GitHubProjectItemPayload = {
      itemId: 'PVTI_2',
      statusOptionId: 'opt_1',
      statusName: 'Backlog',
      contentType: 'DraftIssue',
      isDraft: true,
      draftIssueId: 'DI_2',
      title: 'Draft spike',
      body: 'Investigate caching',
      url: 'https://github.com/orgs/deepseek-ai/projects/7',
    }

    // When materializing both items and reconciling after a local prompt edit on the draft
    const issueTask = materializeTaskFromProjectItem(issueItem, projectMeta, 'task-issue', 1_000, config)
    const draftTask = materializeTaskFromProjectItem(draftItem, projectMeta, 'task-draft', 1_000, config)
    const editedDraft = { ...draftTask, prompt: 'Custom operator prompt' }
    const reconciledDraft = reconcileProjectItemWithTask(
      editedDraft,
      { ...draftItem, title: 'Draft spike v2' },
      projectMeta,
      2_000,
      config,
    )

    // Then Issue and DraftIssue materialize properly and the edited prompt is preserved
    expect(issueTask.status).toBe('running')
    expect(issueTask.integrations?.github).toMatchObject({
      owner: 'deepseek-ai',
      repository: 'dsh',
      issueNumber: 42,
      project: { itemId: 'PVTI_1', statusName: 'In Progress' },
    })
    expect(draftTask.status).toBe('backlog')
    expect(draftTask.integrations?.github).toMatchObject({
      owner: 'deepseek-ai',
      repository: '',
      issueNumber: 0,
      project: { itemId: 'PVTI_2', isDraft: true, draftIssueId: 'DI_2' },
    })
    expect(reconciledDraft.title).toBe('Draft spike v2')
    expect(reconciledDraft.prompt).toBe('Custom operator prompt')
    expect((reconciledDraft.integrations?.github as { promptHash?: string } | undefined)?.promptHash).toBeUndefined()
  })
})

describe('GitHubApiClient GraphQL & discovery', () => {
  it('operator reads x-oauth-scopes, lists orgs/repos/projects, paginates project items, and mutates items', async () => {
    // Given a FakeGitHubBackend with 120 project items (spanning 2 GraphQL pages)
    const backend = new FakeGitHubBackend()
    backend.login = 'octocat'
    backend.scopes = ['repo', 'read:org', 'project']
    backend.orgs = [{ login: 'deepseek-ai' }]
    backend.repositories = [
      { owner: 'deepseek-ai', name: 'dsh', fullName: 'deepseek-ai/dsh', private: true, defaultBranch: 'main' },
    ]
    const items: GitHubProjectItemPayload[] = Array.from({ length: 120 }, (_, i) => ({
      itemId: `PVTI_${String(i + 1)}`,
      statusOptionId: 'opt_todo',
      statusName: 'Todo',
      contentType: 'DraftIssue',
      isDraft: true,
      draftIssueId: `DI_${String(i + 1)}`,
      title: `Item ${String(i + 1)}`,
      url: 'https://github.com/orgs/deepseek-ai/projects/7',
    }))
    backend.projects = [{
      id: 'PVT_1',
      number: 7,
      title: 'Roadmap',
      url: 'https://github.com/orgs/deepseek-ai/projects/7',
      ownerType: 'organization',
      owner: 'deepseek-ai',
      statusFieldId: 'PVTSSF_1',
      statusOptions: [
        { id: 'opt_todo', name: 'Todo' },
        { id: 'opt_done', name: 'Done' },
      ],
      items,
    }]
    const client = new GitHubApiClient({ token: 'ghp_test', fetch: backend.fetch })

    // When calling user+scopes, REST discovery, GraphQL project pagination, and mutations
    const user = await client.getAuthenticatedUserWithScopes()
    const orgs = await client.listOrganizations()
    const orgRepos = await client.listOrgRepositories('deepseek-ai')
    const orgProjects = await client.listOrgProjects('deepseek-ai')
    const detail = await client.getProjectV2('organization', 'deepseek-ai', 7)
    const createdIssue = await client.createIssue('deepseek-ai', 'dsh', { title: 'New bug', labels: ['dsh'] })
    const addedItemId = await client.addProjectV2ItemById('PVT_1', createdIssue.node_id!)
    const addedDraft = await client.addProjectV2DraftIssue('PVT_1', { title: 'New draft', body: 'Details' })
    await client.updateProjectV2ItemStatus('PVT_1', addedDraft.itemId, 'PVTSSF_1', 'opt_done')

    // Then all discovery, pagination (120 items), and mutations succeed
    expect(user).toEqual({ login: 'octocat', scopes: ['repo', 'read:org', 'project'] })
    expect(orgs).toEqual([{ login: 'deepseek-ai' }])
    expect(orgRepos[0]?.fullName).toBe('deepseek-ai/dsh')
    expect(orgProjects[0]?.title).toBe('Roadmap')
    expect(detail.items).toHaveLength(120)
    expect(detail.statusFieldId).toBe('PVTSSF_1')
    expect(createdIssue.number).toBe(1)
    expect(addedItemId).toContain('PVTI_')
    expect(backend.statusUpdates).toEqual([
      { projectId: 'PVT_1', itemId: addedDraft.itemId, fieldId: 'PVTSSF_1', optionId: 'opt_done' },
    ])
  })

  it('operator maps GraphQL INSUFFICIENT_SCOPES to 403 and NOT_FOUND to 404 GitHubApiError', async () => {
    // Given a FakeGitHubBackend configured to return INSUFFICIENT_SCOPES then NOT_FOUND
    const backend = new FakeGitHubBackend()
    const client = new GitHubApiClient({ token: 'ghp_test', fetch: backend.fetch })

    // When GraphQL returns INSUFFICIENT_SCOPES
    backend.graphqlError = { type: 'INSUFFICIENT_SCOPES', message: 'missing project scope' }
    await expect(client.listUserProjects()).rejects.toMatchObject({ status: 403 })

    // When GraphQL returns NOT_FOUND
    backend.graphqlError = { type: 'NOT_FOUND', message: 'Could not resolve to a ProjectV2' }
    await expect(client.listUserProjects()).rejects.toBeInstanceOf(GitHubApiError)
    await expect(client.listUserProjects()).rejects.toMatchObject({ status: 404 })
  })
})
