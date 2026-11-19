/**
 * Host routes of this extension's setup API.
 *
 * The settings card and the setup tools both write configuration through the
 * shared setup surface; the card reaches it over these same-origin routes, and
 * they are the only HTTP surface this extension opens. Every route answers
 * loopback requests only (the desktop and the local browser the GUI is served
 * to) — a paired LAN browser has no business reading or writing a GitHub token
 * — and no route ever echoes a credential value back.
 *
 * @module dsh-task-board-github/host/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { GITHUB_SETUP_API_PREFIX, type GitHubCreateRemoteTaskRequest } from '../core/setup.ts'
import type { GitHubProjectOwnerType } from '../core/types.ts'
import type { TaskStatus } from '../core/task-record.ts'
import { isLoopbackRequest } from '../loopback.ts'
import { asJsonObject, readJsonBody, writeJson } from './http.ts'
import { GitHubSetupError, type GitHubSetup } from './setup.ts'

/** Body cap of the credential route: one token, with room to spare. */
const CREDENTIAL_BODY_MAX_BYTES = 4 * 1024

/** Body cap of the repository route: hundreds of repositories still fit. */
const REPOSITORY_BODY_MAX_BYTES = 64 * 1024

/** Body cap of the proxy route: a mode and one URL. */
const PROXY_BODY_MAX_BYTES = 4 * 1024

/** Body cap of remote task creation: title, body, prompt, labels. */
const CREATE_REMOTE_BODY_MAX_BYTES = 64 * 1024

/**
 * Build the setup routes.
 * @param setup - the shared setup surface.
 * @returns the routes, for `ctx.webServer.register`.
 */
