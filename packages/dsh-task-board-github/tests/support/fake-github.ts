/**
 * In-process GitHub REST stand-in covering exactly the endpoints the provider
 * calls: issue listing and lookup, label add/remove, branch lookup, PR creation
 * and lookup, and issue state patching. The provider's HTTP surface is its out
 * boundary, so replacing it is what keeps these cases free of a live network
 * without replacing the provider itself.
 *
 * @module tests/support/fake-github
 */
import type {
  GitHubIssuePayload,
  GitHubOrganizationSummary,
  GitHubProjectDetailPayload,
  GitHubPullRequestPayload,
  GitHubRemoteRepositorySummary,
} from '../../src/core/types.ts'

/** A JSON response with the GitHub content type. */
export function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  })
}

/** The label names carried by an issue payload. */
export function nameOf(labels: GitHubIssuePayload['labels']): string[] {
  return labels.map(label => (typeof label === 'string' ? label : label.name))
}

/** One open issue fixture carrying the given labels, body and assignees. */
export function issueFixture(number: number, labels: string[], body = '', assignees: string[] = []): GitHubIssuePayload {
  return {
    number,
    title: `Issue ${String(number)}`,
    body,
    state: 'open',
    html_url: `https://github.com/deepseek-ai/dsh/issues/${String(number)}`,
    labels,
    assignees: assignees.map(login => ({ login })),
    updated_at: '2026-09-02T10:00:00Z',
  }
}

/** One in-process GitHub remote. */
export class FakeGitHubBackend {
  issues: GitHubIssuePayload[] = []
  pulls: GitHubPullRequestPayload[] = []
  branches: string[] = []
  /** Login the stand-in answers `GET /user` with. */
  login = 'tester'
  /** OAuth scopes reported via `x-oauth-scopes` on `GET /user`. */
  scopes: string[] = ['repo', 'read:org', 'read:user', 'project']
  /** Organizations returned by `GET /user/orgs`. */
  orgs: GitHubOrganizationSummary[] = []
  /** Repositories returned by `GET /user/repos` and `/orgs/:org/repos`. */
  repositories: GitHubRemoteRepositorySummary[] = []
  /** Projects v2 served over GraphQL. */
  projects: GitHubProjectDetailPayload[] = []
  /** Optional forced GraphQL error type (e.g. 'INSUFFICIENT_SCOPES' or 'NOT_FOUND'). */
  graphqlError?: { type: string; message: string }
  /** Recorded Status updates from GraphQL mutations. */
  statusUpdates: Array<{ projectId: string; itemId: string; fieldId: string; optionId: string }> = []
  networkFailure = false
  /** How many HTTP calls reached the stand-in. */
  requests = 0
  /** How many of those were the `GET /user` identity read. */
  userReads = 0
  /** Comment bodies posted through the stand-in, in arrival order. */
  comments: Array<{ issueNumber: number, body: string }> = []

