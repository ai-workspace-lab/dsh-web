/**
 * The setup routes: who may reach them, what each method does, and how a bad
 * body is answered.
 *
 * The fence is the part that matters most — these routes write a GitHub token —
 * so the cases below drive real request objects with a non-loopback address and
 * with browser cross-site markers, and assert the refusal.
 */
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GitHubCredentialStatus, GitHubSetupSummary } from '../src/core/setup.ts'
import { createGitHubSetupApi } from '../src/client/setup-api.ts'
import { makeGitHubSetupRoutes } from '../src/host/routes.ts'
import type { GitHubSetup } from '../src/host/setup.ts'

const credential: GitHubCredentialStatus = { configured: false, writable: true, envName: 'GITHUB_TOKEN' }
const proxy: GitHubSetupSummary['proxy'] = { mode: 'auto', url: '' }
const summary: GitHubSetupSummary = { credential, repositories: [], projects: [], running: true, settingsWritable: true, proxy }

/** A setup surface double recording every operation the routes reach. */
function recordingSetup() {
  const calls: string[] = []
  const setup: GitHubSetup = {
    status: async () => { calls.push('status'); return summary },
    test: async (target) => {
      calls.push('test ' + (target?.owner ?? '*'))
      return { ok: true, login: 'octocat', credential, checks: [] }
    },
    setCredential: async token => { calls.push('setCredential ' + token); return summary },
    clearCredential: async () => { calls.push('clearCredential'); return summary },
    startDeviceAuth: async () => {
      calls.push('startDeviceAuth')
      return { flowId: 'flow-1', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 }
    },
    pollDeviceAuth: async (flowId) => {
      calls.push('pollDeviceAuth ' + flowId)
      return { status: 'pending', interval: 5 }
    },
    cancelDeviceAuth: (flowId) => {
      calls.push('cancelDeviceAuth ' + flowId)
      return true
    },
    importLocalAuth: async () => {
      calls.push('importLocalAuth')
      return { ok: true, source: 'gh-cli', login: 'octocat', summary }
    },
    listRepositories: () => { calls.push('listRepositories'); return [] },
    writeRepositories: async (value) => { calls.push('writeRepositories ' + JSON.stringify(value)); return value as never },
    listProjects: () => { calls.push('listProjects'); return [] },
    writeProjects: async (value) => { calls.push('writeProjects ' + JSON.stringify(value)); return value as never },
    discoverOrgs: async () => { calls.push('discoverOrgs'); return [{ login: 'deepseek-ai' }] },
    discoverProjects: async () => { calls.push('discoverProjects'); return [] },
    discoverRepositories: async () => { calls.push('discoverRepositories'); return [] },
    createRemoteTask: async (input) => {
      calls.push('createRemoteTask ' + input.mode)
      return {
        title: input.title,
        description: input.body ?? '',
        prompt: input.prompt ?? input.title,
        suggestedPrompt: input.title,
        payload: {
          provider: 'github',
          owner: 'deepseek-ai',
          repository: 'dsh',
          issueNumber: 1,
          issueUrl: 'https://github.com/deepseek-ai/dsh/issues/1',
          remoteLabels: [],
        },
      }
    },
    triggerSync: async () => { calls.push('triggerSync'); return { ok: true } },
    credential: async () => credential,
    proxy: () => { calls.push('proxy'); return proxy },
    setProxy: async (value) => { calls.push('setProxy ' + JSON.stringify(value)); return summary },
  }
  return { setup, calls }
}

/** One request double; defaults are a loopback GET from the local GUI. */
function request(overrides: { method?: string; address?: string; host?: string; fetchSite?: string; origin?: string; body?: unknown } = {}): IncomingMessage {
  const payload = overrides.body === undefined ? undefined : Buffer.from(JSON.stringify(overrides.body))
  return {
    method: overrides.method ?? 'GET',
    socket: { remoteAddress: overrides.address ?? '127.0.0.1' },
    headers: {
      host: overrides.host ?? '127.0.0.1:19387',
      ...(overrides.fetchSite === undefined ? {} : { 'sec-fetch-site': overrides.fetchSite }),
      ...(overrides.origin === undefined ? {} : { origin: overrides.origin }),
    },
    async *[Symbol.asyncIterator]() { if (payload !== undefined) yield payload },
    destroy() { /* the lenient reader destroys an oversized body */ },
  } as unknown as IncomingMessage
}

/** One response double capturing status and JSON body. */
function response() {
  const state = { status: 0, payload: '' }
  return {
    state,
    res: {
      writeHead: (status: number) => { state.status = status },
      end: (payload?: string) => { state.payload = payload ?? '' },
    } as unknown as ServerResponse,
    json: (): Record<string, unknown> => JSON.parse(state.payload) as Record<string, unknown>,
  }
}

