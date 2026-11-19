/**
 * Model-visible tools the GitHub extension contributes to the task board.
 *
 * This file lives with the provider: the board's own agent-tools module never
 * learns GitHub vocabulary. The tools register through the extension
 * capability face, so they follow the same board-enabled x extension-enabled
 * gate as every other provider surface.
 *
 * @module dsh-task-board-github/host/tools
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  addProject,
  addRepository,
  parseProjectInput,
  parseRepositoryInput,
  removeProject,
  removeRepository,
  updateProject,
  updateRepository,
  type GitHubCreateBackendMode,
  type ProjectOptions,
  type RepositoryOptions,
} from '../core/setup.ts'
import { readTaskGitHubMetadata, type GitHubProjectStatusMap, type GitHubTaskMetadata } from '../core/types.ts'
import type { TaskRecord, TaskStatus } from '../core/task-record.ts'
import type { GitHubSyncService } from './service.ts'
import { GitHubSetupError, type GitHubSetup } from './setup.ts'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

function json(value: unknown): Json {
  return value as Json
}

function refused(code: string, message: string): Json {
  return json({ ok: false, code, message })
}

/**
 * Project the remote issue half of one card's metadata.
 *
 * The optional members are added by conditional spread rather than assigned as
 * an undefined value. A tool result has to be lossless JSON: the host runtime
 * snapshots a successful value before the model sees it and rejects any member
 * whose value is undefined, while JSON.stringify merely drops such a member
 * silently. Returning the whole metadata object instead would sidestep that
 * check but hand a list call fields it never promised.
 * @param gh - the repaired metadata of a linked card.
 * @returns the remote issue members this projection carries.
 */
function githubIssueSummary(gh: GitHubTaskMetadata): Record<string, unknown> {
  return {
    owner: gh.owner,
    repository: gh.repository,
    issueNumber: gh.issueNumber,
    issueUrl: gh.issueUrl,
    remoteLabels: [...gh.remoteLabels],
    ...(gh.remoteTitle === undefined ? {} : { remoteTitle: gh.remoteTitle }),
    ...(gh.remoteState === undefined ? {} : { remoteState: gh.remoteState }),
    ...(gh.lastSyncedAt === undefined ? {} : { lastSyncedAt: gh.lastSyncedAt }),
    ...(gh.lastSyncError === undefined ? {} : { lastSyncError: gh.lastSyncError }),
    ...(gh.deactivated === undefined ? {} : { deactivated: gh.deactivated }),
    ...(gh.pullRequest === undefined ? {} : { pullRequest: gh.pullRequest }),
    ...(gh.project === undefined ? {} : { project: gh.project }),
  }
}

function githubTaskSummary(task: TaskRecord): Record<string, unknown> {
  const gh = readTaskGitHubMetadata(task)
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    archived: task.archivedAt !== undefined,
    ...(gh === undefined ? {} : { github: githubIssueSummary(gh) }),
  }
}

/** Every GitHub tool, bound to the running sync service. */
export function buildGitHubTools(service: GitHubSyncService, setup?: GitHubSetup): ToolDefinition[] {
  return [
    buildListTool(service),
    buildGetTool(service),
    buildRefreshTool(service),
    buildCreatePrTool(service),
    buildLinkPrTool(service),
    buildCommentTool(service),
    buildCloseIssueTool(service),
    ...(setup === undefined ? [] : [buildCreateTaskTool(service, setup)]),
  ]
}

/**
 * The configuration tools: what lets a model set this extension up end to end
 * — credential, repositories and a live connection test — without a user
 * editing a profile patch by hand.
 *
 * They render the same setup surface the settings card and the host routes
 * use, so a model and a person writing the same configuration produce the same
 * stored value. The token is written once and never read back: no tool result
 * and no summary carries its value, only whether one is configured, where it
 * came from and whether it is writable.
 * @param setup - the shared setup surface; absent registers no setup tool.
 * @returns the setup tools, or none.
 */
