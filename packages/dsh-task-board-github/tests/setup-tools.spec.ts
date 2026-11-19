/**
 * The configuration tools: what a model can do to set the integration up.
 *
 * Each case runs the real tool against a setup double and asserts the value the
 * user ends up with, plus the refusals a model must be able to correct from
 * (a missing token, an unknown action, a repository that is already there).
 */
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { GitHubProjectConfig, GitHubRepoConfig } from '../src/core/types.ts'
import { GitHubSetupError, type GitHubSetup } from '../src/host/setup.ts'
import { buildSetupTools } from '../src/host/tools.ts'

/** A setup surface double: an in-memory list, recording what it was asked. */
function setupDouble(initial: GitHubRepoConfig[] = [], initialProjects: GitHubProjectConfig[] = []) {
  let repositories = [...initial]
  let projects = [...initialProjects]
  const calls: string[] = []
  const summary = (configured = true) => ({
    credential: { configured, writable: true, envName: 'GITHUB_TOKEN' },
    repositories,
    projects,
    running: true,
    settingsWritable: true,
    proxy: { mode: 'auto' as const, url: '' },
  })
  const setup: GitHubSetup = {
    status: async () => { calls.push('status'); return summary(true) },
    test: async () => { calls.push('test'); return { ok: true, login: 'octocat', scopes: ['repo', 'project'], credential: { configured: true, writable: true, envName: 'GITHUB_TOKEN' }, checks: [] } },
    setCredential: async token => { calls.push('setCredential ' + token); return summary(true) },
    clearCredential: async () => { calls.push('clearCredential'); return summary(false) },
    startDeviceAuth: async () => ({ flowId: 'flow-1', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }),
    pollDeviceAuth: async () => ({ status: 'pending', interval: 5 }),
    cancelDeviceAuth: () => true,
    importLocalAuth: async () => {
      calls.push('importLocalAuth')
      return { ok: true, source: 'gh-cli', login: 'octocat', scopes: ['repo', 'project'], summary: summary(true) }
    },
    listRepositories: () => { calls.push('listRepositories'); return [...repositories] },
    writeRepositories: async value => {
      calls.push('writeRepositories')
      repositories = value as GitHubRepoConfig[]
      return repositories
    },
    listProjects: () => { calls.push('listProjects'); return [...projects] },
    writeProjects: async value => {
      calls.push('writeProjects')
      projects = value as GitHubProjectConfig[]
      return projects
    },
    discoverOrgs: async () => {
      calls.push('discoverOrgs')
      return [{ login: 'deepseek-ai', name: 'DeepSeek' }]
    },
    discoverProjects: async () => {
      calls.push('discoverProjects')
      return [{ id: 'PVT_1', number: 4, title: 'Roadmap', url: 'https://github.com/orgs/deepseek-ai/projects/4', ownerType: 'organization', owner: 'deepseek-ai' }]
    },
    discoverRepositories: async () => [],
    createRemoteTask: async () => { throw new Error('not used in setup-tools.spec') },
    triggerSync: async () => ({ ok: true }),
    credential: async () => ({ configured: true, writable: true, envName: 'GITHUB_TOKEN' }),
    proxy: () => ({ mode: 'auto', url: '' }),
    setProxy: async () => { calls.push('setProxy'); return summary(true) },
  }
  return { setup, calls, list: () => repositories, listProjects: () => projects }
}

/** Locate one setup tool by name. */
function toolOf(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find(candidate => candidate.name === name)
  if (tool === undefined) throw new Error('tool ' + name + ' is not registered')
  return tool
}

/** Run one tool and return its structured result. */
async function run(tool: ToolDefinition, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await tool.execute(args, {} as never) as Record<string, unknown>
}

