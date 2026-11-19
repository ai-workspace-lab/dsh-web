/**
 * GitHub repository source groups for the board's generic grouping contract.
 * The board receives only an opaque id and a display label; all GitHub
 * metadata interpretation stays inside this provider package.
 */
import type { TaskBoardSourceGroup } from '../../core/contract.ts'
import type { TaskRecord } from '../../core/task-record.ts'
import { readTaskGitHubMetadata } from '../../core/types.ts'

/** Return the source group (Project v2 or repository) for a GitHub-linked card. */
export function gitHubSourceGroup(task: TaskRecord): TaskBoardSourceGroup | undefined {
  const metadata = readTaskGitHubMetadata(task)
  if (metadata === undefined) return undefined
  if (metadata.project !== undefined) {
    const projectOwner = metadata.project.owner.trim()
    if (projectOwner !== '') {
      const num = String(metadata.project.projectNumber)
      const projectTitle = metadata.project.projectTitle?.trim()
      return {
        id: `github-project:${projectOwner.toLowerCase()}#${num}`,
        label: `${projectOwner} / ${projectTitle && projectTitle !== '' ? projectTitle : `Project #${num}`}`,
      }
    }
  }
  const owner = metadata.owner.trim()
  const repository = metadata.repository.trim()
  if (owner === '' || repository === '') return undefined
  return {
    id: `github:${owner.toLowerCase()}/${repository.toLowerCase()}`,
    label: `${owner}/${repository}`,
  }
}