export function buildSetupTools(setup: GitHubSetup | undefined): ToolDefinition[] {
  if (setup === undefined) return []
  return [buildSetupTool(setup), buildRepositoriesTool(setup), buildProjectsTool(setup)]
}

function buildSetupTool(setup: GitHubSetup): ToolDefinition {
  return defineTool({
    name: 'task_board_github_setup',
    description: 'Configure the task board GitHub Issues & Projects integration: read the setup status, store or clear the GitHub token, import local auth from dsh-connectors or gh CLI, discover account organizations, and run a live connection test against GitHub. The token is stored host-side in the harness credential store and is never returned by any tool. Because a token passed as an argument becomes part of this conversation, prefer asking the user to paste it in the extension settings card when they can reach it.',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'set-token', 'clear-token', 'test', 'import-local-auth', 'discover'], description: 'status reads the current configuration; set-token stores the token; clear-token removes it; test calls GitHub; import-local-auth imports a local credential from dsh-connectors or gh CLI; discover tests the credential and lists accessible organizations and configured targets.' },
      token: { type: 'string', description: 'GitHub token to store; required by set-token. It becomes part of this conversation.' },
      owner: { type: 'string', description: 'Repository owner to test only that repository.' },
      repository: { type: 'string', description: 'Repository name to test only that repository.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      try {
        switch (args.action) {
          case 'status':
            return json({ ok: true, status: await setup.status() })
          case 'set-token': {
            if (typeof args.token !== 'string' || args.token.trim() === '') {
              return refused('token-required', 'set-token needs the token to store')
            }
            return json({ ok: true, status: await setup.setCredential(args.token) })
          }
          case 'clear-token':
            return json({ ok: true, status: await setup.clearCredential() })
          case 'test': {
            const target = typeof args.owner === 'string' && typeof args.repository === 'string'
              ? { owner: args.owner, repository: args.repository }
              : {}
            return json({ ok: true, report: await setup.test(target) })
          }
          case 'import-local-auth':
            return json(await setup.importLocalAuth())
          case 'discover': {
            const report = await setup.test({})
            const organizations = await setup.discoverOrgs()
            return json({
              ok: true,
              account: report.login ?? null,
              scopes: report.scopes ?? [],
              organizations,
              configuredProjects: setup.listProjects(),
              configuredRepositories: setup.listRepositories(),
            })
          }
          default:
            return refused('unknown-action', 'action must be status, set-token, clear-token, test, import-local-auth or discover')
        }
      } catch (error) {
        return refused(error instanceof GitHubSetupError ? error.code : 'setup-failed', describeSetupError(error))
      }
    },
  })
}

