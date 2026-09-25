import { execFileSync } from 'node:child_process'
import { resolveProjectRepository } from './code-host/index.ts'
import { loadProjectManifest } from './project-manifest.ts'
import { AppError, type Project, type WorkItem } from './types.ts'

/**
 * What a project builds, read from `.aperture/project.json` on its default branch, the same file a Run is admitted
 * against. A work item takes its product type from here, so it cannot be created as one kind of product and fail at
 * its first Run for being the other. `undefined` means the project has no repository yet; nothing can run there.
 */
export function projectProductType(database: { getProject(projectId: string): Project; dataDirectory: string }, projectId: string): WorkItem['productType'] | undefined {
  const project = database.getProject(projectId)
  if (project.codeHost === 'local' && !project.repositoryPath) return undefined
  const { host, repositoryPath } = resolveProjectRepository(database, projectId)
  host.prepareForRun()
  let baseSha: string
  try {
    baseSha = execFileSync('git', ['-C', repositoryPath, 'rev-parse', '--verify', `${project.defaultBranch}^{commit}`], { encoding: 'utf8' }).trim()
  } catch {
    throw new AppError(409, `Project ${project.slug} has no branch ${project.defaultBranch}`, 'project_default_branch_missing')
  }
  try {
    return loadProjectManifest(repositoryPath, baseSha).manifest.productType
  } catch (error) {
    if (error instanceof AppError && error.code === 'project_manifest_missing') throw new AppError(422, `项目 ${project.slug} 的 ${project.defaultBranch} 分支还没有 .aperture/project.json：先提交它（写明 productType 和测试命令），再创建 Intent`, 'project_manifest_missing')
    throw error
  }
}
