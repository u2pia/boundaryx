import { DEFAULT_PROJECT_ID, type ControlPlaneDatabase } from '../server/database.ts'
import type { ProjectRole } from '../server/types.ts'

/**
 * Smokes used to hand a repository path to every call. The repository now belongs to a project, so a smoke points the
 * default project at its fixture repository once — every actor created before or after is a member of it.
 */
export function useProjectRepository(database: ControlPlaneDatabase, repositoryPath: string, ownerActorId: string, defaultBranch = 'main') {
  return database.updateProjectSettings(DEFAULT_PROJECT_ID, { repositoryPath, defaultBranch }, ownerActorId)
}

/** A second local project, for smokes that need more than one. `members` left out means every non-owner at their role. */
export function createLocalProject(database: ControlPlaneDatabase, input: { slug: string; repositoryPath?: string; ownerActorId: string; members?: Array<{ actorId: string; role: ProjectRole }>; defaultBranch?: string }) {
  return database.createProject({ slug: input.slug, name: input.slug, codeHost: 'local', repositoryPath: input.repositoryPath, defaultBranch: input.defaultBranch, members: input.members }, input.ownerActorId)
}