function buildRepositoriesTool(setup: GitHubSetup): ToolDefinition {
  return defineTool({
    name: 'task_board_github_repositories',
    description: 'Read and edit the repositories the GitHub Issues integration synchronizes with the task board. An issue is included when it carries the inclusion label or is assigned to the configured assignee. A repository is written to the plugin configuration as soon as the call returns, so no restart is needed.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'add', 'remove', 'update'], description: 'list reads the configured repositories; add, remove and update rewrite the list.' },
      repository: { type: 'string', description: 'Repository to act on: owner/repo, a GitHub URL, or an SSH remote. Required by add, remove and update.' },
      inclusionLabel: { type: 'string', description: 'Issue label that opts an issue into the board (default dsh).' },
      assignee: { type: 'string', description: 'Login whose assigned issues are included too; use @me for the account the host is authenticated as, or an empty string to turn the channel off. Trivial filters such as "assigned to me" belong here.' },
      includeUnassigned: { type: 'boolean', description: 'Whether issues assigned to nobody are included too; set it on repositories whose issues are never assigned. It never pulls in issues assigned to other people.' },
      baseBranch: { type: 'string', description: 'Base branch pull requests target (default main).' },
      prCreationEnabled: { type: 'boolean', description: 'Whether the extension may open pull requests for completed cards.' },
      pollingIntervalMs: { type: 'number', description: 'Background polling interval in milliseconds (default 300000; 0 disables polling).' },
      analysisModel: { type: 'string', description: 'Qualified provider/model the AI issue analysis uses for this repository\'s cards; an empty string falls back to the card\'s pinned model, then the host default.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const current = setup.listRepositories()
      if (args.action === 'list') return json({ ok: true, repositories: current })
      const input = typeof args.repository === 'string' ? args.repository : ''
      const options: RepositoryOptions = {}
      if (typeof args.inclusionLabel === 'string' && args.inclusionLabel.trim() !== '') options.inclusionLabel = args.inclusionLabel.trim()
      // An explicit empty string is meaningful here: it turns the assignee
      // channel off without dropping the repository.
      if (typeof args.assignee === 'string') options.assignee = args.assignee.trim()
      if (typeof args.includeUnassigned === 'boolean') options.includeUnassigned = args.includeUnassigned
      if (typeof args.baseBranch === 'string' && args.baseBranch.trim() !== '') options.baseBranch = args.baseBranch.trim()
      if (typeof args.prCreationEnabled === 'boolean') options.prCreationEnabled = args.prCreationEnabled
      if (typeof args.pollingIntervalMs === 'number' && Number.isFinite(args.pollingIntervalMs) && args.pollingIntervalMs >= 0) {
        options.pollingIntervalMs = Math.floor(args.pollingIntervalMs)
      }
      if (typeof args.analysisModel === 'string') options.analysisModel = args.analysisModel.trim()
      // The same pure edits the settings card runs, so a model and a person
      // adding "deepseek-ai/dsh" produce one stored value.
      const edit = args.action === 'add'
        ? addRepository(current, input, options)
        : args.action === 'remove'
          ? removeRepository(current, input)
          : args.action === 'update'
            ? updateRepository(current, input, options)
            : undefined
      if (edit === undefined) return refused('unknown-action', 'action must be list, add, remove or update')
      if (!edit.ok) return refused(edit.code, edit.message)
      try {
        const repositories = await setup.writeRepositories(edit.repositories)
        return json({ ok: true, repositories })
      } catch (error) {
        return refused(error instanceof GitHubSetupError ? error.code : 'write-failed', describeSetupError(error))
      }
    },
  })
}