export function makeGitHubSetupRoutes(setup: GitHubSetup): WebRoute[] {
  return [
    {
      kind: 'exact',
      path: GITHUB_SETUP_API_PREFIX + '/status',
      handler: (req, res) => route(req, res, async () => {
        if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        writeJson(res, 200, { ok: true, ...(await setup.status()) }, { 'cache-control': 'no-store' })
      }),
    },
    {
      kind: 'exact',
      path: GITHUB_SETUP_API_PREFIX + '/test',
      handler: (req, res) => route(req, res, async () => {
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        const body = asJsonObject(await readJsonBody(req, { maxBytes: CREDENTIAL_BODY_MAX_BYTES })) ?? {}
        const owner = typeof body.owner === 'string' ? body.owner : undefined
        const repository = typeof body.repository === 'string' ? body.repository : undefined
        const report = await setup.test(owner === undefined || repository === undefined ? {} : { owner, repository })
        writeJson(res, 200, { ok: true, report }, { 'cache-control': 'no-store' })
      }),
    },
    {
      kind: 'exact',
      path: GITHUB_SETUP_API_PREFIX + '/credential',
      handler: (req, res) => route(req, res, async () => {
        if (req.method === 'DELETE') {
          writeJson(res, 200, { ok: true, ...(await setup.clearCredential()) }, { 'cache-control': 'no-store' })
          return
        }
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        const body = asJsonObject(await readJsonBody(req, { maxBytes: CREDENTIAL_BODY_MAX_BYTES }))
        const token = typeof body?.token === 'string' ? body.token : undefined
        if (token === undefined) return writeJson(res, 400, { ok: false, error: 'a token is required' })
        writeJson(res, 200, { ok: true, ...(await setup.setCredential(token)) }, { 'cache-control': 'no-store' })
      }),
    },
    {
      kind: 'exact',
      path: GITHUB_SETUP_API_PREFIX + '/repositories',
      handler: (req, res) => route(req, res, async () => {
        if (req.method === 'GET') {
          writeJson(res, 200, { ok: true, repositories: setup.listRepositories() }, { 'cache-control': 'no-store' })
          return
        }
        if (req.method !== 'PUT') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        const body = asJsonObject(await readJsonBody(req, { maxBytes: REPOSITORY_BODY_MAX_BYTES }))
        const list = body?.repositories
        if (!Array.isArray(list)) {
          return writeJson(res, 400, { ok: false, error: 'a repositories array is required' })
        }
        const repositories = await setup.writeRepositories(list)
        writeJson(res, 200, { ok: true, repositories }, { 'cache-control': 'no-store' })
      }),
    },
    {
      kind: 'exact',
      path: GITHUB_SETUP_API_PREFIX + '/proxy',
      handler: (req, res) => route(req, res, async () => {
        if (req.method === 'GET') {
          writeJson(res, 200, { ok: true, proxy: setup.proxy() }, { 'cache-control': 'no-store' })
          return
        }
        if (req.method !== 'PUT') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        const body = asJsonObject(await readJsonBody(req, { maxBytes: PROXY_BODY_MAX_BYTES }))
        if (body === undefined) return writeJson(res, 400, { ok: false, error: 'a proxy configuration is required' })
        writeJson(res, 200, { ok: true, ...(await setup.setProxy({ mode: body.mode, url: body.url })) }, { 'cache-control': 'no-store' })
      }),
    },
    {
      kind: 'exact',
      path: GITHUB_SETUP_API_PREFIX + '/auth/device/start',
      handler: (req, res) => route(req, res, async () => {
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        const body = asJsonObject(await readJsonBody(req, { maxBytes: CREDENTIAL_BODY_MAX_BYTES })) ?? {}
        const clientId = typeof body.clientId === 'string' ? body.clientId : undefined
        const scopes = Array.isArray(body.scopes) && body.scopes.every(s => typeof s === 'string') ? body.scopes : undefined
        const flow = await setup.startDeviceAuth({ ...(clientId !== undefined ? { clientId } : {}), ...(scopes !== undefined ? { scopes } : {}) })
        writeJson(res, 200, { ok: true, flow }, { 'cache-control': 'no-store' })
      }),
    },
    {
      kind: 'exact',
      path: GITHUB_SETUP_API_PREFIX + '/auth/device/poll',
      handler: (req, res) => route(req, res, async () => {
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        const body = asJsonObject(await readJsonBody(req, { maxBytes: CREDENTIAL_BODY_MAX_BYTES }))
        const flowId = typeof body?.flowId === 'string' ? body.flowId.trim() : ''
        if (flowId === '') return writeJson(res, 400, { ok: false, error: 'flowId is required' })
        const result = await setup.pollDeviceAuth(flowId)
        writeJson(res, 200, { ok: true, result }, { 'cache-control': 'no-store' })
      }),
    },
    {
      kind: 'exact',
      path: GITHUB_SETUP_API_PREFIX + '/auth/device/cancel',
      handler: (req, res) => route(req, res, async () => {
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        const body = asJsonObject(await readJsonBody(req, { maxBytes: CREDENTIAL_BODY_MAX_BYTES }))
        const flowId = typeof body?.flowId === 'string' ? body.flowId.trim() : ''
        if (flowId === '') return writeJson(res, 400, { ok: false, error: 'flowId is required' })
        const cancelled = setup.cancelDeviceAuth(flowId)
        writeJson(res, 200, { ok: true, cancelled }, { 'cache-control': 'no-store' })
      }),
    },
    {
      kind: 'exact',
      path: GITHUB_SETUP_API_PREFIX + '/auth/import-local',
      handler: (req, res) => route(req, res, async () => {
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        const result = await setup.importLocalAuth()
        writeJson(res, 200, result, { 'cache-control': 'no-store' })
      }),
    },
    {
      kind: 'exact',
      path: GITHUB_SETUP_API_PREFIX + '/projects',
      handler: (req, res) => route(req, res, async () => {
        if (req.method === 'GET') {
          writeJson(res, 200, { ok: true, projects: setup.listProjects() }, { 'cache-control': 'no-store' })
          return
        }
        if (req.method !== 'PUT') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        const body = asJsonObject(await readJsonBody(req, { maxBytes: REPOSITORY_BODY_MAX_BYTES }))
        const list = body?.projects
        if (!Array.isArray(list)) {
          return writeJson(res, 400, { ok: false, error: 'a projects array is required' })
        }
        const projects = await setup.writeProjects(list)
        writeJson(res, 200, { ok: true, projects }, { 'cache-control': 'no-store' })
      }),
    },
    {
      kind: 'exact',
      path: GITHUB_SETUP_API_PREFIX + '/discover/orgs',
      handler: (req, res) => route(req, res, async () => {
        if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        const orgs = await setup.discoverOrgs()
        writeJson(res, 200, { ok: true, orgs }, { 'cache-control': 'no-store' })
      }),
    },
    {
      kind: 'exact',
      path: GITHUB_SETUP_API_PREFIX + '/discover/projects',
      handler: (req, res) => route(req, res, async () => {
        if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const rawOwnerType = url.searchParams.get('ownerType')
        const ownerType: GitHubProjectOwnerType | undefined =
          rawOwnerType === 'organization' || rawOwnerType === 'user' ? rawOwnerType : undefined
        const owner = url.searchParams.get('owner') ?? undefined
        const projects = await setup.discoverProjects({
          ...(ownerType !== undefined ? { ownerType } : {}),
          ...(owner !== undefined && owner.trim() !== '' ? { owner: owner.trim() } : {}),
        })
        writeJson(res, 200, { ok: true, projects }, { 'cache-control': 'no-store' })
      }),
    },
    {
      kind: 'exact',
      path: GITHUB_SETUP_API_PREFIX + '/discover/repositories',
      handler: (req, res) => route(req, res, async () => {
        if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const org = url.searchParams.get('org') ?? undefined
        const repositories = await setup.discoverRepositories({
          ...(org !== undefined && org.trim() !== '' ? { org: org.trim() } : {}),
        })
        writeJson(res, 200, { ok: true, repositories }, { 'cache-control': 'no-store' })
      }),
    },
    {
      kind: 'exact',
      path: GITHUB_SETUP_API_PREFIX + '/tasks/create-remote',
      handler: (req, res) => route(req, res, async () => {
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        const body = asJsonObject(await readJsonBody(req, { maxBytes: CREATE_REMOTE_BODY_MAX_BYTES }))
        if (body === undefined) return writeJson(res, 400, { ok: false, error: 'a task creation payload is required' })
        const mode = body.mode
        if (mode !== 'issue' && mode !== 'project-issue' && mode !== 'project-draft') {
          return writeJson(res, 400, { ok: false, error: 'mode must be issue, project-issue, or project-draft' })
        }
        const rawStatus = body.status
        const status: TaskStatus | undefined =
          rawStatus === 'backlog' || rawStatus === 'todo' || rawStatus === 'running' || rawStatus === 'done' || rawStatus === 'failed'
            ? rawStatus
            : undefined
        const request: GitHubCreateRemoteTaskRequest = {
          mode,
          title: typeof body.title === 'string' ? body.title : '',
          ...(typeof body.owner === 'string' ? { owner: body.owner } : {}),
          ...(typeof body.repository === 'string' ? { repository: body.repository } : {}),
          ...(body.projectOwnerType === 'organization' || body.projectOwnerType === 'user' ? { projectOwnerType: body.projectOwnerType } : {}),
          ...(typeof body.projectOwner === 'string' ? { projectOwner: body.projectOwner } : {}),
          ...(typeof body.projectNumber === 'number' ? { projectNumber: body.projectNumber } : {}),
          ...(typeof body.body === 'string' ? { body: body.body } : {}),
          ...(typeof body.prompt === 'string' ? { prompt: body.prompt } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(Array.isArray(body.labels) && body.labels.every(l => typeof l === 'string') ? { labels: body.labels } : {}),
          ...(Array.isArray(body.assignees) && body.assignees.every(a => typeof a === 'string') ? { assignees: body.assignees } : {}),
        }
        const created = await setup.createRemoteTask(request)
        writeJson(res, 200, { ok: true, ...created }, { 'cache-control': 'no-store' })
      }),
    },
    {
      kind: 'exact',
      path: GITHUB_SETUP_API_PREFIX + '/sync',
      handler: (req, res) => route(req, res, async () => {
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        const result = await setup.triggerSync()
        writeJson(res, 200, result, { 'cache-control': 'no-store' })
      }),
    },
  ]
}

/**
 * One route body: the loopback fence, then the handler, with failures mapped
 * onto a status the card can explain.
 */
async function route(req: IncomingMessage, res: ServerResponse, handler: () => Promise<void>): Promise<void> {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
    return
  }
  try {
    await handler()
  } catch (error) {
    if (error instanceof GitHubSetupError) {
      writeJson(res, error.status, { ok: false, error: error.message, code: error.code })
      return
    }
    writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
