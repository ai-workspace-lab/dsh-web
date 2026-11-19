/**
 * GitHub authentication and credential cooperation tests:
 * - `dsh-connectors` delegation for Device Flow and SSO import
 * - `connectors/github` credential reading and precedence
 * - Standalone proxy-aware Device Flow fallback and `gh auth token` import
 *
 * @module tests/github-auth.spec
 */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GITHUB_OAUTH_CLIENT_ID,
  createGitHubAuthManager,
  type ConnectorsGitHubFace,
} from '../src/host/auth.ts'
import {
  CONNECTORS_GITHUB_CREDENTIAL_KEY,
  describeGitHubCredential,
  resolveGitHubToken,
  type CredentialFace,
} from '../src/host/credentials.ts'
import type { GitHubSetupSummary } from '../src/core/setup.ts'

function emptySummary(configured: boolean, source?: string): GitHubSetupSummary {
  return {
    credential: {
      configured,
      writable: true,
      envName: 'GITHUB_TOKEN',
      ...(source !== undefined ? { source } : {}),
    },
    repositories: [],
    projects: [],
    running: true,
    settingsWritable: true,
    proxy: { mode: 'auto', url: '' },
  }
}

function makeFakeCredentialStore(initial: {
  refs?: Record<string, string>
  records?: Record<string, unknown>
} = {}): { face: CredentialFace; refs: Map<string, string> } {
  const refs = new Map<string, string>(Object.entries(initial.refs ?? {}))
  const records = new Map<string, unknown>(Object.entries(initial.records ?? {}))
  const keyOf = (ref: unknown): string => {
    if (typeof ref === 'string') return ref
    if (typeof ref === 'object' && ref !== null && 'name' in ref) return String((ref as { name: unknown }).name)
    return String(ref)
  }
  const face: CredentialFace = {
    async resolve(ref) {
      const value = refs.get(keyOf(ref))
      return value === undefined ? undefined : { value, source: 'keychain' }
    },
    async describe(ref) {
      const configured = refs.has(keyOf(ref))
      return { configured, writable: true, ...(configured ? { source: 'keychain' } : {}) }
    },
    async set(ref, value) {
      refs.set(keyOf(ref), value)
    },
    async unset(ref) {
      refs.delete(keyOf(ref))
    },
    async readRecord(key) {
      return records.get(String(key))
    },
    async describeRecord(key) {
      const configured = records.has(String(key))
      return { configured, kind: 'oauth', writable: true }
    },
  }
  return { face, refs }
}

function makeContext(services: { credentials?: CredentialFace; connectors?: ConnectorsGitHubFace }): Context {
  return {
    get(name: string) {
      if (name === 'credentials') return services.credentials
      if (name === 'connectors') return services.connectors
      return undefined
    },
  } as unknown as Context
}

describe('credentials with dsh-connectors', () => {
  it('operator reads GrantRecord.payload.accessToken from connectors/github after credentialRef and before ambient env', async () => {
    // Given a credential store holding a connectors/github GrantRecord and an ambient GH_TOKEN
    const { face } = makeFakeCredentialStore({
      records: {
        [CONNECTORS_GITHUB_CREDENTIAL_KEY]: {
          kind: 'grant',
          payload: { accessToken: 'gho_connector_grant_token' },
        },
      },
    })
    const ctx = makeContext({ credentials: face })
    const env = { GH_TOKEN: 'ghp_ambient_fallback' }

    // When resolving and describing the GitHub credential
    const token = await resolveGitHubToken(ctx, 'GITHUB_TOKEN', env)
    const status = await describeGitHubCredential(ctx, 'GITHUB_TOKEN', env)

    // Then connectors/github wins over ambient env and reports source dsh-connectors
    expect(token).toBe('gho_connector_grant_token')
    expect(status.configured).toBe(true)
    expect(status.source).toBe('dsh-connectors')
  })

  it('operator reads ApiKeyRecord.key from connectors/github when no GrantRecord payload exists', async () => {
    // Given a credential store holding an ApiKeyRecord under connectors/github
    const { face } = makeFakeCredentialStore({
      records: {
        [CONNECTORS_GITHUB_CREDENTIAL_KEY]: {
          kind: 'apiKey',
          key: 'ghp_connector_apikey',
        },
      },
    })
    const ctx = makeContext({ credentials: face })

    // When resolving the token
    const token = await resolveGitHubToken(ctx, 'GITHUB_TOKEN', {})

    // Then the ApiKeyRecord key is returned
    expect(token).toBe('ghp_connector_apikey')
  })

  it('operator prefers explicit credentialRef over connectors/github', async () => {
    // Given both a direct GITHUB_TOKEN ref and a connectors/github record
    const { face } = makeFakeCredentialStore({
      refs: { GITHUB_TOKEN: 'ghp_direct_ref' },
      records: {
        [CONNECTORS_GITHUB_CREDENTIAL_KEY]: {
          payload: { accessToken: 'gho_connector_token' },
        },
      },
    })
    const ctx = makeContext({ credentials: face })

    // When resolving and describing the credential
    const token = await resolveGitHubToken(ctx, 'GITHUB_TOKEN', {})
    const status = await describeGitHubCredential(ctx, 'GITHUB_TOKEN', {})

    // Then the explicit credentialRef takes precedence
    expect(token).toBe('ghp_direct_ref')
    expect(status.source).toBe('keychain')
  })
})