/** Phrase one setup failure for a model reading a tool result. */
function describeSetupError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildProjectsTool(setup: GitHubSetup): ToolDefinition {
  return defineTool({
    name: 'task_board_github_projects',
    description: 'Read, discover, and edit GitHub Projects v2 synchronized with the task board. Projects sync Issues and DraftIssues into board cards and write column changes back to the Project Status field.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'add', 'remove', 'update', 'discover'], description: 'list reads configured projects; discover queries GitHub for accessible Projects v2; add, remove and update edit the configured list.' },
      project: { type: 'string', description: 'Project v2 reference: GitHub Project URL, org/<owner>/projects/<n>, user/<owner>/projects/<n>, <owner>/projects/<n>, or <owner>#<n>. Required by add, remove and update.' },
      ownerType: { type: 'string', enum: ['organization', 'user'], description: 'Owner kind for discover (organization or user).' },
      owner: { type: 'string', description: 'Organization or user login for discover.' },
      title: { type: 'string', description: 'Optional display title for the project.' },
      includeDrafts: { type: 'boolean', description: 'Whether DraftIssue items in the project are materialized as board cards (default: true).' },
      pollingIntervalMs: { type: 'number', description: 'Background polling interval in milliseconds (default 300000; 0 disables polling).' },
      analysisModel: { type: 'string', description: 'Qualified provider/model for AI issue analysis on items from this project.' },
      statusMap: {
        type: 'object',
        description: 'Optional mapping from board columns (backlog, todo, running, done, failed) to Project Status option names.',
        additionalProperties: false,
        properties: {
          backlog: { type: 'string' },
          todo: { type: 'string' },
          running: { type: 'string' },
          done: { type: 'string' },
          failed: { type: 'string' },
        },
      },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const current = setup.listProjects()
      if (args.action === 'list') return json({ ok: true, projects: current })
      if (args.action === 'discover') {
        try {
          const ownerType = args.ownerType === 'user' || args.ownerType === 'organization' ? args.ownerType : undefined
          const owner = typeof args.owner === 'string' && args.owner.trim() !== '' ? args.owner.trim() : undefined
          const projects = await setup.discoverProjects({
            ...(ownerType !== undefined ? { ownerType } : {}),
            ...(owner !== undefined ? { owner } : {}),
          })
          return json({ ok: true, projects })
        } catch (error) {
          return refused(error instanceof GitHubSetupError ? error.code : 'discover-failed', describeSetupError(error))
        }
      }

      const input = typeof args.project === 'string' ? args.project : ''
      const options: ProjectOptions = {}
      if (typeof args.title === 'string') options.title = args.title.trim()
      if (typeof args.includeDrafts === 'boolean') options.includeDrafts = args.includeDrafts
      if (typeof args.pollingIntervalMs === 'number' && Number.isFinite(args.pollingIntervalMs) && args.pollingIntervalMs >= 0) {
        options.pollingIntervalMs = Math.floor(args.pollingIntervalMs)
      }
      if (typeof args.analysisModel === 'string') options.analysisModel = args.analysisModel.trim()
      if (typeof args.statusMap === 'object' && args.statusMap !== null && !Array.isArray(args.statusMap)) {
        const raw = args.statusMap as Record<string, unknown>
        const statusMap: GitHubProjectStatusMap = {}
        for (const key of ['backlog', 'todo', 'running', 'done', 'failed'] as const) {
          if (typeof raw[key] === 'string' && raw[key].trim() !== '') {
            statusMap[key] = raw[key].trim()
          }
        }
        if (Object.keys(statusMap).length > 0) options.statusMap = statusMap
      }

      const edit = args.action === 'add'
        ? addProject(current, input, options)
        : args.action === 'remove'
          ? removeProject(current, input)
          : args.action === 'update'
            ? updateProject(current, input, options)
            : undefined
      if (edit === undefined) return refused('unknown-action', 'action must be list, add, remove, update or discover')
      if (!edit.ok) return refused(edit.code, edit.message)
      try {
        const projects = await setup.writeProjects(edit.projects)
        return json({ ok: true, projects })
      } catch (error) {
        return refused(error instanceof GitHubSetupError ? error.code : 'write-failed', describeSetupError(error))
      }
    },
  })
}


function buildListTool(service: GitHubSyncService): ToolDefinition {
  return defineTool({
    name: 'task_board_github_list',
    description: 'List task board cards associated with GitHub issues, with their remote issue state, remote labels, and pull request metadata.',
    parameters: {
      owner: { type: 'string', description: 'Filter by repository owner.' },
      repository: { type: 'string', description: 'Filter by repository name.' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by remote issue state (open, closed, or all; default: all).' },
      hasPr: { type: 'boolean', description: 'Filter by whether a pull request is linked.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const filtered = service.listTasks({
        ...(typeof args.owner === 'string' ? { owner: args.owner } : {}),
        ...(typeof args.repository === 'string' ? { repository: args.repository } : {}),
        ...(args.state === 'open' || args.state === 'closed' || args.state === 'all' ? { state: args.state } : {}),
        ...(typeof args.hasPr === 'boolean' ? { hasPr: args.hasPr } : {}),
      })
      return json({ tasks: filtered.map(task => githubTaskSummary(task)) })
    },
    // Pure projection of the in-memory index: safe to overlap with sibling calls.
    isConcurrencySafe: () => true,
  })
}