  fetch: typeof fetch = async (input, init) => {
    this.requests += 1
    if (this.networkFailure) throw new Error('Network error: ETIMEDOUT')
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const method = init?.method ?? 'GET'
    const pathname = url.pathname

    if (pathname === '/user' && method === 'GET') {
      this.userReads += 1
      return json({ login: this.login }, 200, { 'x-oauth-scopes': this.scopes.join(', ') })
    }
    if (pathname === '/user/orgs' && method === 'GET') {
      return json(this.orgs.map(org => ({ login: org.login, avatar_url: org.avatarUrl })))
    }
    if (pathname === '/user/repos' && method === 'GET') {
      return json(this.repositories.map(toRestRepo))
    }
    const orgReposMatch = pathname.match(/^\/orgs\/([^/]+)\/repos$/)
    if (orgReposMatch && method === 'GET') {
      const org = decodeURIComponent(orgReposMatch[1]!).toLowerCase()
      return json(this.repositories.filter(r => r.owner.toLowerCase() === org).map(toRestRepo))
    }
    if (pathname === '/graphql' && method === 'POST') {
      return this.handleGraphql(String(init?.body ?? '{}'))
    }
    const createIssueMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/issues$/)
    if (createIssueMatch && method === 'POST') {
      const owner = decodeURIComponent(createIssueMatch[1]!)
      const repo = decodeURIComponent(createIssueMatch[2]!)
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        title: string
        body?: string
        labels?: string[]
        assignees?: string[]
      }
      const nextNum = this.issues.reduce((max, item) => Math.max(max, item.number), 0) + 1
      const created: GitHubIssuePayload = {
        number: nextNum,
        node_id: `I_kwDO${String(nextNum)}`,
        title: body.title,
        body: body.body ?? '',
        state: 'open',
        html_url: `https://github.com/${owner}/${repo}/issues/${String(nextNum)}`,
        labels: body.labels ?? [],
        assignees: (body.assignees ?? []).map(login => ({ login })),
        updated_at: '2026-11-19T10:00:00Z',
      }
      this.issues.push(created)
      return json(created, 201)
    }
    if (pathname.includes('/issues') && method === 'GET' && !pathname.match(/\/issues\/\d+$/)) {
      return json(this.issues)
    }
    const issueMatch = pathname.match(/\/issues\/(\d+)$/)
    if (issueMatch && method === 'GET') {
      const found = this.issues.find(candidate => candidate.number === Number(issueMatch[1]))
      return found === undefined ? new Response('Not found', { status: 404 }) : json(found)
    }
    if (issueMatch && method === 'PATCH') {
      const found = this.issues.find(candidate => candidate.number === Number(issueMatch[1]))
      if (found === undefined) return new Response('Not found', { status: 404 })
      const body = JSON.parse(String(init?.body)) as { state?: 'open' | 'closed' }
      if (body.state !== undefined) found.state = body.state
      return json(found)
    }
    const labelsMatch = pathname.match(/\/issues\/(\d+)\/labels$/)
    if (labelsMatch && method === 'POST') {
      const found = this.issues.find(candidate => candidate.number === Number(labelsMatch[1]))
      if (found === undefined) return new Response('Not found', { status: 404 })
      const body = JSON.parse(String(init?.body)) as { labels: string[] }
      const existing = nameOf(found.labels)
      for (const label of body.labels) if (!existing.includes(label)) existing.push(label)
      found.labels = existing
      return json(existing)
    }
    const delLabelMatch = pathname.match(/\/issues\/(\d+)\/labels\/(.+)$/)
    if (delLabelMatch && method === 'DELETE') {
      const found = this.issues.find(candidate => candidate.number === Number(delLabelMatch[1]))
      if (found !== undefined) {
        const target = decodeURIComponent(delLabelMatch[2]!)
        found.labels = nameOf(found.labels).filter(label => label !== target)
      }
      return new Response(null, { status: 204 })
    }
    const branchMatch = pathname.match(/\/branches\/(.+)$/)
    if (branchMatch && method === 'GET') {
      const branchName = decodeURIComponent(branchMatch[1]!)
      return this.branches.includes(branchName)
        ? json({ name: branchName, commit: { sha: 'abc1234' } })
        : new Response('Branch not found', { status: 404 })
    }
    const commentMatch = pathname.match(/\/issues\/(\d+)\/comments$/)
    if (commentMatch && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { body: string }
      this.comments.push({ issueNumber: Number(commentMatch[1]), body: body.body })
      return json({ id: this.comments.length, html_url: `https://github.com/deepseek-ai/dsh/issues/${String(commentMatch[1])}#issuecomment-${String(this.comments.length)}`, body: body.body }, 201)
    }
    if (pathname.includes('/pulls') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { draft?: boolean, head: string, base: string }
      const number = this.pulls.length + 1
      const pull: GitHubPullRequestPayload = {
        number,
        html_url: `https://github.com/deepseek-ai/dsh/pull/${String(number)}`,
        state: 'open',
        draft: body.draft ?? false,
        head: { ref: body.head },
        base: { ref: body.base },
      }
      this.pulls.push(pull)
      return json(pull, 201)
    }
    const pullMatch = pathname.match(/\/pulls\/(\d+)$/)
    if (pullMatch && method === 'GET') {
      const found = this.pulls.find(candidate => candidate.number === Number(pullMatch[1]))
      return found === undefined ? new Response('Not found', { status: 404 }) : json(found)
    }
    return new Response('Unhandled endpoint', { status: 500 })
  }

  /** The label names currently on one issue. */
  labelsOf(issueNumber: number): string[] {
    return nameOf(this.issues.find(candidate => candidate.number === issueNumber)?.labels ?? [])
  }

  /** The state of one issue. */
  stateOf(issueNumber: number): string {
    return this.issues.find(candidate => candidate.number === issueNumber)?.state ?? 'unknown'
  }

  private handleGraphql(rawBody: string): Response {
    if (this.graphqlError !== undefined) {
      return json({ errors: [{ type: this.graphqlError.type, message: this.graphqlError.message }] })
    }
    const { query = '', variables = {} } = JSON.parse(rawBody) as {
      query?: string
      variables?: Record<string, unknown>
    }

    if (query.includes('addProjectV2ItemById')) {
      const projectId = String(variables.projectId ?? '')
      const contentId = String(variables.contentId ?? '')
      const project = this.projects.find(p => p.id === projectId)
      if (!project) return json({ errors: [{ type: 'NOT_FOUND', message: 'Project not found' }] })
      const itemId = `PVTI_${String(project.items.length + 1)}`
      const issue = this.issues.find(i => i.node_id === contentId)
      project.items.push({
        itemId,
        contentType: 'Issue',
        isDraft: false,
        issueNumber: issue?.number,
        issueNodeId: contentId,
        owner: project.owner,
        repository: 'dsh',
        title: issue?.title ?? 'Issue',
        body: issue?.body ?? '',
        state: issue?.state ?? 'open',
        url: issue?.html_url ?? project.url,
      })
      return json({ data: { addProjectV2ItemById: { item: { id: itemId } } } })
    }

    if (query.includes('addProjectV2DraftIssue')) {
      const projectId = String(variables.projectId ?? '')
      const project = this.projects.find(p => p.id === projectId)
      if (!project) return json({ errors: [{ type: 'NOT_FOUND', message: 'Project not found' }] })
      const itemId = `PVTI_draft_${String(project.items.length + 1)}`
      const draftIssueId = `DI_${String(project.items.length + 1)}`
      project.items.push({
        itemId,
        contentType: 'DraftIssue',
        isDraft: true,
        draftIssueId,
        title: String(variables.title ?? ''),
        body: typeof variables.body === 'string' ? variables.body : '',
        url: project.url,
      })
      return json({ data: { addProjectV2DraftIssue: { projectItem: { id: itemId, content: { id: draftIssueId } } } } })
    }

    if (query.includes('updateProjectV2ItemFieldValue')) {
      const projectId = String(variables.projectId ?? '')
      const itemId = String(variables.itemId ?? '')
      const fieldId = String(variables.fieldId ?? '')
      const optionId = String(variables.optionId ?? '')
      this.statusUpdates.push({ projectId, itemId, fieldId, optionId })
      const project = this.projects.find(p => p.id === projectId)
      const item = project?.items.find(i => i.itemId === itemId)
      if (item && project) {
        item.statusOptionId = optionId
        item.statusName = project.statusOptions.find(o => o.id === optionId)?.name
      }
      return json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: itemId } } } })
    }

    if (query.includes('projectV2(number:')) {
      const owner = String(variables.owner ?? '').toLowerCase()
      const number = Number(variables.number ?? 0)
      const isUser = query.includes('user(login:')
      const ownerType = isUser ? 'user' : 'organization'
      const project = this.projects.find(
        p => p.ownerType === ownerType && p.owner.toLowerCase() === owner && p.number === number,
      )
      const rootKey = isUser ? 'user' : 'organization'
      if (!project) {
        return json({ data: { [rootKey]: { projectV2: null } } })
      }
      const afterIndex = variables.after ? Number(variables.after) : 0
      const pageSize = 100
      const slice = project.items.slice(afterIndex, afterIndex + pageSize)
      const hasNextPage = afterIndex + pageSize < project.items.length
      const endCursor = hasNextPage ? String(afterIndex + pageSize) : null
      return json({
        data: {
          [rootKey]: {
            projectV2: {
              id: project.id,
              number: project.number,
              title: project.title,
              url: project.url,
              fields: {
                nodes: project.statusFieldId
                  ? [{ id: project.statusFieldId, name: 'Status', options: project.statusOptions }]
                  : [],
              },
              items: {
                pageInfo: { hasNextPage, endCursor },
                nodes: slice.map(item => ({
                  id: item.itemId,
                  updatedAt: item.updatedAt,
                  fieldValueByName: item.statusOptionId || item.statusName
                    ? { optionId: item.statusOptionId, name: item.statusName }
                    : null,
                  content: item.isDraft
                    ? {
                        __typename: 'DraftIssue',
                        id: item.draftIssueId,
                        title: item.title,
                        body: item.body ?? '',
                        updatedAt: item.updatedAt,
                        assignees: { nodes: (item.assignees ?? []).map(login => ({ login })) },
                      }
                    : {
                        __typename: 'Issue',
                        id: item.issueNodeId,
                        number: item.issueNumber,
                        title: item.title,
                        body: item.body ?? '',
                        state: (item.state ?? 'open').toUpperCase(),
                        url: item.url,
                        updatedAt: item.updatedAt,
                        repository: { name: item.repository ?? '', owner: { login: item.owner ?? project.owner } },
                        labels: { nodes: (item.labels ?? []).map(name => ({ name })) },
                        assignees: { nodes: (item.assignees ?? []).map(login => ({ login })) },
                      },
                })),
              },
            },
          },
        },
      })
    }

    if (query.includes('projectsV2(first:')) {
      if (query.includes('viewer')) {
        const userProjects = this.projects.filter(p => p.ownerType === 'user')
        return json({
          data: {
            viewer: {
              login: this.login,
              projectsV2: {
                nodes: userProjects.map(p => ({ id: p.id, number: p.number, title: p.title, url: p.url, closed: false })),
              },
            },
          },
        })
      }
      const org = String(variables.org ?? '').toLowerCase()
      const orgProjects = this.projects.filter(p => p.ownerType === 'organization' && p.owner.toLowerCase() === org)
      return json({
        data: {
          organization: {
            projectsV2: {
              nodes: orgProjects.map(p => ({ id: p.id, number: p.number, title: p.title, url: p.url, closed: false })),
            },
          },
        },
      })
    }

    return json({ errors: [{ message: 'Unhandled GraphQL query' }] })
  }
}

function toRestRepo(repo: GitHubRemoteRepositorySummary) {
  return {
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    default_branch: repo.defaultBranch,
    description: repo.description,
    html_url: repo.htmlUrl,
    owner: { login: repo.owner },
  }
}
