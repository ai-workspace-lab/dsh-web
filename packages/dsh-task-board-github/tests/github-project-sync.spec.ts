/**
 * GitHub Projects v2 synchronization engine tests:
 * - syncing org/user project issues and DraftIssues
 * - deduplication across repo sync and project sync
 * - bidirectional Project v2 Status column write-back
 * - fallback repo actions on project-only issues and draft refusals
 */
import { describe, expect, it } from 'vitest'
import type { TaskBoardExtension, TaskBoardExtensionHost } from '../src/core/contract.ts'
import type { TaskRecord } from '../src/core/task-record.ts'
import {
  readTaskGitHubMetadata,
  type GitHubProjectDetailPayload,
  type GitHubProjectItemPayload,
  type GitHubRepoConfig,
} from '../src/core/types.ts'
import { GitHubApiClient } from '../src/host/client.ts'
import { GitHubSyncService } from '../src/host/service.ts'
import { FakeBoard, recordingTimers } from './support/fake-board.ts'
import { FakeGitHubBackend, issueFixture } from './support/fake-github.ts'

function faceOf(board: FakeBoard): TaskBoardExtensionHost {
  let face: TaskBoardExtensionHost | undefined
  const stub: TaskBoardExtension = { id: 'github', apiVersion: 1, start: host => { face = host } }
  board.admit(stub)
  if (face === undefined) throw new Error('the fake board did not start the provider')
  return face
}

function cards(board: FakeBoard): TaskRecord[] {
  return [...board.records.values()]
}

function makeProjectDetail(items: GitHubProjectItemPayload[]): GitHubProjectDetailPayload {
  return {
    id: 'PVT_org_1',
    number: 7,
    title: 'Engineering Roadmap',
    url: 'https://github.com/orgs/deepseek-ai/projects/7',
    ownerType: 'organization',
    owner: 'deepseek-ai',
    statusFieldId: 'PVTSSF_status',
    statusOptions: [
      { id: 'opt-backlog', name: 'Backlog' },
      { id: 'opt-todo', name: 'Todo' },
      { id: 'opt-running', name: 'In Progress' },
      { id: 'opt-done', name: 'Done' },
      { id: 'opt-failed', name: 'Blocked' },
    ],
    items,
  }
}

class StubProjectClient extends GitHubApiClient {
  readonly statusUpdates: Array<{ projectId: string; itemId: string; fieldId: string; optionId: string }> = []
  readonly commentsCreated: Array<{ owner: string; repo: string; issueNumber: number; body: string }> = []

  constructor(private readonly detail: GitHubProjectDetailPayload, backend: FakeGitHubBackend) {
    super({ token: 'test-token', fetch: backend.fetch })
  }

  override async getProjectV2(): Promise<GitHubProjectDetailPayload> {
    return this.detail
  }

  override async updateProjectV2ItemStatus(
    projectId: string,
    itemId: string,
    fieldId: string,
    optionId: string,
  ): Promise<void> {
    this.statusUpdates.push({ projectId, itemId, fieldId, optionId })
  }

  override async createComment(owner: string, repo: string, issueNumber: number, body: string) {
    this.commentsCreated.push({ owner, repo, issueNumber, body })
    return {
      id: 777,
      html_url: `https://github.com/${owner}/${repo}/issues/${issueNumber}#issuecomment-777`,
      body,
    }
  }
}