function buildGetTool(service: GitHubSyncService): ToolDefinition {
  return defineTool({
    name: 'task_board_github_get',
    description: 'Get full GitHub integration details for a task board card, including remote issue title, body, labels, pull request details, and synchronization state.',
    parameters: {
      taskId: { type: 'string', description: 'Task ID on the board.' },
      owner: { type: 'string', description: 'Repository owner (used with repository and issueNumber).' },
      repository: { type: 'string', description: 'Repository name (used with owner and issueNumber).' },
      issueNumber: { type: 'number', description: 'GitHub issue number.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      let task: TaskRecord | undefined
      if (typeof args.taskId === 'string' && args.taskId.trim() !== '') {
        task = service.host.tasks.get(args.taskId.trim())
      } else if (
        typeof args.owner === 'string'
        && typeof args.repository === 'string'
        && typeof args.issueNumber === 'number'
      ) {
        const o = args.owner.toLowerCase()
        const r = args.repository.toLowerCase()
        task = service.host.tasks.list().find(candidate => {
          const gh = readTaskGitHubMetadata(candidate)
          return gh !== undefined
            && gh.owner.toLowerCase() === o
            && gh.repository.toLowerCase() === r
            && gh.issueNumber === args.issueNumber
        })
      }
      const metadata = readTaskGitHubMetadata(task)
      if (task === undefined || metadata === undefined) {
        return refused('not-found', 'task with GitHub integration not found')
      }
      return json({
        ok: true,
        task: {
          taskId: task.id,
          title: task.title,
          description: task.description,
          prompt: task.prompt,
          status: task.status,
          archived: task.archivedAt !== undefined,
          github: metadata,
        },
      })
    },
    // Reads the in-memory index and fixture metadata only.
    isConcurrencySafe: () => true,
  })
}

function buildRefreshTool(service: GitHubSyncService): ToolDefinition {
  return defineTool({
    name: 'task_board_github_refresh',
    description: 'Trigger synchronization between GitHub issues/projects/pull requests and the task board for a task, a repository, a Project v2, or all configured targets.',
    parameters: {
      taskId: { type: 'string', description: 'Specific task ID to refresh.' },
      owner: { type: 'string', description: 'Repository or Project owner to refresh.' },
      repository: { type: 'string', description: 'Repository name to refresh.' },
      projectNumber: { type: 'number', description: 'Project v2 number to refresh (used with owner and optional ownerType).' },
      ownerType: { type: 'string', enum: ['organization', 'user'], description: 'Project owner kind (default: organization).' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      if (service.repositories.length === 0 && service.projects.length === 0) {
        return refused('not-configured', 'GitHub integration is not configured')
      }
      try {
        if (typeof args.taskId === 'string' && args.taskId.trim() !== '') {
          const result = await service.syncTask(args.taskId.trim())
          if (!result.ok) return refused('sync-failed', result.error ?? 'sync failed')
          const updated = service.host.tasks.get(args.taskId.trim())
          return json({ ok: true, synced: 1, ...(updated === undefined ? {} : { task: githubTaskSummary(updated) }) })
        } else if (typeof args.owner === 'string' && typeof args.projectNumber === 'number' && Number.isInteger(args.projectNumber) && args.projectNumber > 0) {
          const ownerType = args.ownerType === 'user' ? 'user' : 'organization'
          const result = await service.syncProject(ownerType, args.owner.trim(), args.projectNumber)
          return json({ ok: true, synced: result.synced, ...(result.errors.length > 0 ? { errors: result.errors } : {}) })
        } else if (typeof args.owner === 'string' && typeof args.repository === 'string') {
          const result = await service.syncRepository(args.owner.trim(), args.repository.trim())
          return json({ ok: true, synced: result.synced, ...(result.errors.length > 0 ? { errors: result.errors } : {}) })
        } else {
          const result = await service.syncAll()
          return json({ ok: true, synced: result.synced, ...(result.errors.length > 0 ? { errors: result.errors } : {}) })
        }
      } catch (error) {
        return refused('sync-error', error instanceof Error ? error.message : String(error))
      }
    },
  })
}

function buildCreatePrTool(service: GitHubSyncService): ToolDefinition {
  return defineTool({
    name: 'task_board_github_create_pr',
    description: 'Create a GitHub Pull Request for a task board card linked to a GitHub issue. Verifies that the head branch exists on remote, creates the PR, records PR metadata, and adds the PR phase label to the issue. Does not run shell commands.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task ID linked to a GitHub issue.' },
      headBranch: { type: 'string', required: true, description: 'Remote head branch containing the changes (must already exist on remote).' },
      baseBranch: { type: 'string', description: 'Target base branch (default: repository default, e.g. main).' },
      title: { type: 'string', description: 'PR title (default: task title).' },
      body: { type: 'string', description: 'PR body text (default includes "Fixes #<issue>" and task description).' },
      draft: { type: 'boolean', description: 'Whether to create the PR as draft.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const task = service.host.tasks.get(args.taskId)
      if (readTaskGitHubMetadata(task) === undefined) {
        return refused('not-github-task', 'task is not linked to a GitHub issue')
      }
      try {
        const pr = await service.createPullRequest(args.taskId, {
          headBranch: args.headBranch,
          ...(args.baseBranch === undefined ? {} : { baseBranch: args.baseBranch }),
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.body === undefined ? {} : { body: args.body }),
          ...(args.draft === undefined ? {} : { draft: args.draft }),
        })
        return json({ ok: true, pullRequest: pr })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('does not exist on remote')) {
          return refused('branch-not-found', message)
        }
        return refused('create-pr-failed', message)
      }
    },
  })
}