/** Run one route by path suffix. */
async function call(routes: ReturnType<typeof makeGitHubSetupRoutes>, suffix: string, req: IncomingMessage) {
  const route = routes.find(candidate => candidate.path.endsWith(suffix))
  if (route === undefined) throw new Error('route ' + suffix + ' is not registered')
  const out = response()
  await route.handler(req, out.res)
  return out
}

describe('GitHub setup route addressing', () => {
  it('operator mounting the extension gets every setup route on an absolute request path', () => {
    // Given the extension's setup routes
    const routes = makeGitHubSetupRoutes(recordingSetup().setup)

    // When the webserver keys them for matching
    const paths = routes.map(route => route.path)

    // Then every path is absolute: the webserver matches the raw request path,
    // so a prefix without its leading slash answers nothing.
    expect(paths).toEqual([
      '/api/task-board-github/status',
      '/api/task-board-github/test',
      '/api/task-board-github/credential',
      '/api/task-board-github/repositories',
      '/api/task-board-github/proxy',
      '/api/task-board-github/auth/device/start',
      '/api/task-board-github/auth/device/poll',
      '/api/task-board-github/auth/device/cancel',
      '/api/task-board-github/auth/import-local',
      '/api/task-board-github/projects',
      '/api/task-board-github/discover/orgs',
      '/api/task-board-github/discover/projects',
      '/api/task-board-github/discover/repositories',
      '/api/task-board-github/tasks/create-remote',
      '/api/task-board-github/sync',
    ])
  })

  it('operator reading the setup status reaches the path the Host actually serves', async () => {
    // Given a card over a recorded fetch and the registered routes
    const seen: string[] = []
    const api = createGitHubSetupApi(async (input) => {
      seen.push(String(input))
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const routes = makeGitHubSetupRoutes(recordingSetup().setup)

    // When the card reads the status
    await api.status()

    // Then the request resolves to the route the Host actually registered
    const status = routes.find(route => route.path.endsWith('/status'))
    expect(new URL(seen[0], 'http://127.0.0.1:19387/').pathname).toBe(status?.path)
  })
})

describe('GitHub setup route fence', () => {
  it('operator on a LAN browser is refused before any setup operation runs', async () => {
    // Given the setup routes and a request arriving from a LAN address
    const { setup, calls } = recordingSetup()
    const routes = makeGitHubSetupRoutes(setup)

    // When the status route is called from that address
    const out = await call(routes, '/status', request({ address: '192.168.1.20', host: '192.168.1.20:19387' }))

    // Then it is refused and nothing was read or written
    expect(out.state.status).toBe(403)
    expect(calls).toEqual([])
  })

  it('operator on a cross-site page is refused even from the loopback address', async () => {
    // Given a loopback request carrying a cross-site marker
    const { setup } = recordingSetup()
    const routes = makeGitHubSetupRoutes(setup)

    // When it is answered
    const out = await call(routes, '/status', request({ fetchSite: 'cross-site' }))

    // Then the fence still refuses it
    expect(out.state.status).toBe(403)
  })
})

describe('GitHub setup routes', () => {
  it('operator reading the status gets the credential facts and the repositories', async () => {
    // Given a loopback request
    const { setup } = recordingSetup()
    const routes = makeGitHubSetupRoutes(setup)

    // When the status route is called
    const out = await call(routes, '/status', request())

    // Then the setup status is answered, uncached
    expect(out.state.status).toBe(200)
    expect(out.json()).toMatchObject({ ok: true, credential: { envName: 'GITHUB_TOKEN' }, running: true })
  })

  it('operator saving a repository list reaches the write path and answers with what was stored', async () => {
    // Given a loopback PUT with one repository
    const { setup, calls } = recordingSetup()
    const routes = makeGitHubSetupRoutes(setup)

    // When the repositories route is called
    const out = await call(routes, '/repositories', request({ method: 'PUT', body: { repositories: [{ owner: 'deepseek-ai', repository: 'dsh-web' }] } }))

    // Then the write ran with that list
    expect(out.state.status).toBe(200)
    expect(calls).toEqual(['writeRepositories [{"owner":"deepseek-ai","repository":"dsh-web"}]'])
  })

  it('operator sending a body that is not a repository list is refused with a 400', async () => {
    // Given a PUT without the array
    const { setup, calls } = recordingSetup()
    const routes = makeGitHubSetupRoutes(setup)

    // When the route is called
    const out = await call(routes, '/repositories', request({ method: 'PUT', body: { repositories: 'nope' } }))

    // Then it is a bad request and no write ran
    expect(out.state.status).toBe(400)
    expect(calls).toEqual([])
  })

  it('operator storing a token posts it to the credential path and never sees it echoed', async () => {
    // Given a POST carrying a token
    const { setup, calls } = recordingSetup()
    const routes = makeGitHubSetupRoutes(setup)

    // When the credential route is called
    const out = await call(routes, '/credential', request({ method: 'POST', body: { token: 'ghp_pasted' } }))

    // Then the token reached the store path and the answer carries facts only
    expect(out.state.status).toBe(200)
    expect(calls).toEqual(['setCredential ghp_pasted'])
    expect(out.state.payload).not.toContain('ghp_pasted')
  })

  it('operator posting no token is refused, and deleting clears the stored one', async () => {
    // Given the credential route
    const { setup, calls } = recordingSetup()
    const routes = makeGitHubSetupRoutes(setup)

    // When a POST without a token and then a DELETE arrive
    const missing = await call(routes, '/credential', request({ method: 'POST', body: {} }))
    const cleared = await call(routes, '/credential', request({ method: 'DELETE' }))

    // Then the first is a bad request and the second cleared the credential
    expect(missing.state.status).toBe(400)
    expect(cleared.state.status).toBe(200)
    expect(calls).toEqual(['clearCredential'])
  })

  it('operator using a method the route does not serve gets a 405', async () => {
    // Given the credential route
    const { setup } = recordingSetup()
    const routes = makeGitHubSetupRoutes(setup)

    // When it is called with GET
    const out = await call(routes, '/credential', request({ method: 'GET' }))

    // Then the method is refused
    expect(out.state.status).toBe(405)
  })

  it('operator running a connection test gets the report back', async () => {
    // Given a POST naming one repository
    const { setup, calls } = recordingSetup()
    const routes = makeGitHubSetupRoutes(setup)

    // When the test route is called
    const out = await call(routes, '/test', request({ method: 'POST', body: { owner: 'deepseek-ai', repository: 'dsh-web' } }))

    // Then the report is answered and the target reached the setup surface
    expect(out.state.status).toBe(200)
    expect(out.json().report).toMatchObject({ login: 'octocat' })
    expect(calls).toEqual(['test deepseek-ai'])
  })

  it('operator routes device auth, projects, discovery, remote task creation, and sync over loopback only', async () => {
    // Given the extended setup routes
    const { setup, calls } = recordingSetup()
    const routes = makeGitHubSetupRoutes(setup)

    // When calling each new route from loopback and once from non-loopback
    const nonLoopback = await call(routes, '/auth/device/start', request({ method: 'POST', address: '192.168.1.50', body: {} }))
    const started = await call(routes, '/auth/device/start', request({ method: 'POST', body: {} }))
    const polled = await call(routes, '/auth/device/poll', request({ method: 'POST', body: { flowId: 'flow-1' } }))
    const cancelled = await call(routes, '/auth/device/cancel', request({ method: 'POST', body: { flowId: 'flow-1' } }))
    const imported = await call(routes, '/auth/import-local', request({ method: 'POST', body: {} }))
    const projectsGet = await call(routes, '/projects', request({ method: 'GET' }))
    const projectsPut = await call(routes, '/projects', request({ method: 'PUT', body: { projects: [] } }))
    const orgs = await call(routes, '/discover/orgs', request({ method: 'GET' }))
    const discProjects = await call(routes, '/discover/projects', request({ method: 'GET' }))
    const discRepos = await call(routes, '/discover/repositories', request({ method: 'GET' }))
    const created = await call(routes, '/tasks/create-remote', request({ method: 'POST', body: { mode: 'issue', title: 'New' } }))
    const synced = await call(routes, '/sync', request({ method: 'POST', body: {} }))

    // Then non-loopback is forbidden and all loopback routes delegate cleanly
    expect(nonLoopback.state.status).toBe(403)
    expect(started.state.status).toBe(200)
    expect(polled.state.status).toBe(200)
    expect(cancelled.state.status).toBe(200)
    expect(imported.state.status).toBe(200)
    expect(projectsGet.state.status).toBe(200)
    expect(projectsPut.state.status).toBe(200)
    expect(orgs.state.status).toBe(200)
    expect(discProjects.state.status).toBe(200)
    expect(discRepos.state.status).toBe(200)
    expect(created.state.status).toBe(200)
    expect(synced.state.status).toBe(200)
    expect(calls).toEqual([
      'startDeviceAuth',
      'pollDeviceAuth flow-1',
      'cancelDeviceAuth flow-1',
      'importLocalAuth',
      'listProjects',
      'writeProjects []',
      'discoverOrgs',
      'discoverProjects',
      'discoverRepositories',
      'createRemoteTask issue',
      'triggerSync',
    ])
  })
})