describe('GitHub Project v2 sync engine', () => {
  it('operator syncs project issues and draft issues without any configured repository and deduplicates drafts', async () => {
    // Given a Project v2 with one repository Issue and one DraftIssue, and no configured repositories
    const board = new FakeBoard()
    const backend = new FakeGitHubBackend()
    const detail = makeProjectDetail([
      {
        itemId: 'PVTI_issue_1',
        statusOptionId: 'opt-todo',
        statusName: 'Todo',
        contentType: 'Issue',
        isDraft: false,
        issueNumber: 42,
        issueNodeId: 'I_42',
        owner: 'deepseek-ai',
        repository: 'dsh-web',
        title: 'Project issue 42',
        body: 'Issue body',
        state: 'open',
        url: 'https://github.com/deepseek-ai/dsh-web/issues/42',
        labels: ['enhancement'],
      },
      {
        itemId: 'PVTI_draft_1',
        statusOptionId: 'opt-running',
        statusName: 'In Progress',
        contentType: 'DraftIssue',
        isDraft: true,
        draftIssueId: 'DI_1',
        title: 'Draft roadmap item',
        body: 'Draft details',
        url: 'https://github.com/orgs/deepseek-ai/projects/7',
      },
    ])
    const client = new StubProjectClient(detail, backend)

    const { timers, armed } = recordingTimers()
    const service = new GitHubSyncService({
      host: faceOf(board),
      client,
      projects: [{ ownerType: 'organization', owner: 'deepseek-ai', projectNumber: 7, title: 'Engineering Roadmap', pollingIntervalMs: 120_000 }],
      now: () => 5_000,
      timers,
    })

    // When background polling starts and syncAll runs twice
    service.start()
    expect(armed).toEqual([{ kind: 'interval', delay: 120_000 }])
    expect(service.syncHealth().running).toBe(true)
    expect(service.snapshotSummary()).toMatchObject({
      enabled: true,
      projects: [{ ownerType: 'organization', owner: 'deepseek-ai', projectNumber: 7, title: 'Engineering Roadmap', hasCredential: true }],
    })

    await service.syncAll()
    await service.syncAll()

    // Then both the Issue and the DraftIssue are materialized once without duplication
    const all = cards(board)
    expect(all).toHaveLength(2)

    const issueCard = all.find(c => readTaskGitHubMetadata(c)?.issueNumber === 42)
    expect(issueCard?.title).toBe('Project issue 42')
    expect(issueCard?.status).toBe('todo')
    expect(readTaskGitHubMetadata(issueCard)?.project).toMatchObject({
      projectId: 'PVT_org_1',
      itemId: 'PVTI_issue_1',
      statusName: 'Todo',
    })

    const draftCard = all.find(c => readTaskGitHubMetadata(c)?.project?.isDraft === true)
    expect(draftCard?.title).toBe('Draft roadmap item')
    expect(draftCard?.status).toBe('running')
    expect(readTaskGitHubMetadata(draftCard)?.project).toMatchObject({
      projectId: 'PVT_org_1',
      itemId: 'PVTI_draft_1',
      draftIssueId: 'DI_1',
      isDraft: true,
    })

    service.dispose()
  })

  it('operator deduplicates an issue synced by both a repository and a Project v2', async () => {
    // Given an issue present in both a configured repository and a configured Project v2
    const board = new FakeBoard()
    const backend = new FakeGitHubBackend()
    backend.issues = [issueFixture(10, ['dsh', 'bug'], 'Repo issue body')]
    const client = new StubProjectClient(makeProjectDetail([
      {
        itemId: 'PVTI_issue_10',
        statusOptionId: 'opt-todo',
        statusName: 'Todo',
        contentType: 'Issue',
        isDraft: false,
        issueNumber: 10,
        issueNodeId: 'I_10',
        owner: 'deepseek-ai',
        repository: 'dsh',
        title: 'Issue #10',
        body: 'Repo issue body',
        state: 'open',
        url: 'https://github.com/deepseek-ai/dsh/issues/10',
        labels: ['dsh', 'bug'],
      },
    ]), backend)

    const repo: GitHubRepoConfig = { owner: 'deepseek-ai', repository: 'dsh', inclusionLabel: 'dsh' }
    const service = new GitHubSyncService({
      host: faceOf(board),
      client,
      repositories: [repo],
      projects: [{ ownerType: 'organization', owner: 'deepseek-ai', projectNumber: 7 }],
      now: () => 2_000,
    })

    // When a full sync runs (repo + project), then a second repo-only sync runs
    const first = await service.syncAll()
    await service.syncRepository('deepseek-ai', 'dsh')

    // Then exactly one card exists on the board and retains its project provenance
    expect(first.errors).toEqual([])
    expect(cards(board)).toHaveLength(1)
    const meta = readTaskGitHubMetadata(cards(board)[0])
    expect(meta?.issueNumber).toBe(10)
    expect(meta?.project?.itemId).toBe('PVTI_issue_10')
  })

  it('operator writes local status changes back to the Project v2 Status column', async () => {
    // Given a synced Project v2 card in Todo status
    const board = new FakeBoard()
    const backend = new FakeGitHubBackend()
    const client = new StubProjectClient(makeProjectDetail([
      {
        itemId: 'PVTI_draft_2',
        statusOptionId: 'opt-todo',
        statusName: 'Todo',
        contentType: 'DraftIssue',
        isDraft: true,
        draftIssueId: 'DI_2',
        title: 'Write status back',
        body: 'Body',
        url: 'https://github.com/orgs/deepseek-ai/projects/7',
      },
    ]), backend)

    const service = new GitHubSyncService({
      host: faceOf(board),
      client,
      projects: [{ ownerType: 'organization', owner: 'deepseek-ai', projectNumber: 7 }],
      now: () => 3_000,
    })
    await service.syncProject('organization', 'deepseek-ai', 7)
    const taskId = cards(board)[0]!.id

    // When the local task moves to running
    await service.writeBackTaskStatus(taskId, 'running')

    // Then GitHub Project v2 Status is updated to the matching option and stored on the card
    expect(client.statusUpdates).toEqual([
      { projectId: 'PVT_org_1', itemId: 'PVTI_draft_2', fieldId: 'PVTSSF_status', optionId: 'opt-running' },
    ])
    const updatedMeta = readTaskGitHubMetadata(board.records.get(taskId))
    expect(updatedMeta?.project?.statusOptionId).toBe('opt-running')
    expect(updatedMeta?.project?.statusName).toBe('In Progress')
  })

  it('operator supports fallback repo actions on project-only issues and refuses repo-only actions on draft items', async () => {
    // Given a project-only Issue card and a DraftIssue card (with no configured repositories)
    const board = new FakeBoard()
    const backend = new FakeGitHubBackend()
    const client = new StubProjectClient(makeProjectDetail([
      {
        itemId: 'PVTI_issue_99',
        statusOptionId: 'opt-todo',
        statusName: 'Todo',
        contentType: 'Issue',
        isDraft: false,
        issueNumber: 99,
        issueNodeId: 'I_99',
        owner: 'deepseek-ai',
        repository: 'unconfigured-repo',
        title: 'Project-only issue',
        body: 'Details',
        state: 'open',
        url: 'https://github.com/deepseek-ai/unconfigured-repo/issues/99',
        labels: [],
      },
      {
        itemId: 'PVTI_draft_99',
        statusOptionId: 'opt-todo',
        statusName: 'Todo',
        contentType: 'DraftIssue',
        isDraft: true,
        draftIssueId: 'DI_99',
        title: 'Draft only',
        body: 'No repo yet',
        url: 'https://github.com/orgs/deepseek-ai/projects/7',
      },
    ]), backend)

    const service = new GitHubSyncService({
      host: faceOf(board),
      client,
      projects: [{ ownerType: 'organization', owner: 'deepseek-ai', projectNumber: 7 }],
      now: () => 4_000,
    })
    await service.syncProject('organization', 'deepseek-ai', 7)

    const issueCard = cards(board).find(c => readTaskGitHubMetadata(c)?.issueNumber === 99)!
    const draftCard = cards(board).find(c => readTaskGitHubMetadata(c)?.project?.isDraft === true)!

    // When posting a comment on the project-only issue and attempting repo actions on the draft
    const comment = await service.postComment(issueCard.id, 'Progress update')

    // Then the project-only issue succeeds via synthesized repo config, while draft repo actions refuse clearly
    expect(comment.id).toBe(777)
    expect(client.commentsCreated).toEqual([
      { owner: 'deepseek-ai', repo: 'unconfigured-repo', issueNumber: 99, body: 'Progress update' },
    ])

    await expect(service.postComment(draftCard.id, 'Hello')).rejects.toThrow(/Project draft item is not backed by a repository issue/)
    await expect(service.createPullRequest(draftCard.id, { headBranch: 'feat/x' })).rejects.toThrow(/Project draft item is not backed by a repository issue/)
    await expect(service.closeIssue(draftCard.id)).rejects.toThrow(/Project draft item is not backed by a repository issue/)

    // And syncTask refreshes the draft from Project v2 cleanly
    const refreshedDraft = await service.syncTask(draftCard.id)
    expect(refreshedDraft.ok).toBe(true)
  })
})