function buildCommentTool(service: GitHubSyncService): ToolDefinition {
  return defineTool({
    name: 'task_board_github_comment',
    description: 'Post one comment on the GitHub issue behind a task board card. Use it to report what was done, link the pull request, or state why the task was closed without a fix. The body is Markdown and must stay under the length limit. Does not run shell commands.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task ID linked to a GitHub issue.' },
      body: { type: 'string', required: true, description: 'Markdown comment body to post. Must be non-empty and under the length limit; a transcript belongs in the card, not in a comment.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      try {
        const comment = await service.postComment(args.taskId, args.body)
        return json({ ok: true, comment })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return refused(message.includes('not linked') ? 'not-github-task' : 'comment-failed', message)
      }
    },
  })
}

function buildCloseIssueTool(service: GitHubSyncService): ToolDefinition {
  return defineTool({
    name: 'task_board_github_close_issue',
    description: 'Close the GitHub issue behind a task board card, once the work has actually landed. Refused unless the card has a linked pull request that is MERGED: a passing local run is not a reviewed change. Does not run shell commands.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task ID linked to a GitHub issue.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      try {
        const closed = await service.closeIssue(args.taskId)
        return json({ ok: true, ...closed })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = message.includes('not linked')
          ? 'not-github-task'
          : message.includes('not merged')
            ? 'pr-not-merged'
            : message.includes('no linked pull request')
              ? 'no-linked-pr'
              : 'close-issue-failed'
        return refused(code, message)
      }
    },
  })
}

function buildLinkPrTool(service: GitHubSyncService): ToolDefinition {
  return defineTool({
    name: 'task_board_github_link_pr',
    description: 'Link an existing GitHub Pull Request to a task board card linked to a GitHub issue, updating PR metadata and managed phase labels.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task ID linked to a GitHub issue.' },
      pullRequestNumber: { type: 'number', required: true, description: 'Pull request number on GitHub.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const task = service.host.tasks.get(args.taskId)
      if (readTaskGitHubMetadata(task) === undefined) {
        return refused('not-github-task', 'task is not linked to a GitHub issue')
      }
      try {
        const pr = await service.linkPullRequest(args.taskId, args.pullRequestNumber)
        return json({ ok: true, pullRequest: pr })
      } catch (error) {
        return refused('link-pr-failed', error instanceof Error ? error.message : String(error))
      }
    },
  })
}

const VALID_TASK_STATUSES = new Set<TaskStatus>(['backlog', 'todo', 'running', 'done', 'failed'])

