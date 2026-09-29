import { execFileSync } from 'node:child_process'
import type { ProjectManifestSkill } from './project-manifest.ts'
import { sha256 } from './security.ts'
import { AppError } from './types.ts'
import { GIT_NO_EXEC } from './worktree-git.ts'

export const PROJECT_SKILL_MAX_BYTES = 32 * 1024

export type ProjectSkillBinding = ProjectManifestSkill & {
  baseSha: string
  fileBytes: number
  contentDigest: string
}

export function bindProjectSkills(repositoryPath: string, baseSha: string, skills: ProjectManifestSkill[] = []): ProjectSkillBinding[] {
  return skills.map((skill) => {
    let fileBytes: number
    try {
      const objectType = execFileSync('git', [...GIT_NO_EXEC, '-C', repositoryPath, 'cat-file', '-t', `${baseSha}:${skill.path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (objectType !== 'blob') throw new Error('not a blob')
      fileBytes = Number(execFileSync('git', [...GIT_NO_EXEC, '-C', repositoryPath, 'cat-file', '-s', `${baseSha}:${skill.path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
    } catch {
      throw new AppError(422, `Skill ${skill.name} is missing from the base revision: ${skill.path}`, 'project_skill_missing')
    }
    if (fileBytes > PROJECT_SKILL_MAX_BYTES) throw new AppError(422, `Skill ${skill.name} exceeds ${PROJECT_SKILL_MAX_BYTES} bytes: ${skill.path}`, 'project_skill_too_large')
    let content: Buffer
    try {
      content = execFileSync('git', [...GIT_NO_EXEC, '-C', repositoryPath, 'show', `${baseSha}:${skill.path}`], { maxBuffer: PROJECT_SKILL_MAX_BYTES, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      throw new AppError(422, `Skill ${skill.name} could not be read from the base revision: ${skill.path}`, 'project_skill_unreadable')
    }
    return { ...skill, baseSha, fileBytes, contentDigest: `sha256:${sha256(content)}` }
  })
}