describe('GitHubAuthManager', () => {
  it('operator delegates Device Flow and SSO import to dsh-connectors when mounted and keeps deviceCode off the wire', async () => {
    // Given a mounted dsh-connectors service and a credential store
    const { face, refs } = makeFakeCredentialStore()
    const calls: string[] = []
    const connectors: ConnectorsGitHubFace = {
      async startGitHubDevice(opts) {
        calls.push(`start:${opts?.clientId ?? ''}`)
        return {
          flowId: 'conn-flow-1',
          deviceCode: 'secret_device_code_never_exposed',
          userCode: 'ABCD-1234',
          verificationUri: 'https://github.com/login/device',
          expiresIn: 900,
          interval: 5,
        }
      },
      async pollGitHubDevice(input) {
        calls.push(`poll:${input.flowId ?? ''}:${input.deviceCode ?? ''}`)
        return {
          status: 'authorized',
          accessToken: 'gho_delegated_token',
          login: 'octocat',
          scopes: ['repo', 'project'],
        }
      },
      async importGitHubSso() {
        calls.push('importSso')
        return { ok: true, login: 'octocat', scopes: ['repo'] }
      },
    }
    const ctx = makeContext({ credentials: face, connectors })
    let nowMs = 1_000_000
    let reloaded = 0
    const auth = createGitHubAuthManager({
      ctx,
      tokenEnv: () => 'GITHUB_TOKEN',
      now: () => nowMs,
      onAuthorized: async () => {
        reloaded += 1
        return emptySummary(true, 'dsh-connectors')
      },
    })

    // When starting and polling Device Flow, then importing SSO
    const started = await auth.startDeviceAuth()
    const polled = await auth.pollDeviceAuth(started.flowId)
    const imported = await auth.importLocalAuth()

    // Then connectors handles both flows, deviceCode is never returned, and token is stored
    expect((started as unknown as Record<string, unknown>).deviceCode).toBeUndefined()
    expect(started.userCode).toBe('ABCD-1234')
    expect(polled.status).toBe('authorized')
    if (polled.status === 'authorized') {
      expect(polled.login).toBe('octocat')
      expect(polled.scopes).toEqual(['repo', 'project'])
    }
    expect(refs.get('GITHUB_TOKEN')).toBe('gho_delegated_token')
    expect(imported.ok).toBe(true)
    expect(imported.source).toBe('dsh-connectors')
    expect(reloaded).toBe(2)
    expect(calls).toEqual([
      `start:${DEFAULT_GITHUB_OAUTH_CLIENT_ID}`,
      'poll:conn-flow-1:secret_device_code_never_exposed',
      'importSso',
    ])
  })

  it('operator runs standalone Device Flow fallback with pending, slow_down, and authorized states', async () => {
    // Given no dsh-connectors service and a deterministic OAuth HTTP stub
    const { face, refs } = makeFakeCredentialStore()
    const ctx = makeContext({ credentials: face })
    let pollStep = 0
    let nowMs = 5_000
    const authFetch: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes('/login/device/code')) {
        return new Response(JSON.stringify({
          device_code: 'dc_standalone_secret',
          user_code: 'WXYZ-9876',
          verification_uri: 'https://github.com/login/device',
          expires_in: 600,
          interval: 5,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      pollStep += 1
      if (pollStep === 1) {
        return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 200 })
      }
      if (pollStep === 2) {
        return new Response(JSON.stringify({ error: 'slow_down', interval: 10 }), { status: 200 })
      }
      return new Response(JSON.stringify({
        access_token: 'gho_standalone_token',
        scope: 'repo read:org project',
      }), { status: 200 })
    }

    const auth = createGitHubAuthManager({
      ctx,
      tokenEnv: () => 'GITHUB_TOKEN',
      authFetchFor: () => authFetch,
      now: () => nowMs,
      verifyToken: async () => ({ login: 'builder', scopes: ['repo', 'read:org', 'project'] }),
      onAuthorized: async () => emptySummary(true, 'keychain'),
    })

    // When starting and polling through pending -> slow_down -> authorized
    const started = await auth.startDeviceAuth()
    const p1 = await auth.pollDeviceAuth(started.flowId)
    const p2 = await auth.pollDeviceAuth(started.flowId)
    const p3 = await auth.pollDeviceAuth(started.flowId)

    // Then the flow transitions cleanly and persists the token
    expect((started as unknown as Record<string, unknown>).deviceCode).toBeUndefined()
    expect(p1).toEqual({ status: 'pending', interval: 5 })
    expect(p2).toEqual({ status: 'pending', interval: 10 })
    expect(p3.status).toBe('authorized')
    if (p3.status === 'authorized') {
      expect(p3.login).toBe('builder')
      expect(p3.scopes).toEqual(['repo', 'read:org', 'project'])
    }
    expect(refs.get('GITHUB_TOKEN')).toBe('gho_standalone_token')
  })

  it('operator expires, denies, and cancels standalone Device Flow deterministically', async () => {
    // Given an auth manager with a controllable clock
    const { face } = makeFakeCredentialStore()
    const ctx = makeContext({ credentials: face })
    let nowMs = 1_000
    let denyNext = false
    const authFetch: typeof fetch = async (input) => {
      const url = String(input)
      if (url.includes('/login/device/code')) {
        return new Response(JSON.stringify({
          device_code: 'dc_exp',
          user_code: '1111-2222',
          verification_uri: 'https://github.com/login/device',
          expires_in: 10,
          interval: 5,
        }), { status: 200 })
      }
      if (denyNext) {
        return new Response(JSON.stringify({ error: 'access_denied' }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 200 })
    }

    const auth = createGitHubAuthManager({
      ctx,
      tokenEnv: () => 'GITHUB_TOKEN',
      authFetchFor: () => authFetch,
      now: () => nowMs,
      onAuthorized: async () => emptySummary(true),
    })

    // When a flow is cancelled
    const f1 = await auth.startDeviceAuth()
    expect(auth.cancelDeviceAuth(f1.flowId)).toBe(true)
    const cancelled = await auth.pollDeviceAuth(f1.flowId)
    // Then polling reports cancelled
    expect(cancelled.status).toBe('cancelled')

    // When a flow expires on the clock
    const f2 = await auth.startDeviceAuth()
    nowMs += 11_000
    const expired = await auth.pollDeviceAuth(f2.flowId)
    // Then polling reports expired without hitting the network
    expect(expired.status).toBe('expired')

    // When the user denies authorization
    denyNext = true
    const f3 = await auth.startDeviceAuth()
    const denied = await auth.pollDeviceAuth(f3.flowId)
    // Then polling reports denied
    expect(denied.status).toBe('denied')
  })

  it('operator imports a token from gh auth token fallback when dsh-connectors is absent', async () => {
    // Given no dsh-connectors and a readCliToken seam returning a gh CLI token
    const { face, refs } = makeFakeCredentialStore()
    const ctx = makeContext({ credentials: face })
    const auth = createGitHubAuthManager({
      ctx,
      tokenEnv: () => 'GITHUB_TOKEN',
      readCliToken: async () => 'gho_cli_imported',
      verifyToken: async () => ({ login: 'cli-user', scopes: ['repo', 'project'] }),
      onAuthorized: async () => emptySummary(true, 'keychain'),
    })

    // When importing local auth
    const result = await auth.importLocalAuth()

    // Then the CLI token is stored and verified
    expect(result.ok).toBe(true)
    expect(result.source).toBe('gh-cli')
    expect(result.login).toBe('cli-user')
    expect(refs.get('GITHUB_TOKEN')).toBe('gho_cli_imported')
  })
})