function buildCreateTaskTool(service: GitHubSyncService, setup: GitHubSetup): ToolDefinition {
  return defineTool({
    name: 'task_board_github_create',
    description: 'Create a remote GitHub Issue, Project v2 Issue, or Project v2 DraftIssue and materialize it as a linked card on the task board.',
    parameters: {
      mode: { type: 'string', required: true, enum: ['issue', 'project-issue', 'project-draft'], description: 'Backend target: issue (repo issue only), project-issue (repo issue added to Project v2), or project-draft (DraftIssue inside Project v2).' },
      title: { type: 'string', required: true, description: 'Task and remote item title.' },
      description: { type: 'string', description: 'Remote issue or draft body in Markdown.' },
      prompt: { type: 'string', description: 'Optional explicit execution prompt; defaults to the composed GitHub prompt.' },
      repository: { type: 'string', description: 'Target repository (owner/repo or GitHub URL). Required for issue and project-issue modes.' },
      project: { type: 'string', description: 'Target Project v2 (URL, org/<owner>/projects/<n>, user/<owner>/projects/<n>, <owner>/projects/<n>, or <owner>#<n>). Required for project-issue and project-draft modes.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Optional GitHub issue labels.' },
      assignee: { type: 'string', description: 'Optional GitHub login to assign (supports @me).' },
      status: { type: 'string', enum: ['backlog', 'todo', 'running', 'done', 'failed'], description: 'Initial board column (and Project v2 Status when matched).' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute(args) {
      const mode = args.mode as GitHubCreateBackendMode
      if (mode !== 'issue' && mode !== 'project-issue' && mode !== 'project-draft') {
        return refused('invalid-mode', 'mode must be issue, project-issue or project-draft')
      }
      if (typeof args.title !== 'string' || args.title.trim() === '') {
        return refused('title-required', 'title is required')
      }
      const parsedRepo = typeof args.repository === 'string' && args.repository.trim() !== ''
        ? parseRepositoryInput(args.repository)
        : undefined
      if ((mode === 'issue' || mode === 'project-issue') && parsedRepo === undefined) {
        return refused('invalid-repository', 'repository (owner/repo) is required for issue and project-issue modes')
      }
      const parsedProject = typeof args.project === 'string' && args.project.trim() !== ''
        ? parseProjectInput(args.project)
        : undefined
      if ((mode === 'project-issue' || mode === 'project-draft') && parsedProject === undefined) {
        return refused('invalid-project', 'project (e.g. org:owner#1 or project URL) is required for project-issue and project-draft modes')
      }

      const status = typeof args.status === 'string' && VALID_TASK_STATUSES.has(args.status as TaskStatus)
        ? (args.status as TaskStatus)
        : undefined
      const labels = Array.isArray(args.labels)
        ? args.labels.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map(entry => entry.trim())
        : undefined
      const assignees = typeof args.assignee === 'string' && args.assignee.trim() !== ''
        ? [args.assignee.trim()]
        : undefined

      try {
        const result = await setup.createRemoteTask({
          mode,
          ...(parsedRepo !== undefined ? { owner: parsedRepo.owner, repository: parsedRepo.repository } : {}),
          ...(parsedProject !== undefined
            ? {
                projectOwnerType: parsedProject.ownerType,
                projectOwner: parsedProject.owner,
                projectNumber: parsedProject.projectNumber,
              }
            : {}),
          title: args.title.trim(),
          ...(typeof args.description === 'string' ? { body: args.description } : {}),
          ...(typeof args.prompt === 'string' ? { prompt: args.prompt } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(labels !== undefined && labels.length > 0 ? { labels } : {}),
          ...(assignees !== undefined ? { assignees } : {}),
        })

        const created = service.host.tasks.create(
          {
            title: result.title,
            description: result.description,
            prompt: result.prompt,
            ...(result.status !== undefined ? { status: result.status } : {}),
            ...(result.suggestedWorkspaceId !== undefined ? { workspaceId: result.suggestedWorkspaceId } : {}),
          },
          { payload: result.payload as unknown as Record<string, unknown> },
        )
        service.reindex()
        return json({ ok: true, task: githubTaskSummary(created) })
      } catch (error) {
        return refused(error instanceof GitHubSetupError ? error.code : 'create-failed', describeSetupError(error))
      }
    },
  })
}