describe('GitHub setup tools', () => {
  it('operator mounting the provider without a setup surface gets no configuration tool', () => {
    // Given no setup surface
    // When the setup tools are built
    // Then none is registered, so the synchronization tools stand alone
    expect(buildSetupTools(undefined)).toEqual([])
  })

  it('operator\'s agent reads the setup status, stores a token and clears it', async () => {
    // Given the two configuration tools
    const { setup, calls } = setupDouble()
    const tool = toolOf(buildSetupTools(setup), 'task_board_github_setup')

    // When the model runs the three actions
    const status = await run(tool, { action: 'status' })
    const stored = await run(tool, { action: 'set-token', token: 'ghp_from_model' })
    const cleared = await run(tool, { action: 'clear-token' })

    // Then each reached the setup surface and answered ok
    expect(status.ok).toBe(true)
    expect(stored.ok).toBe(true)
    expect(cleared.ok).toBe(true)
    expect(calls).toEqual(['status', 'setCredential ghp_from_model', 'clearCredential'])
  })

  it('operator\'s agent asked to store a token without one is refused with a correctable reason', async () => {
    // Given the setup tool
    const { setup, calls } = setupDouble()
    const tool = toolOf(buildSetupTools(setup), 'task_board_github_setup')

    // When set-token runs with no token
    const result = await run(tool, { action: 'set-token' })

    // Then the refusal names the missing argument and nothing was stored
    expect(result).toMatchObject({ ok: false, code: 'token-required' })
    expect(calls).toEqual([])
  })

  it('operator\'s agent adding a repository writes the list the user will see', async () => {
    // Given the repositories tool and an empty configuration
    const { setup, list } = setupDouble()
    const tool = toolOf(buildSetupTools(setup), 'task_board_github_repositories')

    // When a repository is added through a pasted URL
    const result = await run(tool, { action: 'add', repository: 'https://github.com/deepseek-ai/dsh-web', inclusionLabel: 'board' })

    // Then the stored list carries it
    expect(result.ok).toBe(true)
    expect(list()).toEqual([{ owner: 'deepseek-ai', repository: 'dsh-web', inclusionLabel: 'board' }])
  })

  it('operator\'s agent adding a repository that is already configured is refused', async () => {
    // Given a configuration that already carries the repository
    const { setup } = setupDouble([{ owner: 'deepseek-ai', repository: 'dsh-web' }])
    const tool = toolOf(buildSetupTools(setup), 'task_board_github_repositories')

    // When the same repository is added again
    const result = await run(tool, { action: 'add', repository: 'deepseek-ai/dsh-web' })

    // Then the model is told it is already configured
    expect(result).toMatchObject({ ok: false, code: 'repository-duplicate' })
  })

  it("operator's agent can include the account's assigned issues in one add call", async () => {
    // Given the repositories tool and an empty configuration
    const { setup, list } = setupDouble()
    const tool = toolOf(buildSetupTools(setup), 'task_board_github_repositories')

    // When a repository is added with the assignee channel
    const result = await run(tool, { action: 'add', repository: 'deepseek-ai/dsh-web', assignee: '@me' })

    // Then the stored entry carries it, which is what makes assigned issues
    // reach the board without any label
    expect(result.ok).toBe(true)
    expect(list()).toEqual([{ owner: 'deepseek-ai', repository: 'dsh-web', assignee: '@me' }])
  })

  it("operator's agent can switch the unassigned channel on in one update call", async () => {
    // Given a configured repository
    const { setup, list } = setupDouble([{ owner: 'deepseek-ai', repository: 'dsh-web' }])
    const tool = toolOf(buildSetupTools(setup), 'task_board_github_repositories')

    // When it is updated to also take unassigned issues
    const result = await run(tool, { action: 'update', repository: 'deepseek-ai/dsh-web', includeUnassigned: true })

    // Then the stored entry carries the flag
    expect(result.ok).toBe(true)
    expect(list()).toEqual([{ owner: 'deepseek-ai', repository: 'dsh-web', includeUnassigned: true }])
  })

  it('operator\'s agent removing a repository drops exactly that entry', async () => {
    // Given two configured repositories
    const { setup, list } = setupDouble([{ owner: 'deepseek-ai', repository: 'dsh-web' }, { owner: 'other', repository: 'thing' }])
    const tool = toolOf(buildSetupTools(setup), 'task_board_github_repositories')

    // When one is removed
    const result = await run(tool, { action: 'remove', repository: 'other/thing' })

    // Then only the other survives
    expect(result.ok).toBe(true)
    expect(list()).toEqual([{ owner: 'deepseek-ai', repository: 'dsh-web' }])
  })

  it('operator\'s agent updating a repository changes only the fields it named', async () => {
    // Given a configured repository with a base branch
    const { setup, list } = setupDouble([{ owner: 'deepseek-ai', repository: 'dsh-web', baseBranch: 'dev' }])
    const tool = toolOf(buildSetupTools(setup), 'task_board_github_repositories')

    // When only the inclusion label is changed
    const result = await run(tool, { action: 'update', repository: 'deepseek-ai/dsh-web', inclusionLabel: 'board' })

    // Then the branch survived
    expect(result.ok).toBe(true)
    expect(list()).toEqual([{ owner: 'deepseek-ai', repository: 'dsh-web', baseBranch: 'dev', inclusionLabel: 'board' }])
  })

  it('operator\'s agent asking for an action the tool does not serve is refused by the tool contract', async () => {
    // Given the repositories tool
    const { setup, calls } = setupDouble()
    const tool = toolOf(buildSetupTools(setup), 'task_board_github_repositories')

    // When an unknown action runs
    const refused = run(tool, { action: 'destroy' })

    // Then the declared parameter contract refuses it before the extension is
    // reached, so an unknown action can never write configuration
    await expect(refused).rejects.toThrow(/action/)
    expect(calls).toEqual([])
  })

  it('operator\'s agent whose configuration write is refused sees the reason the host gave', async () => {
    // Given a setup surface whose write fails the way a read-only document does
    const { setup } = setupDouble()
    const failing: GitHubSetup = { ...setup, writeRepositories: async () => { throw new GitHubSetupError(409, 'read-only', 'this deployment serves configuration read-only') } }
    const tool = toolOf(buildSetupTools(failing), 'task_board_github_repositories')

    // When a repository is added
    const result = await run(tool, { action: 'add', repository: 'deepseek-ai/dsh-web' })

    // Then the refusal carries the host reason
    expect(result).toMatchObject({ ok: false, code: 'read-only', message: 'this deployment serves configuration read-only' })
  })

  it('operator\'s agent can import local auth and discover organizations', async () => {
    // Given a setup surface with local auth and org discovery
    const { setup, calls } = setupDouble([{ owner: 'deepseek-ai', repository: 'dsh-web' }])
    const setupTool = toolOf(buildSetupTools(setup), 'task_board_github_setup')

    // When import-local-auth and discover run
    const imported = await run(setupTool, { action: 'import-local-auth' })
    const discovered = await run(setupTool, { action: 'discover' })

    // Then the imported source and discovered orgs/targets are returned without any token
    expect(imported).toMatchObject({ ok: true, source: 'gh-cli', login: 'octocat' })
    expect(discovered).toMatchObject({
      ok: true,
      account: 'octocat',
      scopes: ['repo', 'project'],
      organizations: [{ login: 'deepseek-ai', name: 'DeepSeek' }],
      configuredRepositories: [{ owner: 'deepseek-ai', repository: 'dsh-web' }],
      configuredProjects: [],
    })
    expect(calls).toContain('importLocalAuth')
    expect(calls).toContain('discoverOrgs')
  })

  it('operator\'s agent can discover, add, update, and remove Projects v2', async () => {
    // Given the projects tool and an empty project list
    const { setup, listProjects } = setupDouble()
    const tool = toolOf(buildSetupTools(setup), 'task_board_github_projects')

    // When discovering, adding, updating, and removing a project
    const discovered = await run(tool, { action: 'discover', ownerType: 'organization', owner: 'deepseek-ai' })
    const added = await run(tool, {
      action: 'add',
      project: 'https://github.com/orgs/deepseek-ai/projects/4',
      title: 'Roadmap',
      includeDrafts: true,
      statusMap: { running: 'Doing' },
    })
    const updated = await run(tool, {
      action: 'update',
      project: 'org/deepseek-ai/projects/4',
      includeDrafts: false,
    })
    const listed = await run(tool, { action: 'list' })
    const removed = await run(tool, { action: 'remove', project: 'deepseek-ai#4' })

    // Then each step updates the stored project list cleanly
    expect(discovered).toMatchObject({
      ok: true,
      projects: [{ id: 'PVT_1', number: 4, title: 'Roadmap' }],
    })
    expect(added.ok).toBe(true)
    expect(updated.ok).toBe(true)
    expect(listed).toMatchObject({
      ok: true,
      projects: [{ ownerType: 'organization', owner: 'deepseek-ai', projectNumber: 4, title: 'Roadmap', includeDrafts: false, statusMap: { running: 'Doing' } }],
    })
    expect(removed.ok).toBe(true)
    expect(listProjects()).toEqual([])
  })
})
