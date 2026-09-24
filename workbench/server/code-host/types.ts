import type { ChangeProposal, CodeHostKind, MergeMode, Project } from '../types.ts'

/**
 * docs/CODE_HOST_CONTRACT.md. A Code Host is where a project's repository lives. The control plane stays the
 * authority for Intents, gates, reviews and merge evidence; the host only stores code, shows pull requests and — in
 * `host_protected` mode — performs the merge under its own branch protection. Every host exposes the same local Git
 * directory to runs and merges, so the runner and the gate logic never branch on the provider.
 */
export type CodeHostDescriptor = {
  provider: CodeHostKind
  /** Human-readable location: an absolute path for local, `owner/repo` for GitHub. */
  repository: string
  mergeMode: MergeMode
  webUrl?: string
}

/** Booleans and permission names only: a connection test never returns a credential or the host's raw response. */
export type CodeHostConnection = {
  ok: boolean
  repositoryReachable: boolean
  defaultBranchFound: boolean
  credentialPresent: boolean
  missingPermissions: string[]
  message: string
}

export type PublishedProposal = { externalId: string; url: string; publishedRef: string; headShaPublished: string }

export interface CodeHost {
  readonly descriptor: CodeHostDescriptor
  /** The local Git directory runs and merges operate on. Throws `project_repository_unconfigured` when there is none. */
  workingRepository(): string
  /** Brings the default branch up to date before a run is admitted or a proposal is created or refreshed. */
  prepareForRun(): void
  /** Makes a branch that exists on the host available locally, for proposals opened from a branch pushed there. */
  ensureRef?(ref: string, refresh?: boolean): void
  /**
   * Called after the platform fast-forwarded the local default branch in `control_plane` mode. Publishes the result
   * or throws, and the authority then rolls the local branch back so platform and host never disagree.
   */
  publishMerge(input: { baseRef: string; baseShaBefore: string; mergedSha: string }): void
  /** Pushes the proposal's head and opens (or updates) the host's pull request. Undefined for hosts without one. */
  publishProposal?(input: { proposal: ChangeProposal; title: string; body: string; externalId?: string }): Promise<PublishedProposal>
  testConnection(): Promise<CodeHostConnection>
}

export type CodeHostFactoryContext = { dataDirectory: string; env: NodeJS.ProcessEnv }
export type CodeHostFactory = (project: Project, context: CodeHostFactoryContext) => CodeHost
