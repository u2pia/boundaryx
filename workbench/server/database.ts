import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createSessionToken, hashPassword, hashSessionToken, sha256, verifyPassword } from './security.ts'
import { criterionStatus, isSubstantiveHumanCriterion, mapCriteriaToChecks, mentionsCriterion, type CriterionCoverage } from './criteria-coverage.ts'
import { requestContext } from './request-context.ts'
import { normalizeProjectHost, type ProjectHostInput } from './code-host/index.ts'
import type { AcceptanceCriterionInput, BuilderStopReason, Actor, CodeHostLink, HostMergeRecord, AuthMethod, CriterionOverride, DecisionIdentity, IdentityBinding, IdentityMode, GovernanceDecision, AgentProviderSettings, Project, ProjectMember, ProjectRole, AgentProviderSettingsView, AgentRun, ChangeProposal, DomainEvent, IntentVersion, MergeEvidence, ReleaseCandidate, ReviewAssignment, ReviewDecision, ReviewerLoad, ReviewMetrics, ReviewReadiness, ReviewRecord, SessionActor, TeamRole, WorkItem } from './types.ts'
import { AppError } from './types.ts'

type SqlValue = string | number | null

function nowIso() {
  return new Date().toISOString()
}

function id(prefix: string) {
  return `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

export const DEFAULT_PROJECT_ID = 'PRJ-DEFAULT'
/** Migration 020: records what a code host reported. Disabled, has no credential, and can never decide anything. */
export const SYSTEM_CODE_HOST_ACTOR_ID = 'ACT-SYSTEM-CODE-HOST'
const ALL_ROLES: TeamRole[] = ['owner', 'maintainer', 'reviewer', 'developer']
const PROJECT_ROLES: ProjectRole[] = ['maintainer', 'reviewer', 'developer']
const PROJECT_TABLES: Record<string, string> = { work_item: 'work_items', change_proposal: 'change_proposals', agent_run: 'agent_runs', release_candidate: 'release_candidates' }

/** `project_id IN (...)` for an optional visibility list; an empty list matches nothing rather than everything. */
function projectClause(column: string, projectIds?: string[]) {
  if (!projectIds) return { sql: '', params: [] as string[] }
  if (!projectIds.length) return { sql: 'WHERE 1 = 0', params: [] as string[] }
  return { sql: `WHERE ${column} IN (${projectIds.map(() => '?').join(', ')})`, params: projectIds }
}

export class ControlPlaneDatabase {
  readonly db: DatabaseSync
  readonly databasePath: string
  /** Where the control plane keeps its own files; a project repository may not live in its managed subdirectories. */
  readonly dataDirectory: string

  constructor(databasePath: string, migrationDirectory: string) {
    this.databasePath = databasePath
    this.dataDirectory = dirname(databasePath)
    this.db = new DatabaseSync(databasePath)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
    this.migrate(migrationDirectory)
  }

  close() {
    this.db.close()
  }

  private migrate(directory: string) {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
    const applied = new Set((this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((row) => row.version))
    const files = readdirSync(directory).filter((file) => /^\d+_.*\.sql$/u.test(file)).sort()
    for (const file of files) {
      const version = Number(file.split('_')[0])
      if (applied.has(version)) continue
      const sql = readFileSync(join(directory, file), 'utf8')
      // SQLite cannot change a CHECK constraint in place, and rebuilding a table other tables reference only works
      // with foreign keys off — which cannot be toggled inside a transaction. Such a migration opts in with a marker
      // and must leave foreign_key_check clean before it commits.
      const rebuildsTables = sql.startsWith('-- migrate:foreign-keys-off')
      if (rebuildsTables) this.db.exec('PRAGMA foreign_keys = OFF')
      try {
        this.inTransaction(() => {
          this.db.exec(sql)
          if (version === 19) this.backfillProjects()
          if (rebuildsTables && (this.db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length) throw new Error(`Migration ${file} left foreign key violations`)
          this.db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(version, basename(file), nowIso())
        })
      } finally {
        if (rebuildsTables) this.db.exec('PRAGMA foreign_keys = ON')
      }
    }
  }

  /**
   * Migration 019. Before projects, every run and proposal named its repository by path. Each distinct path becomes a
   * local project, work items follow their proposals and runs (or fall into the default project), and every
   * non-owner member joins every project with their current role, so nobody gains or loses access by upgrading.
   */
  private backfillProjects() {
    const paths = this.db.prepare(`
      SELECT repository_path, MIN(created_at) AS first_seen FROM (
        SELECT repository_path, created_at FROM change_proposals UNION ALL
        SELECT repository_path, started_at AS created_at FROM agent_runs UNION ALL
        SELECT repository_path, created_at FROM release_candidates
      ) WHERE repository_path IS NOT NULL AND repository_path != '' GROUP BY repository_path ORDER BY first_seen
    `).all() as Array<{ repository_path: string }>
    const slugs = new Set(['default'])
    const timestamp = nowIso()
    for (const { repository_path: repositoryPath } of paths) {
      const base = basename(repositoryPath).toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 32) || 'repository'
      let slug = base
      for (let suffix = 2; slugs.has(slug); suffix += 1) slug = `${base}-${suffix}`
      slugs.add(slug)
      const branch = this.db.prepare(`
        SELECT base_ref, COUNT(*) AS uses FROM (SELECT base_ref FROM change_proposals WHERE repository_path = ? UNION ALL SELECT base_ref FROM agent_runs WHERE repository_path = ?)
        GROUP BY base_ref ORDER BY uses DESC, base_ref LIMIT 1
      `).get(repositoryPath, repositoryPath) as { base_ref: string } | undefined
      this.db.prepare("INSERT INTO projects(id, slug, name, description, code_host, code_host_config, repository_path, default_branch, merge_mode, status, created_by_actor_id, created_at, updated_at) VALUES (?, ?, ?, '', 'local', '{}', ?, ?, 'control_plane', 'active', NULL, ?, ?)").run(id('PRJ'), slug, basename(repositoryPath) || slug, repositoryPath, branch?.base_ref ?? 'main', timestamp, timestamp)
    }
    const byPath = '(SELECT id FROM projects WHERE projects.repository_path = {table}.repository_path)'
    this.db.exec(`
      UPDATE work_items SET project_id = COALESCE(
        (SELECT ${byPath.replace('{table}', 'change_proposals')} FROM change_proposals WHERE change_proposals.work_item_id = work_items.id ORDER BY created_at LIMIT 1),
        (SELECT ${byPath.replace('{table}', 'agent_runs')} FROM agent_runs WHERE agent_runs.work_item_id = work_items.id ORDER BY started_at LIMIT 1),
        '${DEFAULT_PROJECT_ID}');
      UPDATE agent_runs SET project_id = (SELECT project_id FROM work_items WHERE work_items.id = agent_runs.work_item_id);
      UPDATE change_proposals SET project_id = (SELECT project_id FROM work_items WHERE work_items.id = change_proposals.work_item_id);
      UPDATE release_candidates SET project_id = (SELECT project_id FROM change_proposals WHERE change_proposals.id = release_candidates.change_proposal_id);
      -- The one sanctioned write to past events: project_id is a routing column outside the digest, so the chain holds.
      -- Dropping and recreating the guard inside this transaction means nothing else can slip through meanwhile.
      DROP TRIGGER domain_events_no_update;
      UPDATE domain_events SET project_id = CASE aggregate_type
        WHEN 'work_item' THEN (SELECT project_id FROM work_items WHERE id = aggregate_id)
        WHEN 'agent_run' THEN (SELECT project_id FROM agent_runs WHERE id = aggregate_id)
        WHEN 'change_proposal' THEN (SELECT project_id FROM change_proposals WHERE id = aggregate_id)
        WHEN 'release_candidate' THEN (SELECT project_id FROM release_candidates WHERE id = aggregate_id)
        ELSE NULL END;
      CREATE TRIGGER domain_events_no_update BEFORE UPDATE ON domain_events BEGIN SELECT RAISE(ABORT, 'domain_events are append-only'); END;
      INSERT INTO project_members(project_id, actor_id, role, added_by_actor_id, added_at)
        SELECT projects.id, actors.id, actors.role, NULL, '${timestamp}' FROM projects CROSS JOIN actors WHERE actors.role != 'owner';
    `)
    for (const project of this.db.prepare('SELECT id, slug, repository_path FROM projects').all() as Array<{ id: string; slug: string; repository_path: string | null }>) {
      this.appendEvent({ aggregateType: 'project', aggregateId: project.id, eventType: 'project.created', payload: { source: 'migration_019', slug: project.slug, codeHost: 'local', repositoryPath: project.repository_path } })
    }
  }

  inTransaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  hasActors() {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM actors WHERE username NOT LIKE 'system:%'").get() as { count: number }).count) > 0
  }

  /**
   * `projectIds` names the projects a non-owner joins, with their role as the project role. Left out, they join every
   * active project — the single-team default. An owner joins nothing: they are an implicit owner of every project.
   */
  createActor(input: { username: string; displayName: string; role: TeamRole; password: string; projectIds?: string[] }, createdByActorId?: string) {
    const timestamp = nowIso()
    const actor: Actor = { id: id('ACT'), username: input.username.trim(), displayName: input.displayName.trim(), role: input.role, status: 'active', createdAt: timestamp }
    if (!actor.username || !actor.displayName) throw new AppError(400, 'Username and display name are required', 'invalid_actor')
    // Granting a role is granting capabilities, so it is a decision like any other (DOMAIN_MODEL.md §5).
    const identity = createdByActorId ? this.decisionIdentity(createdByActorId) : undefined
    // The default project carries the sample data everyone may look at, so every member joins it whatever else they join.
    const projectIds = actor.role === 'owner' ? [] : [...new Set([DEFAULT_PROJECT_ID, ...(input.projectIds ?? this.listProjects().filter((project) => project.status === 'active').map((project) => project.id))])]
    for (const projectId of projectIds) this.getProject(projectId)
    return this.inTransaction(() => {
      this.db.prepare('INSERT INTO actors(id, username, display_name, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(actor.id, actor.username, actor.displayName, actor.role, actor.status, actor.createdAt)
      this.db.prepare('INSERT INTO local_credentials(actor_id, password_hash, updated_at) VALUES (?, ?, ?)').run(actor.id, hashPassword(input.password), timestamp)
      this.appendEvent({ aggregateType: 'actor', aggregateId: actor.id, eventType: 'actor.created', actorId: createdByActorId, payload: { username: actor.username, displayName: actor.displayName, role: actor.role, projectIds, identity: identity ?? null } })
      for (const projectId of projectIds) {
        this.db.prepare('INSERT INTO project_members(project_id, actor_id, role, added_by_actor_id, added_at) VALUES (?, ?, ?, ?, ?)').run(projectId, actor.id, actor.role, createdByActorId ?? null, timestamp)
        this.appendEvent({ aggregateType: 'project', aggregateId: projectId, eventType: 'project.member_added', actorId: createdByActorId, payload: { actorId: actor.id, role: actor.role, basis: 'actor_created', identity: identity ?? null } })
      }
      return actor
    })
  }

  /**
   * An owner edits an existing member: display name, default role, active/disabled, or a new password. Each change is
   * a decision recorded with the owner's identity; the password itself never enters the event. The default role only
   * seeds future project memberships — roles already granted per project are changed on the project, not here.
   * Disabling a member or resetting their password ends their open sessions.
   */
  updateActor(actorId: string, patch: { displayName?: string; role?: TeamRole; status?: Actor['status']; password?: string }, byActorId: string) {
    const row = this.db.prepare('SELECT id, username, display_name, role, status FROM actors WHERE id = ?').get(actorId) as Record<string, string> | undefined
    if (!row || row.username.startsWith('system:')) throw new AppError(404, `Member ${actorId} not found`, 'actor_not_found')
    const identity = this.decisionIdentity(byActorId)
    const changes: Record<string, unknown> = {}
    const displayName = patch.displayName?.trim()
    if (patch.displayName !== undefined && !displayName) throw new AppError(400, 'Display name is required', 'invalid_actor')
    if (displayName && displayName !== row.display_name) changes.displayName = { from: row.display_name, to: displayName }
    if (patch.role !== undefined && patch.role !== row.role) {
      if (row.role === 'owner' || patch.role === 'owner') throw new AppError(400, 'The platform owner role is not granted or removed here', 'owner_role_fixed')
      changes.role = { from: row.role, to: patch.role }
    }
    if (patch.status !== undefined && patch.status !== row.status) {
      if (actorId === byActorId) throw new AppError(400, 'You cannot disable yourself', 'cannot_disable_self')
      if (row.role === 'owner') throw new AppError(400, 'The platform owner cannot be disabled', 'owner_role_fixed')
      changes.status = { from: row.status, to: patch.status }
    }
    const passwordHash = patch.password !== undefined ? (() => { try { return hashPassword(patch.password!) } catch (error) { throw new AppError(400, error instanceof Error ? error.message : String(error), 'invalid_password') } })() : undefined
    if (!Object.keys(changes).length && !passwordHash) throw new AppError(400, 'Nothing to change', 'no_change')
    const timestamp = nowIso()
    return this.inTransaction(() => {
      if (changes.displayName) this.db.prepare('UPDATE actors SET display_name = ? WHERE id = ?').run(displayName!, actorId)
      if (changes.role) this.db.prepare('UPDATE actors SET role = ? WHERE id = ?').run(patch.role!, actorId)
      if (changes.status) this.db.prepare('UPDATE actors SET status = ? WHERE id = ?').run(patch.status!, actorId)
      if (passwordHash) this.db.prepare('UPDATE local_credentials SET password_hash = ?, updated_at = ? WHERE actor_id = ?').run(passwordHash, timestamp, actorId)
      // Resetting your own password keeps you signed in; anyone else's reset, or a disable, signs them out everywhere.
      if (changes.status || (passwordHash && actorId !== byActorId)) this.db.prepare('DELETE FROM sessions WHERE actor_id = ?').run(actorId)
      this.appendEvent({ aggregateType: 'actor', aggregateId: actorId, eventType: 'actor.updated', actorId: byActorId, payload: { ...changes, passwordReset: Boolean(passwordHash), identity } })
      return this.listActors().find((actor) => actor.id === actorId)!
    })
  }

  listActors(): Actor[] {
    const bindings = new Map((this.db.prepare('SELECT * FROM identity_bindings').all() as Array<Record<string, SqlValue>>).map((row) => [String(row.actor_id), this.mapIdentityBinding(row)]))
    return (this.db.prepare("SELECT id, username, display_name, role, status, created_at FROM actors WHERE username NOT LIKE 'system:%' ORDER BY created_at").all() as Array<Record<string, string>>).map((row) => ({ id: row.id, username: row.username, displayName: row.display_name, role: row.role as TeamRole, status: row.status as Actor['status'], createdAt: row.created_at, identity: bindings.get(row.id) }))
  }

  getProject(projectId: string): Project {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, SqlValue> | undefined
    if (!row) throw new AppError(404, `Project ${projectId} not found`, 'project_not_found')
    return this.mapProject(row)
  }

  /** With an actor, only the projects that actor can see: every project for a platform owner, their memberships otherwise. */
  listProjects(actorId?: string): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY status, created_at, slug').all() as Array<Record<string, SqlValue>>
    const visible = actorId ? new Set(this.visibleProjectIds(actorId)) : undefined
    return rows.map((row) => this.mapProject(row)).filter((project) => !visible || visible.has(project.id))
  }

  listProjectMembers(projectId: string): ProjectMember[] {
    this.getProject(projectId)
    const rows = this.db.prepare('SELECT project_members.*, actors.username, actors.display_name FROM project_members JOIN actors ON actors.id = project_members.actor_id WHERE project_id = ? ORDER BY actors.display_name').all(projectId) as Array<Record<string, SqlValue>>
    return rows.map((row) => ({ projectId: String(row.project_id), actorId: String(row.actor_id), username: String(row.username), displayName: String(row.display_name), role: String(row.role) as ProjectRole, addedByActorId: row.added_by_actor_id ? String(row.added_by_actor_id) : undefined, addedAt: String(row.added_at) }))
  }

  /** The role an active actor holds in a project, or undefined when they hold none there. */
  projectRole(actorId: string, projectId: string): TeamRole | undefined {
    const actor = this.db.prepare('SELECT role, status FROM actors WHERE id = ?').get(actorId) as { role: TeamRole; status: string } | undefined
    if (!actor || actor.status !== 'active') return undefined
    if (actor.role === 'owner') return 'owner'
    return (this.db.prepare('SELECT role FROM project_members WHERE project_id = ? AND actor_id = ?').get(projectId, actorId) as { role: ProjectRole } | undefined)?.role
  }

  visibleProjectIds(actorId: string): string[] {
    const actor = this.db.prepare('SELECT role, status FROM actors WHERE id = ?').get(actorId) as { role: TeamRole; status: string } | undefined
    if (!actor || actor.status !== 'active') return []
    if (actor.role === 'owner') return (this.db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>).map((row) => row.id)
    return (this.db.prepare('SELECT project_id FROM project_members WHERE actor_id = ?').all(actorId) as Array<{ project_id: string }>).map((row) => row.project_id)
  }

  /**
   * The authorization rule for everything inside a project. A non-member learns nothing — not even that the project
   * exists — so the failure is the same 404 an unknown id gives. A member without the role gets the caller's code.
   */
  requireProjectRole(actorId: string, projectId: string, roles: TeamRole[], code: string): TeamRole {
    const actor = this.db.prepare('SELECT status FROM actors WHERE id = ?').get(actorId) as { status: string } | undefined
    if (!actor || actor.status !== 'active') throw new AppError(403, 'Actor is not active', code)
    const role = this.projectRole(actorId, projectId)
    if (!role) throw new AppError(404, `Project ${projectId} not found`, 'project_not_found')
    if (!roles.includes(role)) throw new AppError(403, `Only ${roles.join(' or ')} members of this project may do this`, code)
    return role
  }

  /** Configuring where a project's code lives decides what every later run edits, so only a platform owner does it. */
  createProject(input: { slug: string; name: string; description?: string; members?: Array<{ actorId: string; role: ProjectRole }> } & ProjectHostInput, actorId: string): Project {
    this.assertDecisionActor(actorId, ['owner'], 'project_admin_forbidden')
    const slug = input.slug.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/u.test(slug)) throw new AppError(400, 'slug must be 2–40 lowercase letters, digits or dashes', 'invalid_project_slug')
    const name = input.name.trim()
    if (!name) throw new AppError(400, 'Project name is required', 'invalid_project')
    if (this.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)) throw new AppError(409, `Project slug ${slug} is taken`, 'project_slug_taken')
    const projectId = id('PRJ')
    const host = normalizeProjectHost(input, { dataDirectory: this.dataDirectory, projectId })
    const members = input.members ?? (this.db.prepare("SELECT id, role FROM actors WHERE status = 'active' AND role != 'owner'").all() as Array<{ id: string; role: ProjectRole }>).map((row) => ({ actorId: row.id, role: row.role }))
    for (const member of members) this.assertAssignableMember(member.actorId, member.role)
    const identity = this.decisionIdentity(actorId)
    const timestamp = nowIso()
    return this.inTransaction(() => {
      this.db.prepare("INSERT INTO projects(id, slug, name, description, code_host, code_host_config, repository_path, default_branch, merge_mode, status, created_by_actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)").run(projectId, slug, name, (input.description ?? '').trim(), host.codeHost, JSON.stringify(host.codeHostConfig), host.repositoryPath, host.defaultBranch, host.mergeMode, actorId, timestamp, timestamp)
      this.appendEvent({ aggregateType: 'project', aggregateId: projectId, eventType: 'project.created', actorId, payload: { slug, name, codeHost: host.codeHost, codeHostConfig: host.codeHostConfig, repositoryPath: host.repositoryPath, defaultBranch: host.defaultBranch, mergeMode: host.mergeMode, members, identity } })
      for (const member of members) this.db.prepare('INSERT INTO project_members(project_id, actor_id, role, added_by_actor_id, added_at) VALUES (?, ?, ?, ?, ?)').run(projectId, member.actorId, member.role, actorId, timestamp)
      return this.getProject(projectId)
    })
  }

  /**
   * Moving a project to another repository or host while a proposal is open or a run is active would leave that work
   * pointing at code the project no longer owns, so those changes wait until the project is quiet.
   */
  updateProjectSettings(projectId: string, input: { name?: string; description?: string } & Partial<ProjectHostInput>, actorId: string): Project {
    this.assertDecisionActor(actorId, ['owner'], 'project_admin_forbidden')
    const current = this.getProject(projectId)
    if (current.status === 'archived') throw new AppError(409, 'An archived project cannot be reconfigured', 'project_archived')
    const host = normalizeProjectHost({ codeHost: input.codeHost ?? current.codeHost, repositoryPath: input.repositoryPath === undefined ? current.repositoryPath : input.repositoryPath, codeHostConfig: input.codeHostConfig ?? current.codeHostConfig, defaultBranch: input.defaultBranch ?? current.defaultBranch, mergeMode: input.mergeMode ?? current.mergeMode }, { dataDirectory: this.dataDirectory, projectId })
    const moved = host.codeHost !== current.codeHost || host.repositoryPath !== (current.repositoryPath ?? null) || host.defaultBranch !== current.defaultBranch || JSON.stringify(host.codeHostConfig) !== JSON.stringify(current.codeHostConfig)
    if (moved && this.projectHasOpenWork(projectId)) throw new AppError(409, 'Finish or close the open proposals and runs before moving the project to another repository', 'project_has_open_work')
    const name = input.name === undefined ? current.name : input.name.trim()
    if (!name) throw new AppError(400, 'Project name is required', 'invalid_project')
    const description = input.description === undefined ? current.description : input.description.trim()
    const identity = this.decisionIdentity(actorId)
    return this.inTransaction(() => {
      this.db.prepare('UPDATE projects SET name = ?, description = ?, code_host = ?, code_host_config = ?, repository_path = ?, default_branch = ?, merge_mode = ?, updated_at = ? WHERE id = ?').run(name, description, host.codeHost, JSON.stringify(host.codeHostConfig), host.repositoryPath, host.defaultBranch, host.mergeMode, nowIso(), projectId)
      this.appendEvent({ aggregateType: 'project', aggregateId: projectId, eventType: 'project.configured', actorId, payload: { name, description, codeHost: host.codeHost, codeHostConfig: host.codeHostConfig, repositoryPath: host.repositoryPath, defaultBranch: host.defaultBranch, mergeMode: host.mergeMode, previous: { codeHost: current.codeHost, repositoryPath: current.repositoryPath ?? null, defaultBranch: current.defaultBranch, mergeMode: current.mergeMode }, identity } })
      return this.getProject(projectId)
    })
  }

  archiveProject(projectId: string, actorId: string): Project {
    this.assertDecisionActor(actorId, ['owner'], 'project_admin_forbidden')
    const current = this.getProject(projectId)
    if (current.status === 'archived') return current
    if (projectId === DEFAULT_PROJECT_ID) throw new AppError(409, 'The default project holds the sample data and cannot be archived', 'default_project_fixed')
    if (this.projectHasOpenWork(projectId)) throw new AppError(409, 'Finish or close the open proposals and runs before archiving the project', 'project_has_open_work')
    const identity = this.decisionIdentity(actorId)
    return this.inTransaction(() => {
      this.db.prepare("UPDATE projects SET status = 'archived', updated_at = ? WHERE id = ?").run(nowIso(), projectId)
      this.appendEvent({ aggregateType: 'project', aggregateId: projectId, eventType: 'project.archived', actorId, payload: { identity } })
      return this.getProject(projectId)
    })
  }

  /** Grants or changes a member's project role. Granting capabilities is a decision, so it carries the grantor's identity. */
  setProjectMember(input: { projectId: string; actorId: string; role: ProjectRole }, grantedByActorId: string): ProjectMember {
    this.assertDecisionActor(grantedByActorId, ['owner'], 'project_admin_forbidden')
    this.getProject(input.projectId)
    this.assertAssignableMember(input.actorId, input.role)
    const current = (this.db.prepare('SELECT role FROM project_members WHERE project_id = ? AND actor_id = ?').get(input.projectId, input.actorId) as { role: ProjectRole } | undefined)?.role
    const member = () => this.listProjectMembers(input.projectId).find((item) => item.actorId === input.actorId)!
    if (current === input.role) return member()
    const identity = this.decisionIdentity(grantedByActorId)
    return this.inTransaction(() => {
      if (current) this.db.prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND actor_id = ?').run(input.role, input.projectId, input.actorId)
      else this.db.prepare('INSERT INTO project_members(project_id, actor_id, role, added_by_actor_id, added_at) VALUES (?, ?, ?, ?, ?)').run(input.projectId, input.actorId, input.role, grantedByActorId, nowIso())
      this.appendEvent({ aggregateType: 'project', aggregateId: input.projectId, eventType: current ? 'project.member_role_changed' : 'project.member_added', actorId: grantedByActorId, payload: { actorId: input.actorId, role: input.role, previousRole: current ?? null, identity } })
      return member()
    })
  }

  removeProjectMember(input: { projectId: string; actorId: string }, removedByActorId: string) {
    this.assertDecisionActor(removedByActorId, ['owner'], 'project_admin_forbidden')
    this.getProject(input.projectId)
    const target = this.db.prepare('SELECT role FROM actors WHERE id = ?').get(input.actorId) as { role: TeamRole } | undefined
    if (!target) throw new AppError(404, `Actor ${input.actorId} not found`, 'actor_not_found')
    if (target.role === 'owner') throw new AppError(409, 'Owners are members of every project and cannot be removed', 'owner_is_implicit_member')
    if (input.projectId === DEFAULT_PROJECT_ID) throw new AppError(409, 'Everyone is a member of the default project, which holds the sample data; change the role instead', 'default_project_member_fixed')
    const current = (this.db.prepare('SELECT role FROM project_members WHERE project_id = ? AND actor_id = ?').get(input.projectId, input.actorId) as { role: ProjectRole } | undefined)?.role
    if (!current) throw new AppError(404, 'Actor is not a member of this project', 'project_member_not_found')
    const identity = this.decisionIdentity(removedByActorId)
    this.inTransaction(() => {
      this.db.prepare('DELETE FROM project_members WHERE project_id = ? AND actor_id = ?').run(input.projectId, input.actorId)
      this.appendEvent({ aggregateType: 'project', aggregateId: input.projectId, eventType: 'project.member_removed', actorId: removedByActorId, payload: { actorId: input.actorId, previousRole: current, identity } })
    })
  }

  private assertAssignableMember(actorId: string, role: ProjectRole) {
    if (!PROJECT_ROLES.includes(role)) throw new AppError(400, 'role must be maintainer, reviewer or developer', 'invalid_project_role')
    const target = this.db.prepare('SELECT role, username FROM actors WHERE id = ?').get(actorId) as { role: TeamRole; username: string } | undefined
    if (!target || target.username.startsWith('system:')) throw new AppError(404, `Actor ${actorId} not found`, 'actor_not_found')
    if (target.role === 'owner') throw new AppError(409, 'Owners are members of every project already', 'owner_is_implicit_member')
  }

  private projectHasOpenWork(projectId: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM change_proposals WHERE project_id = ? AND status NOT IN ('merged', 'closed') UNION ALL SELECT 1 FROM agent_runs WHERE project_id = ? AND status IN ('queued', 'running') LIMIT 1").get(projectId, projectId))
  }

  getIdentityBinding(actorId: string): IdentityBinding | undefined {
    const row = this.db.prepare('SELECT * FROM identity_bindings WHERE actor_id = ?').get(actorId) as Record<string, SqlValue> | undefined
    return row ? this.mapIdentityBinding(row) : undefined
  }

  getIdentityMode(): IdentityMode {
    return (this.db.prepare('SELECT mode FROM identity_settings WHERE id = 1').get() as { mode: IdentityMode }).mode
  }

  /**
   * V0.3 §8.3. Leaving Development mode raises the bar for every later decision, and returning to it lowers the bar,
   * so both directions need an owner whose session was proven by the external provider right now — a password
   * session could otherwise downgrade the mode and then approve on its own word.
   */
  setIdentityMode(mode: IdentityMode, actorId: string) {
    if (!['development', 'team'].includes(mode)) throw new AppError(400, 'mode must be development or team', 'invalid_identity_mode')
    this.assertDecisionActor(actorId, ['owner'], 'identity_mode_forbidden')
    const identity = this.decisionIdentity(actorId)
    if (identity.assurance !== 'external') throw new AppError(403, 'Changing the trust mode requires an owner signed in with a verified GitHub identity', 'external_identity_required')
    const previous = this.getIdentityMode()
    if (previous === mode) return mode
    return this.inTransaction(() => {
      this.db.prepare('UPDATE identity_settings SET mode = ?, updated_by_actor_id = ?, updated_at = ? WHERE id = 1').run(mode, actorId, nowIso())
      this.appendEvent({ aggregateType: 'control_plane', aggregateId: 'identity', eventType: 'identity.mode_changed', actorId, payload: { from: previous, to: mode, identity } })
      return mode
    })
  }

  /**
   * The owner says which GitHub login a member is expected to prove. The declaration grants nothing by itself: the
   * binding only counts once GitHub returns that login, and from then on it is pinned to GitHub's numeric id.
   * Re-declaring a verified binding drops the proof, so the member has to sign in with GitHub again.
   */
  declareIdentity(input: { actorId: string; githubLogin: string }, declaredByActorId: string): IdentityBinding {
    this.assertDecisionActor(declaredByActorId, ['owner'], 'identity_declaration_forbidden')
    const identity = this.decisionIdentity(declaredByActorId)
    const target = this.db.prepare('SELECT id FROM actors WHERE id = ?').get(input.actorId) as { id: string } | undefined
    if (!target) throw new AppError(404, `Actor ${input.actorId} not found`, 'actor_not_found')
    const login = input.githubLogin.trim().replace(/^@/u, '')
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u.test(login)) throw new AppError(400, 'githubLogin is not a valid GitHub login', 'invalid_github_login')
    const current = this.getIdentityBinding(input.actorId)
    if (current?.status === 'verified' && current.login?.toLowerCase() === login.toLowerCase()) throw new AppError(409, `Actor is already bound to github:${current.login}`, 'identity_already_verified')
    const taken = this.db.prepare("SELECT actor_id FROM identity_bindings WHERE provider = 'github' AND actor_id != ? AND (lower(expected_login) = lower(?) OR lower(login) = lower(?))").get(input.actorId, login, login) as { actor_id: string } | undefined
    if (taken) throw new AppError(409, `github:${login} is already declared for another actor`, 'identity_login_taken')
    const timestamp = nowIso()
    return this.inTransaction(() => {
      this.db.prepare('DELETE FROM identity_bindings WHERE actor_id = ?').run(input.actorId)
      this.db.prepare("INSERT INTO identity_bindings(actor_id, provider, expected_login, declared_by_actor_id, declared_at) VALUES (?, 'github', ?, ?, ?)").run(input.actorId, login, declaredByActorId, timestamp)
      // Any session this actor proved with the old binding no longer speaks for them.
      this.db.prepare("DELETE FROM sessions WHERE actor_id = ? AND auth_method = 'github'").run(input.actorId)
      this.appendEvent({ aggregateType: 'actor', aggregateId: input.actorId, eventType: 'identity.declared', actorId: declaredByActorId, payload: { provider: 'github', expectedLogin: login, previous: current ? { expectedLogin: current.expectedLogin, login: current.login ?? null, subject: current.subject ?? null } : null, identity } })
      return this.getIdentityBinding(input.actorId)!
    })
  }

  /**
   * Resolves a GitHub identity the OAuth callback has just proven. A known subject signs in (and follows a rename);
   * an unknown subject can only claim a declaration whose expected login matches and has not been proven yet, so a
   * login that is renamed away and re-registered by someone else never inherits the old binding.
   */
  completeGithubLogin(proof: { subject: string; login: string }): SessionActor {
    const bound = this.db.prepare("SELECT * FROM identity_bindings WHERE provider = 'github' AND subject = ?").get(proof.subject) as Record<string, SqlValue> | undefined
    const pending = bound ? undefined : this.db.prepare("SELECT * FROM identity_bindings WHERE provider = 'github' AND subject IS NULL AND lower(expected_login) = lower(?)").get(proof.login) as Record<string, SqlValue> | undefined
    const row = bound ?? pending
    if (!row) throw new AppError(403, `github:${proof.login} is not bound to any member; ask an owner to declare it first`, 'identity_not_bound')
    const actorId = String(row.actor_id)
    const actor = this.db.prepare('SELECT id, username, display_name, role, status FROM actors WHERE id = ?').get(actorId) as Record<string, string>
    if (actor.status !== 'active') throw new AppError(403, 'This member is disabled', 'actor_disabled')
    const timestamp = nowIso()
    this.inTransaction(() => {
      if (pending) {
        this.db.prepare('UPDATE identity_bindings SET subject = ?, login = ?, verified_at = ? WHERE actor_id = ?').run(proof.subject, proof.login, timestamp, actorId)
        this.appendEvent({ aggregateType: 'actor', aggregateId: actorId, eventType: 'identity.verified', actorId, payload: { provider: 'github', subject: proof.subject, login: proof.login, expectedLogin: String(row.expected_login) } })
      } else if (String(row.login) !== proof.login) {
        this.db.prepare('UPDATE identity_bindings SET login = ? WHERE actor_id = ?').run(proof.login, actorId)
        this.appendEvent({ aggregateType: 'actor', aggregateId: actorId, eventType: 'identity.login_changed', actorId, payload: { provider: 'github', subject: proof.subject, from: String(row.login), to: proof.login } })
      }
    })
    return { id: actor.id, username: actor.username, displayName: actor.display_name, role: actor.role as TeamRole, authMethod: 'github' }
  }

  createOAuthState(state: string, codeVerifier: string, lifetimeSeconds = 600) {
    const timestamp = nowIso()
    this.db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(timestamp)
    this.db.prepare("INSERT INTO oauth_states(state_hash, provider, code_verifier, created_at, expires_at) VALUES (?, 'github', ?, ?, ?)").run(hashSessionToken(state), codeVerifier, timestamp, new Date(Date.now() + lifetimeSeconds * 1000).toISOString())
  }

  /** Single use: the state is burned before the code is exchanged, so a replayed callback fails even if the exchange did. */
  consumeOAuthState(state: string) {
    if (!state) throw new AppError(400, 'OAuth state is missing', 'invalid_oauth_state')
    const stateHash = hashSessionToken(state)
    const row = this.db.prepare('SELECT code_verifier FROM oauth_states WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?').get(stateHash, nowIso()) as { code_verifier: string } | undefined
    if (!row) throw new AppError(400, 'OAuth state is unknown, expired or already used', 'invalid_oauth_state')
    this.db.prepare('UPDATE oauth_states SET consumed_at = ? WHERE state_hash = ?').run(nowIso(), stateHash)
    return row.code_verifier
  }

  /**
   * DOMAIN_MODEL.md invariant 10 and V0.4: the identity a decision was made under is frozen into its event. It is
   * external only when the actor has a verified binding and this request's session was proven by GitHub; anything
   * else is recorded as self-asserted. In Team mode a self-asserted identity cannot decide at all.
   */
  decisionIdentity(actorId: string): DecisionIdentity {
    const authMethod: AuthMethod | 'internal' = requestContext.getStore()?.authMethod ?? 'internal'
    const row = this.db.prepare('SELECT a.username, b.subject, b.login FROM actors a LEFT JOIN identity_bindings b ON b.actor_id = a.id WHERE a.id = ?').get(actorId) as { username: string; subject: string | null; login: string | null } | undefined
    if (!row) throw new AppError(404, `Actor ${actorId} not found`, 'actor_not_found')
    if (row.subject && row.login && authMethod === 'github') return { provider: 'github', subject: row.subject, login: row.login, assurance: 'external', authMethod }
    if (this.getIdentityMode() === 'team') throw new AppError(403, row.subject ? 'Team mode: decisions require a session signed in with GitHub' : 'Team mode: bind a GitHub identity before making decisions', 'external_identity_required')
    return { provider: 'local', subject: actorId, login: row.username, assurance: 'self_asserted', authMethod }
  }

  authenticate(username: string, password: string) {
    const row = this.db.prepare('SELECT a.id, a.username, a.display_name, a.role, a.status, c.password_hash FROM actors a JOIN local_credentials c ON c.actor_id = a.id WHERE a.username = ?').get(username.trim()) as Record<string, string> | undefined
    if (!row || row.status !== 'active' || !verifyPassword(password, row.password_hash)) throw new AppError(401, 'Invalid username or password', 'invalid_credentials')
    return { id: row.id, username: row.username, displayName: row.display_name, role: row.role as TeamRole, authMethod: 'password' } satisfies SessionActor
  }

  createSession(actorId: string, lifetimeSeconds = 8 * 60 * 60, authMethod: AuthMethod = 'password') {
    const token = createSessionToken()
    const timestamp = nowIso()
    const expiresAt = new Date(Date.now() + lifetimeSeconds * 1000).toISOString()
    this.db.prepare('INSERT INTO sessions(token_hash, actor_id, expires_at, created_at, last_seen_at, auth_method) VALUES (?, ?, ?, ?, ?, ?)').run(hashSessionToken(token), actorId, expiresAt, timestamp, timestamp, authMethod)
    return { token, expiresAt }
  }

  getSession(token: string): SessionActor | null {
    if (!token) return null
    const tokenHash = hashSessionToken(token)
    const row = this.db.prepare('SELECT a.id, a.username, a.display_name, a.role, a.status, s.expires_at, s.auth_method FROM sessions s JOIN actors a ON a.id = s.actor_id WHERE s.token_hash = ?').get(tokenHash) as Record<string, string> | undefined
    if (!row || row.status !== 'active' || row.expires_at <= nowIso()) {
      if (row) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
      return null
    }
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(nowIso(), tokenHash)
    return { id: row.id, username: row.username, displayName: row.display_name, role: row.role as TeamRole, authMethod: row.auth_method as AuthMethod }
  }

  revokeSession(token: string) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashSessionToken(token))
  }

  createWorkItem(input: { title: string; description: string; ownerActorId: string; productType?: WorkItem['productType']; projectId?: string }, actorId: string) {
    const projectId = input.projectId ?? DEFAULT_PROJECT_ID
    this.requireProjectRole(actorId, projectId, ALL_ROLES, 'work_item_forbidden')
    if (this.getProject(projectId).status === 'archived') throw new AppError(409, 'The project is archived', 'project_archived')
    const timestamp = nowIso()
    const workItemId = id('WI')
    const workItem: WorkItem = { id: workItemId, projectId, sequence: 0, title: input.title.trim(), description: input.description.trim(), productType: input.productType ?? 'application', status: 'draft', ownerActorId: input.ownerActorId, authorityProvider: 'local-authority@0.1', authorityRef: `local://work-items/${workItemId}`, createdAt: timestamp, updatedAt: timestamp }
    if (!workItem.title) throw new AppError(400, 'Work item title is required', 'invalid_work_item')
    return this.inTransaction(() => {
      workItem.sequence = Number((this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM work_items WHERE project_id = ?').get(projectId) as { next: number }).next)
      this.db.prepare('INSERT INTO work_items(id, project_id, sequence, title, description, product_type, status, owner_actor_id, authority_provider, authority_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(workItem.id, projectId, workItem.sequence, workItem.title, workItem.description, workItem.productType, workItem.status, workItem.ownerActorId, workItem.authorityProvider, workItem.authorityRef, timestamp, timestamp)
      this.appendEvent({ aggregateType: 'work_item', aggregateId: workItem.id, eventType: 'work_item.created', actorId, payload: { sequence: workItem.sequence, title: workItem.title, productType: workItem.productType, ownerActorId: workItem.ownerActorId, authorityRef: workItem.authorityRef } })
      return workItem
    })
  }

  listWorkItems(projectIds?: string[]): WorkItem[] {
    const filter = projectClause('project_id', projectIds)
    return (this.db.prepare(`SELECT * FROM work_items ${filter.sql} ORDER BY updated_at DESC`).all(...filter.params) as Array<Record<string, SqlValue>>).map((row) => this.mapWorkItem(row))
  }

  getWorkItem(workItemId: string) {
    const row = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(workItemId) as Record<string, SqlValue> | undefined
    if (!row) throw new AppError(404, `Work item ${workItemId} not found`, 'work_item_not_found')
    return this.mapWorkItem(row)
  }

  createIntentVersion(input: { workItemId: string; goal: string; constraints: string[]; riskLevel: IntentVersion['riskLevel']; acceptanceCriteria: AcceptanceCriterionInput[] }, actorId: string) {
    this.requireProjectRole(actorId, this.getWorkItem(input.workItemId).projectId, ALL_ROLES, 'intent_forbidden')
    if (!input.goal.trim() || !input.acceptanceCriteria.length) throw new AppError(400, 'Intent goal and acceptance criteria are required', 'invalid_intent')
    // 这两项校验放在 database 层而不是 HTTP 层：smoke 脚本与 real-case 都直接调用这个方法，只在 HTTP 边界
    // 校验会留下一个绕过口。criticality 与 verificationType 会进入 contentDigest 与 Evidence Package，
    // 所以一个拼错的枚举值不能被静默存下来。
    for (const criterion of input.acceptanceCriteria) {
      if (!criterion.statement.trim()) throw new AppError(400, 'Acceptance criterion statement is required', 'invalid_acceptance_criteria')
      // 与 src/intent-templates.ts 的 maximumStatementLength 同值：整条语句进入 Agent prompt，长度不能由调用方任意决定。
      if (criterion.statement.length > 300) throw new AppError(400, `Acceptance criterion statement exceeds 300 characters (${criterion.statement.length})`, 'invalid_acceptance_criteria')
      if (!['normal', 'critical'].includes(criterion.criticality)) throw new AppError(400, `Unknown acceptance criterion criticality ${criterion.criticality}`, 'invalid_acceptance_criteria')
      if (!['deterministic', 'model', 'human'].includes(criterion.verificationType)) throw new AppError(400, `Unknown acceptance criterion verification type ${criterion.verificationType}`, 'invalid_acceptance_criteria')
      if (criterion.verifiedBy !== undefined) {
        // A human criterion is proved by the approval, not by a check, so naming checks for it would be a second,
        // contradictory answer to "who verifies this". `@baseline` re-runs follow their check and are not named.
        if (criterion.verificationType === 'human') throw new AppError(400, 'A human-verified criterion is signed off in the approval; it cannot name checks', 'invalid_acceptance_criteria')
        if (!Array.isArray(criterion.verifiedBy) || criterion.verifiedBy.length > 8 || criterion.verifiedBy.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name))) throw new AppError(400, 'verifiedBy must list up to 8 check names from the project manifest (letters, digits, . _ -)', 'invalid_acceptance_criteria')
      }
      // 关键的人工标准由批准人签署，签的就是这句话；「ok」「人工审核」这类占位语句让签署变成空签。
      if (criterion.verificationType === 'human' && criterion.criticality === 'critical' && !isSubstantiveHumanCriterion(criterion.statement)) {
        throw new AppError(400, `A critical human-verified criterion must say what the approver judges; "${criterion.statement.trim()}" is a placeholder`, 'human_criterion_not_substantive')
      }
    }
    // Only the declared fields enter the digest and the table, in a fixed order, so extra keys a caller sends cannot
    // change the digest and an Intent without verifiedBy hashes exactly as it did before verifiedBy existed.
    const acceptanceCriteria: AcceptanceCriterionInput[] = input.acceptanceCriteria.map((criterion) => ({ statement: criterion.statement, criticality: criterion.criticality, verificationType: criterion.verificationType, ...(criterion.verifiedBy?.length ? { verifiedBy: [...new Set(criterion.verifiedBy)] } : {}) }))
    // DOMAIN_MODEL.md 的 Intent 不变量：高风险 Intent 必须定义人工审批要求。在当前模型里，承载这条要求的
    // 就是一条 verificationType 为 human 的验收标准——否则整个 Intent 声称自己可以全自动证明完毕。它必须是
    // critical：用一条自己声明「不阻塞合并」的 normal 标准来满足「必须有人工审批」是自相矛盾的。
    //
    // 签署发生在批准时：recordReview 要求批准意见逐条点名每一条关键人工标准（AC-n）。
    if (input.riskLevel === 'high' && !input.acceptanceCriteria.some((criterion) => criterion.verificationType === 'human' && criterion.criticality === 'critical')) {
      throw new AppError(400, 'A high risk intent requires at least one critical human-verified acceptance criterion', 'high_risk_requires_human_verification')
    }
    // 非低风险必须至少有一条 critical 标准。全部降级为 normal 的 Intent 会在审批门禁开始读取 criticality 的
    // 那天静默绕过它，所以在写入时就拒绝，而不是指望日后回头审计。
    if (input.riskLevel !== 'low' && !input.acceptanceCriteria.some((criterion) => criterion.criticality === 'critical')) {
      throw new AppError(400, 'A medium or high risk intent requires at least one critical acceptance criterion', 'intent_requires_critical_criterion')
    }
    return this.inTransaction(() => {
      const version = Number((this.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM intent_versions WHERE work_item_id = ?').get(input.workItemId) as { version: number }).version)
      const intentId = `${input.workItemId}:v${version}`
      const timestamp = nowIso()
      const canonical = { workItemId: input.workItemId, version, goal: input.goal.trim(), constraints: input.constraints, riskLevel: input.riskLevel, acceptanceCriteria }
      // V0.3 §10.1: a low risk Intent becomes Ready through the lightweight rule; anything riskier waits for a named approver.
      const lowRisk = input.riskLevel === 'low'
      const intent: IntentVersion = { id: intentId, ...canonical, contentDigest: `sha256:${sha256(JSON.stringify(canonical))}`, createdBy: actorId, createdAt: timestamp, acceptanceCriteria: acceptanceCriteria.map((criterion, index) => ({ ...criterion, id: `${intentId}:AC-${index + 1}`, ordinal: index + 1 })), status: lowRisk ? 'approved' : 'draft', ...(lowRisk ? { approval: { basis: 'low_risk_rule' as const, approvedAt: timestamp } } : {}) }
      const superseded = this.db.prepare("UPDATE intent_versions SET status = 'superseded' WHERE work_item_id = ? AND status != 'superseded'").run(input.workItemId)
      this.db.prepare('INSERT INTO intent_versions(id, work_item_id, version, goal, constraints_json, risk_level, content_digest, created_by, created_at, status, approved_at, approval_basis) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(intent.id, intent.workItemId, intent.version, intent.goal, JSON.stringify(intent.constraints), intent.riskLevel, intent.contentDigest, actorId, timestamp, intent.status, lowRisk ? timestamp : null, lowRisk ? 'low_risk_rule' : null)
      const insertCriterion = this.db.prepare('INSERT INTO acceptance_criteria(id, intent_version_id, statement, criticality, verification_type, ordinal, verified_by_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      intent.acceptanceCriteria.forEach((criterion) => insertCriterion.run(criterion.id, intent.id, criterion.statement, criterion.criticality, criterion.verificationType, criterion.ordinal, criterion.verifiedBy ? JSON.stringify(criterion.verifiedBy) : null))
      this.db.prepare("UPDATE work_items SET status = 'ready', updated_at = ? WHERE id = ?").run(timestamp, input.workItemId)
      this.appendEvent({ aggregateType: 'work_item', aggregateId: input.workItemId, eventType: 'intent.versioned', actorId, payload: { intentVersionId: intent.id, version, contentDigest: intent.contentDigest, acceptanceCriterionCount: intent.acceptanceCriteria.length, supersededCount: Number(superseded.changes) } })
      if (lowRisk) this.appendEvent({ aggregateType: 'work_item', aggregateId: input.workItemId, eventType: 'intent.approved', actorId, payload: { intentVersionId: intent.id, contentDigest: intent.contentDigest, basis: 'low_risk_rule' } })
      return intent
    })
  }

  /**
   * DOMAIN_MODEL.md §6.1 / §6.4: a medium or high risk Intent is approved by a named Actor, bound to the exact content
   * digest they read. The author cannot approve their own Intent, for the same reason they cannot approve their own
   * change: the approval is the second pair of eyes on whether the requirement is clear enough to build.
   */
  approveIntentVersion(intentVersionId: string, actorId: string, comment = '') {
    const intent = this.getIntentVersion(intentVersionId)
    this.assertDecisionActor(actorId, ['owner', 'maintainer', 'reviewer'], 'intent_approval_forbidden', this.getWorkItem(intent.workItemId).projectId)
    if (intent.createdBy === actorId) throw new AppError(403, 'The author of an Intent cannot approve it', 'self_intent_approval_forbidden')
    if (intent.status === 'superseded') throw new AppError(409, 'A newer Intent version exists; approve that one instead', 'intent_superseded')
    if (intent.status === 'approved') throw new AppError(409, 'Intent version is already approved', 'intent_already_approved')
    const identity = this.decisionIdentity(actorId)
    return this.inTransaction(() => {
      const timestamp = nowIso()
      this.db.prepare("UPDATE intent_versions SET status = 'approved', approved_by = ?, approved_at = ?, approval_basis = 'named_approval', approval_comment = ? WHERE id = ? AND status = 'draft'").run(actorId, timestamp, comment.trim() || null, intentVersionId)
      this.appendEvent({ aggregateType: 'work_item', aggregateId: intent.workItemId, eventType: 'intent.approved', actorId, payload: { intentVersionId, contentDigest: intent.contentDigest, basis: 'named_approval', riskLevel: intent.riskLevel, comment: comment.trim(), identity } })
      return this.getIntentVersion(intentVersionId)
    })
  }

  /** The single admission rule for Runs, shared by the runner (before it creates a worktree) and createAgentRun. */
  assertIntentRunnable(intent: IntentVersion) {
    if (intent.status === 'superseded') throw new AppError(409, `Intent ${intent.id} has been superseded by a newer version`, 'intent_superseded')
    if (intent.status !== 'approved') throw new AppError(409, `Intent ${intent.id} is ${intent.riskLevel} risk and has not been approved yet`, 'intent_not_approved')
  }

  listIntentVersions(workItemId: string): IntentVersion[] {
    const rows = this.db.prepare('SELECT * FROM intent_versions WHERE work_item_id = ? ORDER BY version DESC').all(workItemId) as Array<Record<string, SqlValue>>
    return rows.map((row) => {
      const criteria = this.db.prepare('SELECT * FROM acceptance_criteria WHERE intent_version_id = ? ORDER BY ordinal').all(String(row.id)) as Array<Record<string, SqlValue>>
      return { id: String(row.id), workItemId: String(row.work_item_id), version: Number(row.version), goal: String(row.goal), constraints: parseJson<string[]>(String(row.constraints_json)), riskLevel: String(row.risk_level) as IntentVersion['riskLevel'], contentDigest: String(row.content_digest), createdBy: String(row.created_by), createdAt: String(row.created_at), status: String(row.status) as IntentVersion['status'], ...(row.approved_at ? { approval: { basis: String(row.approval_basis) as NonNullable<IntentVersion['approval']>['basis'], ...(row.approved_by ? { actorId: String(row.approved_by) } : {}), approvedAt: String(row.approved_at), ...(row.approval_comment ? { comment: String(row.approval_comment) } : {}) } } : {}), acceptanceCriteria: criteria.map((criterion) => ({ id: String(criterion.id), statement: String(criterion.statement), criticality: String(criterion.criticality) as AcceptanceCriterionInput['criticality'], verificationType: String(criterion.verification_type) as AcceptanceCriterionInput['verificationType'], ...(criterion.verified_by_json ? { verifiedBy: parseJson<string[]>(String(criterion.verified_by_json)) } : {}), ordinal: Number(criterion.ordinal) })) }
    })
  }

  getIntentVersion(intentVersionId: string) {
    const row = this.db.prepare('SELECT work_item_id FROM intent_versions WHERE id = ?').get(intentVersionId) as { work_item_id: string } | undefined
    if (!row) throw new AppError(404, `Intent version ${intentVersionId} not found`, 'intent_version_not_found')
    const intent = this.listIntentVersions(row.work_item_id).find((item) => item.id === intentVersionId)
    if (!intent) throw new AppError(404, `Intent version ${intentVersionId} not found`, 'intent_version_not_found')
    return intent
  }

  createAgentRun(input: Omit<AgentRun, 'projectId' | 'status' | 'startedAt' | 'completedAt' | 'changeProposalId' | 'exitCode' | 'stdoutDigest' | 'stderrDigest' | 'errorMessage'> & { status?: 'queued' | 'running' }) {
    const workItem = this.getWorkItem(input.workItemId)
    const intent = this.getIntentVersion(input.intentVersionId)
    if (intent.workItemId !== workItem.id) throw new AppError(400, 'Intent version does not belong to the work item', 'intent_work_item_mismatch')
    this.assertIntentRunnable(intent)
    if (this.getProject(workItem.projectId).status === 'archived') throw new AppError(409, 'The project is archived', 'project_archived')
    const startedAt = nowIso()
    const run: AgentRun = { ...input, projectId: workItem.projectId, status: input.status ?? 'running', startedAt }
    return this.inTransaction(() => {
      this.db.prepare('INSERT INTO agent_runs(id, project_id, work_item_id, intent_version_id, repository_path, base_ref, base_sha, start_sha, revision_of_proposal_id, branch_ref, worktree_path, adapter_id, isolation, runtime_image_ref, runtime_attestation_digest, network_egress, production_eligible, status, started_by_actor_id, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(run.id, run.projectId, run.workItemId, run.intentVersionId, run.repositoryPath, run.baseRef, run.baseSha, run.startSha, run.revisionOfProposalId ?? null, run.branchRef, run.worktreePath, run.adapterId, run.isolation, run.runtimeImageRef ?? null, run.runtimeAttestationDigest ?? null, run.networkEgress, run.productionEligible ? 1 : 0, run.status, run.startedByActorId, run.startedAt)
      if (run.status === 'queued') this.db.prepare('UPDATE agent_runs SET queued_at = ? WHERE id = ?').run(startedAt, run.id)
      this.appendEvent({ aggregateType: 'agent_run', aggregateId: run.id, eventType: run.status === 'queued' ? 'agent_run.queued' : 'agent_run.started', actorId: run.startedByActorId, payload: { workItemId: run.workItemId, intentVersionId: run.intentVersionId, repositoryPath: run.repositoryPath, baseRef: run.baseRef, baseSha: run.baseSha, startSha: run.startSha, revisionOfProposalId: run.revisionOfProposalId ?? null, branchRef: run.branchRef, worktreePath: run.worktreePath, adapterId: run.adapterId, isolation: run.isolation, runtimeImageRef: run.runtimeImageRef ?? null, runtimeAttestationDigest: run.runtimeAttestationDigest ?? null, networkEgress: run.networkEgress, productionEligible: run.productionEligible } })
      return run
    })
  }

  recordAgentRunEvent(runId: string, eventType: string, payload: Record<string, unknown>, actorId?: string) {
    this.getAgentRun(runId)
    return this.appendEvent({ aggregateType: 'agent_run', aggregateId: runId, eventType, actorId, payload })
  }

  /** Records the Builder Context decided at admission time so the worker process can honour it. */
  saveAgentRunPlan(input: { runId: string; declaredContextPaths: string[]; requestPath: string; timeoutMs: number }) {
    this.db.prepare('INSERT INTO agent_run_plans(agent_run_id, declared_context_paths, request_path, timeout_ms, created_at) VALUES (?, ?, ?, ?, ?)').run(input.runId, JSON.stringify(input.declaredContextPaths), input.requestPath, input.timeoutMs, nowIso())
  }

  getAgentRunPlan(runId: string) {
    const row = this.db.prepare('SELECT * FROM agent_run_plans WHERE agent_run_id = ?').get(runId) as Record<string, SqlValue> | undefined
    if (!row) throw new AppError(404, `Agent run ${runId} has no execution plan`, 'agent_run_plan_not_found')
    return { declaredContextPaths: parseJson<string[]>(String(row.declared_context_paths)), requestPath: String(row.request_path), timeoutMs: Number(row.timeout_ms) }
  }

  /**
   * The Builder Context declared at admission, or an empty list when the run never got a plan. Read-only view
   * for reconciling declarations against what the run actually reported reading.
   */
  getDeclaredContextPaths(runId: string) {
    const row = this.db.prepare('SELECT declared_context_paths FROM agent_run_plans WHERE agent_run_id = ?').get(runId) as Record<string, SqlValue> | undefined
    return row ? parseJson<string[]>(String(row.declared_context_paths)) : []
  }

  /**
   * The LLM provider the Builder Agent must use, including the secret. Only the agent runner factory
   * should call this; everything that crosses the API boundary goes through `getAgentProviderView`.
   */
  getAgentProviderSettings(): AgentProviderSettings | undefined {
    const row = this.db.prepare('SELECT * FROM agent_provider_settings WHERE id = ?').get('current') as Record<string, SqlValue> | undefined
    if (!row) return undefined
    return {
      providerId: String(row.provider_id),
      model: String(row.model),
      baseUrl: String(row.base_url),
      wireApi: String(row.wire_api) as AgentProviderSettings['wireApi'],
      apiKey: row.api_key === null ? undefined : String(row.api_key),
      apiKeyEnv: row.api_key_env === null ? undefined : String(row.api_key_env),
      reasoningEffort: row.reasoning_effort === null ? undefined : String(row.reasoning_effort) as AgentProviderSettings['reasoningEffort'],
      updatedByActorId: String(row.updated_by_actor_id),
      updatedAt: String(row.updated_at),
    }
  }

  /** The same settings with the API key reduced to whether one is stored, safe to send to a browser. */
  getAgentProviderView(): AgentProviderSettingsView | undefined {
    const settings = this.getAgentProviderSettings()
    if (!settings) return undefined
    const { apiKey, ...rest } = settings
    return { ...rest, apiKeySet: Boolean(apiKey) }
  }

  /**
   * Replaces the current provider. `apiKey: undefined` keeps the stored key so the operator can edit the
   * model or base URL without retyping the secret; an empty string clears it. The event records what
   * changed but never the secret itself — only whether one is now held.
   */
  saveAgentProviderSettings(input: { providerId: string; model: string; baseUrl: string; wireApi: AgentProviderSettings['wireApi']; apiKey?: string; apiKeyEnv?: string; reasoningEffort?: AgentProviderSettings['reasoningEffort'] }, actorId: string) {
    // The provider decides which model authors every change, so configuring it is a decision too.
    const identity = this.decisionIdentity(actorId)
    return this.inTransaction(() => {
      const previous = this.getAgentProviderSettings()
      const apiKey = input.apiKey === undefined ? previous?.apiKey ?? null : (input.apiKey.trim() || null)
      const timestamp = nowIso()
      this.db.prepare('INSERT INTO agent_provider_settings(id, provider_id, model, base_url, wire_api, api_key, api_key_env, reasoning_effort, updated_by_actor_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model, base_url = excluded.base_url, wire_api = excluded.wire_api, api_key = excluded.api_key, api_key_env = excluded.api_key_env, reasoning_effort = excluded.reasoning_effort, updated_by_actor_id = excluded.updated_by_actor_id, updated_at = excluded.updated_at')
        .run('current', input.providerId.trim(), input.model.trim(), input.baseUrl.trim(), input.wireApi, apiKey, input.apiKeyEnv?.trim() || null, input.reasoningEffort ?? null, actorId, timestamp)
      this.appendEvent({ aggregateType: 'agent_provider', aggregateId: 'current', eventType: 'agent_provider.configured', actorId, payload: { providerId: input.providerId.trim(), model: input.model.trim(), baseUrl: input.baseUrl.trim(), wireApi: input.wireApi, reasoningEffort: input.reasoningEffort ?? null, apiKeyHeld: Boolean(apiKey), apiKeyEnv: input.apiKeyEnv?.trim() || null, previousModel: previous?.model ?? null, previousProviderId: previous?.providerId ?? null, identity } })
      return this.getAgentProviderView()!
    })
  }

  /** Claims a queued run for a worker. Returns false when the run was cancelled before it started. */
  claimAgentRun(runId: string, workerPid: number, actorId: string) {
    return this.inTransaction(() => {
      const current = this.getAgentRun(runId)
      if (current.status !== 'queued') throw new AppError(409, `Agent run ${runId} is not queued`, 'agent_run_not_queued')
      if (this.isAgentRunCancellationRequested(runId)) return false
      this.db.prepare('UPDATE agent_runs SET status = ?, worker_pid = ?, started_at = ? WHERE id = ?').run('running', workerPid, nowIso(), runId)
      this.appendEvent({ aggregateType: 'agent_run', aggregateId: runId, eventType: 'agent_run.started', actorId, payload: { workerPid, queuedAt: this.getAgentRunQueuedAt(runId) } })
      return true
    })
  }

  isAgentRunCancellationRequested(runId: string) {
    return Boolean((this.db.prepare('SELECT cancellation_requested_at FROM agent_runs WHERE id = ?').get(runId) as { cancellation_requested_at: string | null } | undefined)?.cancellation_requested_at)
  }

  getAgentRunQueuedAt(runId: string) {
    return (this.db.prepare('SELECT queued_at FROM agent_runs WHERE id = ?').get(runId) as { queued_at: string | null } | undefined)?.queued_at ?? null
  }

  getAgentRunWorkerPid(runId: string) {
    const pid = (this.db.prepare('SELECT worker_pid FROM agent_runs WHERE id = ?').get(runId) as { worker_pid: number | null } | undefined)?.worker_pid
    return pid ? Number(pid) : undefined
  }

  /** Marks a run for cancellation. The worker or the queue turns this into a terminal state. */
  requestAgentRunCancellation(runId: string, actorId: string) {
    return this.inTransaction(() => {
      const current = this.getAgentRun(runId)
      if (current.status !== 'queued' && current.status !== 'running') throw new AppError(409, `Agent run ${runId} is already terminal`, 'agent_run_terminal')
      if (!this.isAgentRunCancellationRequested(runId)) {
        this.db.prepare('UPDATE agent_runs SET cancellation_requested_at = ?, cancellation_requested_by = ? WHERE id = ?').run(nowIso(), actorId, runId)
        this.appendEvent({ aggregateType: 'agent_run', aggregateId: runId, eventType: 'agent_run.cancellation_requested', actorId, payload: { previousStatus: current.status, workerPid: this.getAgentRunWorkerPid(runId) ?? null } })
      }
      return this.getAgentRun(runId)
    })
  }

  listUnfinishedAgentRuns(): AgentRun[] {
    return (this.db.prepare("SELECT * FROM agent_runs WHERE status IN ('queued', 'running') ORDER BY started_at ASC").all() as Array<Record<string, SqlValue>>).map((row) => this.mapAgentRun(row))
  }

  /**
   * Finished runs whose worktree has not been reported as pruned yet. A run's `agent_run.worktree_pruned`
   * event with `pruned: true` is the only thing that takes it off this list, so a cleanup that failed (or a
   * run that ended before the cleanup existed) is retried on the next Control Plane start instead of leaking
   * the checkout forever.
   */
  listTerminalAgentRunsWithWorktree(): AgentRun[] {
    const rows = this.db.prepare(`
      SELECT run.* FROM agent_runs run
      WHERE run.status IN ('succeeded', 'failed', 'cancelled')
        AND NOT EXISTS (
          SELECT 1 FROM domain_events event
          WHERE event.aggregate_type = 'agent_run' AND event.aggregate_id = run.id
            AND event.event_type = 'agent_run.worktree_pruned'
            AND json_extract(event.payload_json, '$.pruned') = 1
        )
      ORDER BY run.started_at ASC
    `).all() as Array<Record<string, SqlValue>>
    return rows.map((row) => this.mapAgentRun(row))
  }

  completeAgentRun(input: { runId: string; status: 'succeeded' | 'failed' | 'cancelled'; actorId: string; changeProposalId?: string; exitCode?: number; stdoutDigest?: string; stderrDigest?: string; errorMessage?: string }) {
    const current = this.getAgentRun(input.runId)
    if (current.status !== 'running' && current.status !== 'queued') throw new AppError(409, `Agent run ${input.runId} is already terminal`, 'agent_run_terminal')
    const completedAt = nowIso()
    return this.inTransaction(() => {
      this.db.prepare('UPDATE agent_runs SET status = ?, change_proposal_id = ?, exit_code = ?, stdout_digest = ?, stderr_digest = ?, error_message = ?, completed_at = ? WHERE id = ?').run(input.status, input.changeProposalId ?? null, input.exitCode ?? null, input.stdoutDigest ?? null, input.stderrDigest ?? null, input.errorMessage ?? null, completedAt, input.runId)
      this.appendEvent({ aggregateType: 'agent_run', aggregateId: input.runId, eventType: `agent_run.${input.status}`, actorId: input.actorId, payload: { changeProposalId: input.changeProposalId ?? null, exitCode: input.exitCode ?? null, stdoutDigest: input.stdoutDigest ?? null, stderrDigest: input.stderrDigest ?? null, errorMessage: input.errorMessage ?? null } })
      return this.getAgentRun(input.runId)
    })
  }

  listAgentRuns(projectIds?: string[]): AgentRun[] {
    const filter = projectClause('project_id', projectIds)
    return (this.db.prepare(`SELECT * FROM agent_runs ${filter.sql} ORDER BY started_at DESC`).all(...filter.params) as Array<Record<string, SqlValue>>).map((row) => this.mapAgentRun(row))
  }

  getAgentRun(runId: string) {
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) as Record<string, SqlValue> | undefined
    if (!row) throw new AppError(404, `Agent run ${runId} not found`, 'agent_run_not_found')
    return this.mapAgentRun(row)
  }

  insertChangeProposal(input: Omit<ChangeProposal, 'id' | 'projectId' | 'createdAt' | 'updatedAt' | 'status' | 'reviewCycleStartedAt'>, actorId: string) {
    const timestamp = nowIso()
    const proposal: ChangeProposal = { ...input, id: id('CP'), projectId: this.getWorkItem(input.workItemId).projectId, status: 'review_ready', reviewCycleStartedAt: timestamp, createdAt: timestamp, updatedAt: timestamp }
    return this.inTransaction(() => {
      this.db.prepare('INSERT INTO change_proposals(id, project_id, work_item_id, intent_version_id, run_id, repository_path, base_ref, base_sha, head_ref, head_sha, author_actor_id, status, changed_files, additions, deletions, policy_files_json, review_cycle_started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(proposal.id, proposal.projectId, proposal.workItemId, proposal.intentVersionId, proposal.runId ?? null, proposal.repositoryPath, proposal.baseRef, proposal.baseSha, proposal.headRef, proposal.headSha, proposal.authorActorId, proposal.status, proposal.changedFiles, proposal.additions, proposal.deletions, proposal.policyFiles ? JSON.stringify(proposal.policyFiles) : null, proposal.reviewCycleStartedAt, timestamp, timestamp)
      this.db.prepare("UPDATE work_items SET status = 'review', updated_at = ? WHERE id = ?").run(timestamp, proposal.workItemId)
      this.appendEvent({ aggregateType: 'change_proposal', aggregateId: proposal.id, eventType: 'change_proposal.created', actorId, payload: { workItemId: proposal.workItemId, intentVersionId: proposal.intentVersionId, baseSha: proposal.baseSha, headSha: proposal.headSha, authorActorId: proposal.authorActorId, policyFiles: proposal.policyFiles ?? null } })
      return proposal
    })
  }

  getChangeProposal(proposalId: string) {
    const row = this.db.prepare('SELECT * FROM change_proposals WHERE id = ?').get(proposalId) as Record<string, SqlValue> | undefined
    if (!row) throw new AppError(404, `Change proposal ${proposalId} not found`, 'change_proposal_not_found')
    return this.mapChangeProposal(row)
  }

  listChangeProposals(projectIds?: string[]): ChangeProposal[] {
    const filter = projectClause('project_id', projectIds)
    return (this.db.prepare(`SELECT * FROM change_proposals ${filter.sql} ORDER BY updated_at DESC`).all(...filter.params) as Array<Record<string, SqlValue>>).map((row) => this.mapChangeProposal(row))
  }

  getMergeEvidence(proposalId: string) {
    const row = this.db.prepare('SELECT * FROM merge_evidence WHERE change_proposal_id = ?').get(proposalId) as Record<string, SqlValue> | undefined
    if (!row) throw new AppError(404, `Merge evidence for ${proposalId} not found`, 'merge_evidence_not_found')
    return this.verifyMergeEvidence(this.mapMergeEvidence(row))
  }

  getMergeEvidenceOptional(proposalId: string) {
    const row = this.db.prepare('SELECT * FROM merge_evidence WHERE change_proposal_id = ?').get(proposalId) as Record<string, SqlValue> | undefined
    return row ? this.verifyMergeEvidence(this.mapMergeEvidence(row)) : undefined
  }

  recordMergeEvidence(input: { proposalId: string; baseRef: string; baseShaBefore: string; approvedHeadSha: string; mergedSha: string; strategy: 'fast_forward' }, actorId: string) {
    const proposal = this.getChangeProposal(input.proposalId)
    if (proposal.status !== 'approved') throw new AppError(409, 'Only an approved change proposal can be merged', 'merge_not_approved')
    if (proposal.baseRef !== input.baseRef || proposal.baseSha !== input.baseShaBefore) throw new AppError(409, 'Merge base does not match the approved proposal', 'merge_base_mismatch')
    if (proposal.headSha !== input.approvedHeadSha || input.mergedSha !== input.approvedHeadSha) throw new AppError(409, 'Merged revision must exactly match the approved Head SHA', 'merge_revision_mismatch')
    const readiness = this.getReviewReadiness(input.proposalId)
    if (readiness.status !== 'ready') throw new AppError(409, 'Merge requires complete successful checks and evidence', 'merge_evidence_incomplete')
    const approvalRows = this.db.prepare("SELECT id FROM review_decisions WHERE change_proposal_id = ? AND head_sha = ? AND decision = 'approved' AND invalidated_at IS NULL ORDER BY created_at, rowid").all(input.proposalId, proposal.headSha) as Array<{ id: string }>
    if (!approvalRows.length) throw new AppError(409, 'Merge requires an active approval for the current Head SHA', 'merge_approval_missing')
    this.assertMergeEventChainsIntact(input.proposalId)
    const identity = this.decisionIdentity(actorId)
    const proposalEvents = this.listAggregateEvents('change_proposal', input.proposalId)
    const timestamp = nowIso()
    const canonical = { changeProposalId: input.proposalId, baseRef: input.baseRef, baseShaBefore: input.baseShaBefore, approvedHeadSha: input.approvedHeadSha, mergedSha: input.mergedSha, strategy: input.strategy, approvalReviewIds: approvalRows.map((row) => row.id), checkIds: readiness.checks.map((check) => check.id), evidenceIds: readiness.evidence.map((evidence) => evidence.id), proposalEventChainHead: proposalEvents.at(-1)?.eventDigest ?? 'genesis', mergedByActorId: actorId, mergedAt: timestamp }
    const evidence: MergeEvidence = { id: id('MRG'), ...canonical, evidenceDigest: `sha256:${sha256(JSON.stringify(canonical))}` }
    return this.inTransaction(() => {
      this.db.prepare('INSERT INTO merge_evidence(id, change_proposal_id, base_ref, base_sha_before, approved_head_sha, merged_sha, strategy, approval_review_ids_json, check_ids_json, evidence_ids_json, proposal_event_chain_head, evidence_digest, merged_by_actor_id, merged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(evidence.id, evidence.changeProposalId, evidence.baseRef, evidence.baseShaBefore, evidence.approvedHeadSha, evidence.mergedSha, evidence.strategy, JSON.stringify(evidence.approvalReviewIds), JSON.stringify(evidence.checkIds), JSON.stringify(evidence.evidenceIds), evidence.proposalEventChainHead, evidence.evidenceDigest, evidence.mergedByActorId, evidence.mergedAt)
      this.db.prepare("UPDATE change_proposals SET status = 'merged', updated_at = ? WHERE id = ?").run(timestamp, input.proposalId)
      this.db.prepare("UPDATE work_items SET status = 'done', updated_at = ? WHERE id = ?").run(timestamp, proposal.workItemId)
      this.appendEvent({ aggregateType: 'change_proposal', aggregateId: input.proposalId, eventType: 'change_proposal.merged', actorId, payload: { mergeEvidenceId: evidence.id, baseRef: evidence.baseRef, baseShaBefore: evidence.baseShaBefore, approvedHeadSha: evidence.approvedHeadSha, mergedSha: evidence.mergedSha, strategy: evidence.strategy, approvalReviewIds: evidence.approvalReviewIds, checkIds: evidence.checkIds, evidenceIds: evidence.evidenceIds, proposalEventChainHead: evidence.proposalEventChainHead, evidenceDigest: evidence.evidenceDigest, overrideDecisionIds: readiness.criteria.flatMap((item) => item.override ? [item.override.decisionId] : []), identity } })
      return evidence
    })
  }

  /**
   * In `host_protected` mode the host merged, and this records it. The merge already happened, so unlike
   * recordMergeEvidence nothing here can refuse it: a merge the gate did not allow is recorded all the same, marked
   * outside the gate with its reasons, and announced by its own event, so the audit trail shows what branch protection
   * let through instead of pretending it did not happen.
   */
  recordHostMerge(input: { proposalId: string; baseShaBefore?: string; mergedSha: string; host: Omit<HostMergeRecord, 'outsideGate' | 'outsideGateReasons'> }, actorId: string) {
    const proposal = this.getChangeProposal(input.proposalId)
    if (proposal.status === 'merged') throw new AppError(409, `Change proposal ${proposal.id} is already merged`, 'proposal_merged')
    const readiness = this.getReviewReadiness(input.proposalId)
    const approvalRows = this.db.prepare("SELECT id FROM review_decisions WHERE change_proposal_id = ? AND head_sha = ? AND decision = 'approved' AND invalidated_at IS NULL ORDER BY created_at, rowid").all(input.proposalId, proposal.headSha) as Array<{ id: string }>
    const reasons = [
      ...(proposal.status !== 'approved' ? [`proposal was ${proposal.status}, not approved`] : []),
      ...(proposal.status === 'approved' && !approvalRows.length ? ['no active approval for the approved head'] : []),
      ...(readiness.status !== 'ready' ? [`evidence readiness was ${readiness.status}`] : []),
      ...(input.host.contentCheck === 'mismatch' ? ['merged revision contains neither the approved head nor its patch'] : []),
      ...(input.host.hostHeadSha && input.host.hostHeadSha !== proposal.headSha ? [`pull request head was ${input.host.hostHeadSha.slice(0, 12)}, not the approved ${proposal.headSha.slice(0, 12)}`] : []),
      ...(input.host.gateStateAtMerge !== 'success' ? [`aperture/gate was ${input.host.gateStateAtMerge} on the host`] : []),
      ...(() => { try { this.assertMergeEventChainsIntact(input.proposalId); return [] } catch (error) { return [error instanceof Error ? error.message : String(error)] } })(),
    ]
    const hostMerge: HostMergeRecord = { ...input.host, outsideGate: reasons.length > 0, outsideGateReasons: reasons }
    const proposalEvents = this.listAggregateEvents('change_proposal', input.proposalId)
    const timestamp = nowIso()
    const canonical = { changeProposalId: input.proposalId, baseRef: proposal.baseRef, baseShaBefore: input.baseShaBefore ?? proposal.baseSha, approvedHeadSha: proposal.headSha, mergedSha: input.mergedSha, strategy: 'host_merge' as const, approvalReviewIds: approvalRows.map((row) => row.id), checkIds: readiness.checks.map((check) => check.id), evidenceIds: readiness.evidence.map((evidence) => evidence.id), proposalEventChainHead: proposalEvents.at(-1)?.eventDigest ?? 'genesis', mergedByActorId: actorId, mergedAt: timestamp, hostMerge }
    const evidence: MergeEvidence = { id: id('MRG'), ...canonical, evidenceDigest: `sha256:${sha256(JSON.stringify(canonical))}` }
    return this.inTransaction(() => {
      this.db.prepare('INSERT INTO merge_evidence(id, change_proposal_id, base_ref, base_sha_before, approved_head_sha, merged_sha, strategy, approval_review_ids_json, check_ids_json, evidence_ids_json, proposal_event_chain_head, evidence_digest, merged_by_actor_id, merged_at, host_merge_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(evidence.id, evidence.changeProposalId, evidence.baseRef, evidence.baseShaBefore, evidence.approvedHeadSha, evidence.mergedSha, evidence.strategy, JSON.stringify(evidence.approvalReviewIds), JSON.stringify(evidence.checkIds), JSON.stringify(evidence.evidenceIds), evidence.proposalEventChainHead, evidence.evidenceDigest, evidence.mergedByActorId, evidence.mergedAt, JSON.stringify(hostMerge))
      this.db.prepare("UPDATE change_proposals SET status = 'merged', updated_at = ? WHERE id = ?").run(timestamp, input.proposalId)
      this.db.prepare("UPDATE work_items SET status = 'done', updated_at = ? WHERE id = ?").run(timestamp, proposal.workItemId)
      this.appendEvent({ aggregateType: 'change_proposal', aggregateId: input.proposalId, eventType: 'change_proposal.merged', actorId, payload: { mergeEvidenceId: evidence.id, baseRef: evidence.baseRef, baseShaBefore: evidence.baseShaBefore, approvedHeadSha: evidence.approvedHeadSha, mergedSha: evidence.mergedSha, strategy: evidence.strategy, approvalReviewIds: evidence.approvalReviewIds, checkIds: evidence.checkIds, evidenceIds: evidence.evidenceIds, proposalEventChainHead: evidence.proposalEventChainHead, evidenceDigest: evidence.evidenceDigest, hostMerge } })
      if (hostMerge.outsideGate) this.appendEvent({ aggregateType: 'change_proposal', aggregateId: input.proposalId, eventType: 'change_proposal.merged_outside_gate', actorId, payload: { mergeEvidenceId: evidence.id, previousStatus: proposal.status, readiness: readiness.status, reasons, url: hostMerge.url, mergedBy: hostMerge.mergedBy ?? null } })
      return evidence
    })
  }

  /** A pull request closed on the host closes the proposal, as a rejection whose reason says where it came from. */
  closeProposalOnHost(input: { proposalId: string; url: string; closedBy?: string }, actorId: string): GovernanceDecision | undefined {
    const proposal = this.getChangeProposal(input.proposalId)
    if (proposal.status === 'closed' || proposal.status === 'merged') return undefined
    const readiness = this.getReviewReadiness(input.proposalId)
    const decision: GovernanceDecision = { id: id('DEC'), changeProposalId: proposal.id, headSha: proposal.headSha, decisionType: 'reject', actorId, reason: `closed_on_host: ${input.url}${input.closedBy ? ` by ${input.closedBy}` : ''}`, evidenceSha256: readiness.evidence.map((item) => item.sha256), createdAt: nowIso() }
    return this.inTransaction(() => {
      this.insertDecision(decision)
      this.db.prepare("UPDATE change_proposals SET status = 'closed', updated_at = ? WHERE id = ?").run(decision.createdAt, proposal.id)
      this.appendEvent({ aggregateType: 'change_proposal', aggregateId: proposal.id, eventType: 'decision.rejected', actorId, payload: { decisionId: decision.id, headSha: decision.headSha, previousStatus: proposal.status, reason: decision.reason, source: 'closed_on_host', url: input.url, closedBy: input.closedBy ?? null, evidenceReadiness: readiness.status, evidenceSha256: decision.evidenceSha256 } })
      return decision
    })
  }

  getCodeHostLink(proposalId: string): CodeHostLink | undefined {
    const row = this.db.prepare('SELECT * FROM code_host_links WHERE change_proposal_id = ?').get(proposalId) as Record<string, SqlValue> | undefined
    return row ? this.mapCodeHostLink(row) : undefined
  }

  listCodeHostLinks(projectIds?: string[]): CodeHostLink[] {
    const rows = this.db.prepare('SELECT * FROM code_host_links ORDER BY synced_at DESC').all() as Array<Record<string, SqlValue>>
    return rows.map((row) => this.mapCodeHostLink(row)).filter((link) => !projectIds || projectIds.includes(link.projectId))
  }

  /** Proposals the syncer still has to look at: open ones, and closed or merged ones whose pull request is still open. */
  listSyncableProposals(projectId: string): ChangeProposal[] {
    const rows = this.db.prepare("SELECT p.* FROM change_proposals p LEFT JOIN code_host_links l ON l.change_proposal_id = p.id WHERE p.project_id = ? AND (p.status NOT IN ('merged', 'closed') OR l.state = 'open') ORDER BY p.created_at").all(projectId) as Array<Record<string, SqlValue>>
    return rows.map((row) => this.getChangeProposal(String(row.id)))
  }

  /** Bookkeeping only. Publishing a new head is an event on the proposal; gate and error updates are not. */
  saveCodeHostLink(link: Omit<CodeHostLink, 'syncedAt'>, actorId: string) {
    const previous = this.getCodeHostLink(link.changeProposalId)
    const timestamp = nowIso()
    this.inTransaction(() => {
      this.db.prepare('INSERT INTO code_host_links(change_proposal_id, project_id, provider, external_id, url, published_ref, head_sha_published, state, gate_state_published, gate_sha_published, gate_description_published, last_error, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(change_proposal_id) DO UPDATE SET external_id = excluded.external_id, url = excluded.url, published_ref = excluded.published_ref, head_sha_published = excluded.head_sha_published, state = excluded.state, gate_state_published = excluded.gate_state_published, gate_sha_published = excluded.gate_sha_published, gate_description_published = excluded.gate_description_published, last_error = excluded.last_error, synced_at = excluded.synced_at').run(link.changeProposalId, link.projectId, link.provider, link.externalId, link.url, link.publishedRef, link.headShaPublished, link.state, link.gateStatePublished ?? null, link.gateShaPublished ?? null, link.gateDescriptionPublished ?? null, link.lastError ?? null, timestamp)
      if (!previous || previous.headShaPublished !== link.headShaPublished || previous.url !== link.url) this.appendEvent({ aggregateType: 'change_proposal', aggregateId: link.changeProposalId, eventType: 'change_proposal.published_to_host', actorId, payload: { provider: link.provider, externalId: link.externalId, url: link.url, publishedRef: link.publishedRef, headSha: link.headShaPublished, previousHeadSha: previous?.headShaPublished ?? null } })
    })
    return this.getCodeHostLink(link.changeProposalId)!
  }

  recordCodeHostLinkError(proposalId: string, message: string) {
    this.db.prepare('UPDATE code_host_links SET last_error = ?, synced_at = ? WHERE change_proposal_id = ?').run(message.slice(0, 500), nowIso(), proposalId)
  }

  private mapCodeHostLink(row: Record<string, SqlValue>): CodeHostLink {
    return { changeProposalId: String(row.change_proposal_id), projectId: String(row.project_id), provider: 'github', externalId: String(row.external_id), url: String(row.url), publishedRef: String(row.published_ref), headShaPublished: String(row.head_sha_published), state: String(row.state) as CodeHostLink['state'], gateStatePublished: row.gate_state_published ? String(row.gate_state_published) as CodeHostLink['gateStatePublished'] : undefined, gateShaPublished: row.gate_sha_published ? String(row.gate_sha_published) : undefined, gateDescriptionPublished: row.gate_description_published ? String(row.gate_description_published) : undefined, lastError: row.last_error ? String(row.last_error) : undefined, syncedAt: String(row.synced_at) }
  }

  createReleaseCandidate(input: { proposalId: string; mergeEvidenceId: string; repositoryPath: string; sourceRef: string; commitSha: string; sourceTreeDigest: string; sourceFileCount: number; artifactClass: ReleaseCandidate['artifactClass']; artifactEvidence: ReleaseCandidate['artifactEvidence'] }, actorId: string) {
    const existing = this.db.prepare('SELECT id FROM release_candidates WHERE change_proposal_id = ? AND commit_sha = ?').get(input.proposalId, input.commitSha) as { id: string } | undefined
    if (existing) return this.getReleaseCandidate(existing.id)
    const proposal = this.getChangeProposal(input.proposalId)
    if (proposal.status !== 'merged') throw new AppError(409, 'Release Candidate requires a merged change proposal', 'release_requires_merge')
    const mergeEvidence = this.getMergeEvidence(input.proposalId)
    if (mergeEvidence.id !== input.mergeEvidenceId || mergeEvidence.mergedSha !== input.commitSha) throw new AppError(409, 'Release Candidate does not match Merge Evidence', 'release_merge_evidence_mismatch')
    if (input.artifactEvidence.some((evidence) => !mergeEvidence.evidenceIds.includes(evidence.evidenceId))) throw new AppError(409, 'Artifact Evidence is not bound by Merge Evidence', 'release_artifact_evidence_unbound')
    const timestamp = nowIso()
    const artifactBinding = { artifactClass: input.artifactClass, evidence: input.artifactEvidence }
    const artifactBindingDigest = `sha256:${sha256(JSON.stringify(artifactBinding))}`
    const canonical = { changeProposalId: input.proposalId, mergeEvidenceId: input.mergeEvidenceId, mergeEvidenceDigest: mergeEvidence.evidenceDigest, repositoryPath: input.repositoryPath, sourceRef: input.sourceRef, commitSha: input.commitSha, sourceTreeDigest: input.sourceTreeDigest, sourceFileCount: input.sourceFileCount, artifactBindingDigest }
    const candidate: ReleaseCandidate = { id: id('RC'), projectId: proposal.projectId, changeProposalId: input.proposalId, mergeEvidenceId: input.mergeEvidenceId, repositoryPath: input.repositoryPath, sourceRef: input.sourceRef, commitSha: input.commitSha, sourceTreeDigest: input.sourceTreeDigest, sourceFileCount: input.sourceFileCount, artifactClass: input.artifactClass, artifactEvidence: input.artifactEvidence, artifactBindingDigest, contentDigest: `sha256:${sha256(JSON.stringify(canonical))}`, status: 'review_ready', createdByActorId: actorId, createdAt: timestamp }
    return this.inTransaction(() => {
      this.db.prepare('INSERT INTO release_candidates(id, project_id, change_proposal_id, merge_evidence_id, repository_path, source_ref, commit_sha, source_tree_digest, source_file_count, artifact_class, artifact_evidence_json, artifact_binding_digest, content_digest, status, created_by_actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(candidate.id, candidate.projectId, candidate.changeProposalId, candidate.mergeEvidenceId, candidate.repositoryPath, candidate.sourceRef, candidate.commitSha, candidate.sourceTreeDigest, candidate.sourceFileCount, candidate.artifactClass, JSON.stringify(candidate.artifactEvidence), candidate.artifactBindingDigest, candidate.contentDigest, candidate.status, candidate.createdByActorId, candidate.createdAt)
      this.appendEvent({ aggregateType: 'release_candidate', aggregateId: candidate.id, eventType: 'release_candidate.created', actorId, payload: { changeProposalId: candidate.changeProposalId, mergeEvidenceId: candidate.mergeEvidenceId, commitSha: candidate.commitSha, sourceTreeDigest: candidate.sourceTreeDigest, sourceFileCount: candidate.sourceFileCount, artifactClass: candidate.artifactClass, artifactEvidence: candidate.artifactEvidence, artifactBindingDigest: candidate.artifactBindingDigest, contentDigest: candidate.contentDigest } })
      return candidate
    })
  }

  getReleaseCandidate(candidateId: string) {
    const row = this.db.prepare('SELECT * FROM release_candidates WHERE id = ?').get(candidateId) as Record<string, SqlValue> | undefined
    if (!row) throw new AppError(404, `Release Candidate ${candidateId} not found`, 'release_candidate_not_found')
    return this.verifyReleaseCandidate(this.mapReleaseCandidate(row))
  }

  listReleaseCandidates(projectIds?: string[]) {
    const filter = projectClause('project_id', projectIds)
    return (this.db.prepare(`SELECT * FROM release_candidates ${filter.sql} ORDER BY created_at DESC`).all(...filter.params) as Array<Record<string, SqlValue>>).map((row) => this.verifyReleaseCandidate(this.mapReleaseCandidate(row)))
  }

  approveReleaseCandidate(candidateId: string, approverActorId: string, comment: string) {
    const candidate = this.getReleaseCandidate(candidateId)
    if (candidate.status === 'approved') return candidate
    if (candidate.status !== 'review_ready') throw new AppError(409, 'Release Candidate is not ready for approval', 'release_not_review_ready')
    if (candidate.createdByActorId === approverActorId) throw new AppError(403, 'Release Candidate creators cannot approve their own candidate', 'release_self_approval_forbidden')
    this.requireProjectRole(approverActorId, candidate.projectId, ['owner', 'maintainer'], 'release_approval_forbidden')
    const identity = this.decisionIdentity(approverActorId)
    const timestamp = nowIso()
    const approvalId = id('RAP')
    return this.inTransaction(() => {
      this.db.prepare('INSERT INTO release_approvals(id, release_candidate_id, approver_actor_id, comment, candidate_content_digest, approved_at) VALUES (?, ?, ?, ?, ?, ?)').run(approvalId, candidateId, approverActorId, comment.trim(), candidate.contentDigest, timestamp)
      this.db.prepare("UPDATE release_candidates SET status = 'approved', approved_at = ? WHERE id = ?").run(timestamp, candidateId)
      this.appendEvent({ aggregateType: 'release_candidate', aggregateId: candidateId, eventType: 'release_candidate.approved', actorId: approverActorId, payload: { approvalId, commitSha: candidate.commitSha, sourceTreeDigest: candidate.sourceTreeDigest, candidateContentDigest: candidate.contentDigest, comment: comment.trim(), identity } })
      return this.getReleaseCandidate(candidateId)
    })
  }

  refreshChangeProposal(proposalId: string, next: { runId?: string; baseSha: string; headRef?: string; headSha: string; changedFiles: number; additions: number; deletions: number; policyFiles?: string[] }, actorId: string) {
    const current = this.getChangeProposal(proposalId)
    const headRef = next.headRef ?? current.headRef
    const runId = next.runId ?? current.runId
    this.assertProposalOpen(current)
    if (current.headSha === next.headSha && current.baseSha === next.baseSha && current.headRef === headRef && current.runId === runId) {
      // A proposal created before the policy-file scan gets its list filled in without touching any decision.
      if (!current.policyFiles && next.policyFiles) this.db.prepare('UPDATE change_proposals SET policy_files_json = ? WHERE id = ?').run(JSON.stringify(next.policyFiles), proposalId)
      return { proposal: this.getChangeProposal(proposalId), changed: false, invalidated: { reviews: 0, checks: 0, evidence: 0, overrides: 0 } }
    }
    return this.inTransaction(() => {
      const timestamp = nowIso()
      const reviews = Number(this.db.prepare('UPDATE review_decisions SET invalidated_at = ? WHERE change_proposal_id = ? AND invalidated_at IS NULL').run(timestamp, proposalId).changes)
      const checks = Number(this.db.prepare('UPDATE check_runs SET invalidated_at = ? WHERE change_proposal_id = ? AND invalidated_at IS NULL').run(timestamp, proposalId).changes)
      const evidence = Number(this.db.prepare('UPDATE evidence_packages SET invalidated_at = ? WHERE change_proposal_id = ? AND invalidated_at IS NULL').run(timestamp, proposalId).changes)
      const overrides = Number(this.db.prepare("UPDATE governance_decisions SET invalidated_at = ? WHERE change_proposal_id = ? AND decision_type = 'override' AND invalidated_at IS NULL").run(timestamp, proposalId).changes)
      // The assignee keeps the review, but has to open and decide the new head: nothing they did on the old one counts.
      const assignment = this.activeAssignment(proposalId)
      if (assignment) this.db.prepare("UPDATE review_assignments SET status = 'pending', head_sha = ?, cycle_started_at = ?, evidence_opened_at = NULL, decided_at = NULL, time_spent_seconds = NULL WHERE id = ?").run(next.headSha, timestamp, assignment.id)
      this.db.prepare("UPDATE change_proposals SET run_id = ?, base_sha = ?, head_ref = ?, head_sha = ?, changed_files = ?, additions = ?, deletions = ?, policy_files_json = ?, status = 'review_ready', review_cycle_started_at = ?, updated_at = ? WHERE id = ?").run(runId ?? null, next.baseSha, headRef, next.headSha, next.changedFiles, next.additions, next.deletions, next.policyFiles ? JSON.stringify(next.policyFiles) : null, timestamp, timestamp, proposalId)
      this.appendEvent({ aggregateType: 'change_proposal', aggregateId: proposalId, eventType: 'change_proposal.revision_changed', actorId, payload: { previousRunId: current.runId ?? null, runId: runId ?? null, previousHeadRef: current.headRef, headRef, previousHeadSha: current.headSha, headSha: next.headSha, policyFiles: next.policyFiles ?? null, assignmentReset: assignment?.id ?? null, invalidated: { reviews, checks, evidence, overrides } } })
      return { proposal: this.getChangeProposal(proposalId), changed: true, invalidated: { reviews, checks, evidence, overrides } }
    })
  }

  recordCheck(input: { proposalId: string; headSha: string; name: string; status: 'queued' | 'in_progress' | 'completed'; conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled'; evidenceRef?: string; exitCode?: number; durationMs?: number; stdoutDigest?: string; stderrDigest?: string; source?: 'run' | 'external'; runId?: string }, actorId: string) {
    const proposal = this.getChangeProposal(input.proposalId)
    if (proposal.headSha !== input.headSha) throw new AppError(409, 'Check is bound to a stale head revision', 'stale_head')
    if (proposal.status === 'closed') throw new AppError(409, `Change proposal ${proposal.id} was rejected`, 'proposal_closed')
    const source = input.source ?? 'external'
    const existing = this.db.prepare('SELECT id, source, run_id FROM check_runs WHERE change_proposal_id = ? AND head_sha = ? AND name = ?').get(input.proposalId, input.headSha, input.name) as { id: string; source: string; run_id: string | null } | undefined
    if (existing && existing.source === 'run') throw new AppError(409, `Check ${input.name} was produced by Agent Run ${existing.run_id ?? 'unknown'} at this head revision and cannot be overwritten`, 'check_run_result_immutable')
    const timestamp = nowIso()
    const checkId = id('CHK')
    return this.inTransaction(() => {
      this.db.prepare('INSERT INTO check_runs(id, change_proposal_id, head_sha, name, status, conclusion, evidence_ref, exit_code, duration_ms, stdout_digest, stderr_digest, source, run_id, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(change_proposal_id, head_sha, name) DO UPDATE SET status = excluded.status, conclusion = excluded.conclusion, evidence_ref = excluded.evidence_ref, exit_code = excluded.exit_code, duration_ms = excluded.duration_ms, stdout_digest = excluded.stdout_digest, stderr_digest = excluded.stderr_digest, source = excluded.source, run_id = excluded.run_id, started_at = excluded.started_at, completed_at = excluded.completed_at, invalidated_at = NULL').run(checkId, input.proposalId, input.headSha, input.name, input.status, input.conclusion ?? null, input.evidenceRef ?? null, input.exitCode ?? null, input.durationMs ?? null, input.stdoutDigest ?? null, input.stderrDigest ?? null, source, input.runId ?? null, timestamp, input.status === 'completed' ? timestamp : null)
      const stored = this.db.prepare('SELECT id FROM check_runs WHERE change_proposal_id = ? AND head_sha = ? AND name = ?').get(input.proposalId, input.headSha, input.name) as { id: string }
      this.appendEvent({ aggregateType: 'change_proposal', aggregateId: input.proposalId, eventType: 'check.recorded', actorId, payload: { checkId: stored.id, headSha: input.headSha, name: input.name, status: input.status, conclusion: input.conclusion ?? null, exitCode: input.exitCode ?? null, durationMs: input.durationMs ?? null, stdoutDigest: input.stdoutDigest ?? null, stderrDigest: input.stderrDigest ?? null, source, runId: input.runId ?? null, replacedCheckId: existing?.id ?? null } })
      return { id: stored.id, ...input, source, startedAt: timestamp, completedAt: input.status === 'completed' ? timestamp : undefined }
    })
  }

  recordEvidence(input: { proposalId: string; runId: string; headSha: string; uri: string; sha256: string; summary: Record<string, unknown> }, actorId: string) {
    const proposal = this.getChangeProposal(input.proposalId)
    if (proposal.headSha !== input.headSha) throw new AppError(409, 'Evidence is bound to a stale head revision', 'stale_head')
    if (proposal.status === 'closed') throw new AppError(409, `Change proposal ${proposal.id} was rejected`, 'proposal_closed')
    const timestamp = nowIso()
    const evidenceId = id('EVD')
    return this.inTransaction(() => {
      this.db.prepare('INSERT INTO evidence_packages(id, change_proposal_id, run_id, head_sha, uri, sha256, summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(evidenceId, input.proposalId, input.runId, input.headSha, input.uri, input.sha256, JSON.stringify(input.summary), timestamp)
      this.appendEvent({ aggregateType: 'change_proposal', aggregateId: input.proposalId, eventType: 'evidence.recorded', actorId, payload: { evidenceId, runId: input.runId, headSha: input.headSha, uri: input.uri, sha256: input.sha256, ...(input.summary.eventChainHeads ? { eventChainHeads: input.summary.eventChainHeads } : {}) } })
      return { id: evidenceId, ...input, createdAt: timestamp }
    })
  }

  getEvidencePackage(evidenceId: string) {
    const row = this.db.prepare('SELECT * FROM evidence_packages WHERE id = ?').get(evidenceId) as Record<string, SqlValue> | undefined
    if (!row) throw new AppError(404, `Evidence package ${evidenceId} not found`, 'evidence_not_found')
    return { id: String(row.id), changeProposalId: String(row.change_proposal_id), runId: String(row.run_id), headSha: String(row.head_sha), uri: String(row.uri), sha256: String(row.sha256), summary: parseJson<Record<string, unknown>>(String(row.summary_json)), invalidatedAt: row.invalidated_at ? String(row.invalidated_at) : undefined, createdAt: String(row.created_at) }
  }

  recordEvidenceView(evidenceId: string, reviewerActorId: string, viewedSha256: string) {
    const evidence = this.getEvidencePackage(evidenceId)
    if (evidence.sha256 !== viewedSha256) throw new AppError(409, 'Viewed evidence digest does not match the recorded package', 'evidence_digest_mismatch')
    this.requireProjectRole(reviewerActorId, this.getChangeProposal(evidence.changeProposalId).projectId, ['owner', 'maintainer', 'reviewer'], 'evidence_view_forbidden')
    const timestamp = nowIso()
    const viewId = id('EVW')
    return this.inTransaction(() => {
      const result = this.db.prepare('INSERT OR IGNORE INTO evidence_views(id, evidence_id, reviewer_actor_id, viewed_sha256, viewed_at) VALUES (?, ?, ?, ?, ?)').run(viewId, evidenceId, reviewerActorId, viewedSha256, timestamp)
      const stored = this.db.prepare('SELECT id, viewed_at FROM evidence_views WHERE evidence_id = ? AND reviewer_actor_id = ? AND viewed_sha256 = ?').get(evidenceId, reviewerActorId, viewedSha256) as { id: string; viewed_at: string }
      const assignment = this.activeAssignment(evidence.changeProposalId)
      const opensAssignment = assignment?.assigneeActorId === reviewerActorId && assignment.headSha === evidence.headSha && !assignment.evidenceOpenedAt && !evidence.invalidatedAt
      if (opensAssignment) this.db.prepare("UPDATE review_assignments SET evidence_opened_at = ?, status = CASE WHEN status = 'pending' THEN 'in_review' ELSE status END WHERE id = ?").run(timestamp, assignment.id)
      if (result.changes) this.appendEvent({ aggregateType: 'change_proposal', aggregateId: evidence.changeProposalId, eventType: 'evidence.viewed', actorId: reviewerActorId, payload: { evidenceId, headSha: evidence.headSha, viewedSha256, openedAssignmentId: opensAssignment ? assignment.id : null } })
      return { id: stored.id, evidenceId, reviewerActorId, viewedSha256, viewedAt: stored.viewed_at }
    })
  }

  recordReview(input: { proposalId: string; headSha: string; reviewerActorId: string; decision: ReviewDecision; comment: string }) {
    const proposal = this.getChangeProposal(input.proposalId)
    if (proposal.headSha !== input.headSha) throw new AppError(409, 'Review is bound to a stale head revision', 'stale_head')
    if (!['approved', 'changes_requested', 'commented'].includes(input.decision)) throw new AppError(400, 'Invalid review decision', 'invalid_review_decision')
    this.assertProposalOpen(proposal)
    if (proposal.authorActorId === input.reviewerActorId) throw new AppError(403, 'Authors cannot review their own change proposal', 'self_review_forbidden')
    const reviewerRole = this.requireProjectRole(input.reviewerActorId, proposal.projectId, ['owner', 'maintainer', 'reviewer'], 'review_forbidden')
    // DOMAIN_MODEL.md §5.8: an assigned review has one owner. Anyone may comment; the terminal decisions belong to the
    // assignee, and taking the review over is a reassignment that leaves a record, not a quiet approval.
    const assignment = this.activeAssignment(input.proposalId)
    if (assignment && input.decision !== 'commented' && assignment.assigneeActorId !== input.reviewerActorId) throw new AppError(403, `Review is assigned to ${assignment.assigneeDisplayName}; reassign it before deciding`, 'review_not_assigned')
    const readiness = this.getReviewReadiness(input.proposalId)
    const intent = this.getIntentVersion(proposal.intentVersionId)
    const evidenceViewed = readiness.evidence.length > 0 && readiness.evidence.every((evidence) => Number((this.db.prepare('SELECT COUNT(*) AS count FROM evidence_views WHERE evidence_id = ? AND reviewer_actor_id = ? AND viewed_sha256 = ?').get(evidence.id, input.reviewerActorId, evidence.sha256) as { count: number }).count) > 0)
    if (input.decision === 'approved' && readiness.failedCheckCount > 0) throw new AppError(409, 'Approval is blocked by failed checks on the current head revision', 'review_blocked_by_failed_checks')
    // DOMAIN_MODEL.md §5.6: a critical criterion that failed, rests only on run-authored tests, cannot be mapped, or has no result yet cannot reach
    // Approved, at any risk level. The light path for low risk skips the evidence-viewing requirement, not the criteria.
    const blockedCriteria = readiness.criteria.filter((item) => item.criticality === 'critical' && ['failed', 'self_graded', 'unmapped', 'pending'].includes(item.status))
    if (input.decision === 'approved' && blockedCriteria.length) throw new AppError(409, `Approval is blocked by critical acceptance criteria: ${blockedCriteria.map((item) => item.label).join(', ')}`, 'review_blocked_by_criteria')
    // Human-verified criteria are evidenced by this approval, so the reviewer signs each one by name: a blanket "ok"
    // under three human criteria says nothing about which of them was actually judged.
    const humanCriteria = readiness.criteria.filter((item) => item.verificationType === 'human' && item.criticality === 'critical')
    const unsignedHumanCriteria = humanCriteria.filter((item) => !mentionsCriterion(input.comment, item.label))
    if (input.decision === 'approved' && unsignedHumanCriteria.length) throw new AppError(409, `Approving signs off human-verified criteria; the comment must name ${unsignedHumanCriteria.map((item) => item.label).join(', ')} and record the judgement on each`, 'review_human_criteria_unsigned')
    // DOMAIN_MODEL.md §9.1.1: a change to the files that govern runs goes through a stricter approval. Only an owner
    // may accept it, and the comment has to say so — the checks on this head ran under the base manifest, so nothing
    // in the evidence speaks to whether the new rules are acceptable.
    const policyFiles = readiness.policyFiles ?? []
    if (input.decision === 'approved' && policyFiles.length && reviewerRole !== 'owner') throw new AppError(403, `This change modifies policy files (${policyFiles.join(', ')}); only an owner can approve it`, 'review_policy_change_requires_owner')
    if (input.decision === 'approved' && policyFiles.length && !input.comment.trim()) throw new AppError(409, `This change modifies policy files (${policyFiles.join(', ')}); the approval comment must record why the new rules are acceptable`, 'review_policy_change_unacknowledged')
    // A Builder stopped at its budget handed over whatever it had; the checks say what works, not what is missing, so
    // the reviewer has to say why the change is acceptable as it stands.
    if (input.decision === 'approved' && readiness.builderStop && !input.comment.trim()) throw new AppError(409, `The Builder was stopped at its ${readiness.builderStop.reason === 'time_budget' ? 'time' : 'step'} budget, so this change may be partial; the approval comment must record why it is acceptable as it stands`, 'review_partial_change_unacknowledged')
    if (input.decision === 'approved' && intent.riskLevel !== 'low' && readiness.status !== 'ready') throw new AppError(409, 'Medium and high risk changes require complete checks and evidence', 'review_evidence_incomplete')
    if (input.decision === 'approved' && intent.riskLevel !== 'low' && !evidenceViewed) throw new AppError(409, 'Reviewer must view the current evidence package before approval', 'review_evidence_not_viewed')
    // A comment decides nothing, so it is open to any session; the two terminal decisions carry a frozen identity.
    const identity = input.decision === 'commented' ? null : this.decisionIdentity(input.reviewerActorId)
    const timestamp = nowIso()
    const reviewId = id('REV')
    const decisionLatencySeconds = Math.max(0, Math.floor((Date.parse(timestamp) - Date.parse(proposal.reviewCycleStartedAt)) / 1000))
    return this.inTransaction(() => {
      const superseded = Number(this.db.prepare('UPDATE review_decisions SET invalidated_at = ? WHERE change_proposal_id = ? AND head_sha = ? AND reviewer_actor_id = ? AND invalidated_at IS NULL').run(timestamp, input.proposalId, input.headSha, input.reviewerActorId).changes)
      this.db.prepare('INSERT INTO review_decisions(id, change_proposal_id, head_sha, reviewer_actor_id, decision, comment, decision_latency_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(reviewId, input.proposalId, input.headSha, input.reviewerActorId, input.decision, input.comment.trim(), decisionLatencySeconds, timestamp)
      const activeDecisions = (this.db.prepare('SELECT decision FROM review_decisions WHERE change_proposal_id = ? AND head_sha = ? AND invalidated_at IS NULL').all(input.proposalId, input.headSha) as Array<{ decision: ReviewDecision }>).map((row) => row.decision)
      const status = activeDecisions.includes('changes_requested') ? 'changes_requested' : activeDecisions.includes('approved') ? 'approved' : 'review_ready'
      this.db.prepare('UPDATE change_proposals SET status = ?, updated_at = ? WHERE id = ?').run(status, timestamp, input.proposalId)
      const decidesAssignment = assignment && input.decision !== 'commented'
      if (decidesAssignment) this.db.prepare('UPDATE review_assignments SET status = ?, decided_at = ?, time_spent_seconds = ? WHERE id = ?').run(input.decision, timestamp, Math.max(0, Math.floor((Date.parse(timestamp) - Date.parse(assignment.cycleStartedAt)) / 1000)), assignment.id)
      // An approval by someone who never opened the evidence is the direct observable of a rubber stamp; it is allowed
      // on the low risk light path but always flagged.
      const evidenceOpenedBeforeDecision = assignment ? Boolean(assignment.evidenceOpenedAt) : evidenceViewed
      this.appendEvent({ aggregateType: 'change_proposal', aggregateId: input.proposalId, eventType: `review.${input.decision}`, actorId: input.reviewerActorId, payload: { reviewId, headSha: input.headSha, comment: input.comment.trim(), decisionLatencySeconds, supersededDecisionCount: superseded, resultingStatus: status, riskLevel: intent.riskLevel, evidenceReadiness: readiness.status, evidenceViewed, checkIds: readiness.checks.map((check) => check.id), evidenceIds: readiness.evidence.map((evidence) => evidence.id), blockers: readiness.blockers, criteria: readiness.criteria.map((item) => ({ criterionId: item.criterionId, status: item.status, overrideDecisionId: item.override?.decisionId ?? null })), waivedCheckCount: readiness.waivedCheckCount, humanCriteriaSignedOff: input.decision === 'approved' ? humanCriteria.map((item) => item.criterionId) : [], policyFilesAcknowledged: input.decision === 'approved' ? policyFiles : [], partialChangeAcknowledged: input.decision === 'approved' && readiness.builderStop ? readiness.builderStop.runId : null, assignmentId: decidesAssignment ? assignment.id : null, evidenceOpenedBeforeDecision, unopenedApproval: input.decision === 'approved' && !evidenceOpenedBeforeDecision, identity } })
      return { id: reviewId, ...input, decisionLatencySeconds, createdAt: timestamp }
    })
  }

  private assertProposalOpen(proposal: ChangeProposal) {
    if (proposal.status === 'closed') throw new AppError(409, `Change proposal ${proposal.id} was rejected and is closed`, 'proposal_closed')
    if (proposal.status === 'merged') throw new AppError(409, `Change proposal ${proposal.id} is already merged`, 'proposal_merged')
  }

  private activeOverrides(proposalId: string, headSha: string) {
    const rows = this.db.prepare(`
      SELECT governance_decisions.*, actors.display_name AS actor_display_name FROM governance_decisions
      JOIN actors ON actors.id = governance_decisions.actor_id
      WHERE change_proposal_id = ? AND head_sha = ? AND decision_type = 'override' AND invalidated_at IS NULL
    `).all(proposalId, headSha) as Array<Record<string, SqlValue>>
    return new Map(rows.map((row) => [String(row.criterion_id), { decisionId: String(row.id), actorId: String(row.actor_id), actorDisplayName: String(row.actor_display_name), overriddenStatus: String(row.overridden_status) as CriterionOverride['overriddenStatus'], reason: String(row.reason), createdAt: String(row.created_at) }]))
  }

  /** Without a project the check is platform-wide (actors.role); with one it is the actor's role in that project. */
  private assertDecisionActor(actorId: string, roles: TeamRole[], code: string, projectId?: string) {
    if (projectId) return this.requireProjectRole(actorId, projectId, roles, code)
    const actor = this.db.prepare('SELECT role, status FROM actors WHERE id = ?').get(actorId) as { role: TeamRole; status: string } | undefined
    if (!actor || actor.status !== 'active' || !roles.includes(actor.role)) throw new AppError(403, `Only ${roles.join(' or ')} actors may record this decision`, code)
    return actor.role
  }

  /**
   * DOMAIN_MODEL.md §5.6: overriding a failed evaluation requires an explicit Override Decision. It is scoped to one
   * critical criterion at one head revision, needs the owner role and a reason, and cannot come from the author —
   * otherwise "the agent's tests pass" could be turned into "approved" by the person who asked for the change.
   */
  recordOverride(input: { proposalId: string; headSha: string; criterionId: string; reason: string }, actorId: string): GovernanceDecision {
    const proposal = this.getChangeProposal(input.proposalId)
    this.assertProposalOpen(proposal)
    if (proposal.headSha !== input.headSha) throw new AppError(409, 'Override is bound to a stale head revision', 'stale_head')
    this.assertDecisionActor(actorId, ['owner'], 'override_forbidden', proposal.projectId)
    if (proposal.authorActorId === actorId) throw new AppError(403, 'The author of a change proposal cannot override its gates', 'self_override_forbidden')
    const reason = input.reason.trim()
    if (reason.length < 10) throw new AppError(400, 'An override must record why the gate is being bypassed (at least 10 characters)', 'override_reason_required')
    const readiness = this.getReviewReadiness(input.proposalId)
    const criterion = readiness.criteria.find((item) => item.criterionId === input.criterionId)
    if (!criterion) throw new AppError(404, `Acceptance criterion ${input.criterionId} is not part of this proposal's intent`, 'criterion_not_found')
    if (criterion.status === 'overridden') throw new AppError(409, `${criterion.label} is already overridden at this head revision`, 'override_exists')
    if (criterion.criticality !== 'critical' || !['failed', 'self_graded', 'unmapped'].includes(criterion.status)) throw new AppError(409, `${criterion.label} is ${criterion.criticality} and ${criterion.status}; only a blocking critical criterion with a failed, self-graded or unmapped result can be overridden`, 'override_not_applicable')
    const identity = this.decisionIdentity(actorId)
    const decision: GovernanceDecision = { id: id('DEC'), changeProposalId: proposal.id, headSha: proposal.headSha, decisionType: 'override', criterionId: criterion.criterionId, overriddenStatus: criterion.status as CriterionOverride['overriddenStatus'], actorId, reason, evidenceSha256: readiness.evidence.map((item) => item.sha256), createdAt: nowIso() }
    return this.inTransaction(() => {
      this.insertDecision(decision)
      this.appendEvent({ aggregateType: 'change_proposal', aggregateId: proposal.id, eventType: 'decision.override_recorded', actorId, payload: { decisionId: decision.id, headSha: decision.headSha, criterionId: criterion.criterionId, label: criterion.label, overriddenStatus: decision.overriddenStatus, checkNames: criterion.checkNames, reason, evidenceSha256: decision.evidenceSha256, identity } })
      return decision
    })
  }

  /** DOMAIN_MODEL.md §6.4 Reject: ends the proposal. Unlike RequestChanges it offers no revision path. */
  rejectChangeProposal(input: { proposalId: string; headSha: string; reason: string }, actorId: string): GovernanceDecision {
    const proposal = this.getChangeProposal(input.proposalId)
    this.assertProposalOpen(proposal)
    if (proposal.headSha !== input.headSha) throw new AppError(409, 'Rejection is bound to a stale head revision', 'stale_head')
    this.assertDecisionActor(actorId, ['owner', 'maintainer', 'reviewer'], 'reject_forbidden', proposal.projectId)
    if (proposal.authorActorId === actorId) throw new AppError(403, 'Authors cannot reject their own change proposal', 'self_review_forbidden')
    const reason = input.reason.trim()
    if (!reason) throw new AppError(400, 'A rejection must record its reason', 'reject_reason_required')
    const readiness = this.getReviewReadiness(input.proposalId)
    const identity = this.decisionIdentity(actorId)
    const decision: GovernanceDecision = { id: id('DEC'), changeProposalId: proposal.id, headSha: proposal.headSha, decisionType: 'reject', actorId, reason, evidenceSha256: readiness.evidence.map((item) => item.sha256), createdAt: nowIso() }
    return this.inTransaction(() => {
      this.insertDecision(decision)
      this.db.prepare("UPDATE change_proposals SET status = 'closed', updated_at = ? WHERE id = ?").run(decision.createdAt, proposal.id)
      this.appendEvent({ aggregateType: 'change_proposal', aggregateId: proposal.id, eventType: 'decision.rejected', actorId, payload: { decisionId: decision.id, headSha: decision.headSha, previousStatus: proposal.status, reason, evidenceReadiness: readiness.status, evidenceSha256: decision.evidenceSha256, identity } })
      return decision
    })
  }

  private insertDecision(decision: GovernanceDecision) {
    this.db.prepare('INSERT INTO governance_decisions(id, change_proposal_id, head_sha, decision_type, criterion_id, overridden_status, actor_id, reason, evidence_sha256_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(decision.id, decision.changeProposalId, decision.headSha, decision.decisionType, decision.criterionId ?? null, decision.overriddenStatus ?? null, decision.actorId, decision.reason, JSON.stringify(decision.evidenceSha256), decision.createdAt)
  }

  listGovernanceDecisions(proposalId?: string): GovernanceDecision[] {
    const rows = (proposalId ? this.db.prepare('SELECT * FROM governance_decisions WHERE change_proposal_id = ? ORDER BY created_at, rowid').all(proposalId) : this.db.prepare('SELECT * FROM governance_decisions ORDER BY created_at, rowid').all()) as Array<Record<string, SqlValue>>
    return rows.map((row) => ({ id: String(row.id), changeProposalId: String(row.change_proposal_id), headSha: String(row.head_sha), decisionType: String(row.decision_type) as GovernanceDecision['decisionType'], criterionId: row.criterion_id ? String(row.criterion_id) : undefined, overriddenStatus: row.overridden_status ? String(row.overridden_status) as CriterionOverride['overriddenStatus'] : undefined, actorId: String(row.actor_id), reason: String(row.reason), evidenceSha256: parseJson<string[]>(String(row.evidence_sha256_json)), createdAt: String(row.created_at) }))
  }

  listReviews(projectIds?: string[]): ReviewRecord[] {
    const filter = projectClause('change_proposals.project_id', projectIds)
    const rows = this.db.prepare(`
      SELECT review_decisions.*, actors.display_name AS reviewer_display_name,
        CASE WHEN actors.role = 'owner' THEN 'owner' ELSE COALESCE(project_members.role, actors.role) END AS reviewer_role
      FROM review_decisions
      JOIN actors ON actors.id = review_decisions.reviewer_actor_id
      JOIN change_proposals ON change_proposals.id = review_decisions.change_proposal_id
      LEFT JOIN project_members ON project_members.project_id = change_proposals.project_id AND project_members.actor_id = actors.id
      ${filter.sql}
      ORDER BY review_decisions.created_at DESC, review_decisions.rowid DESC
    `).all(...filter.params) as Array<Record<string, SqlValue>>
    return rows.map((row) => ({
      id: String(row.id),
      changeProposalId: String(row.change_proposal_id),
      headSha: String(row.head_sha),
      reviewerActorId: String(row.reviewer_actor_id),
      reviewerDisplayName: String(row.reviewer_display_name),
      reviewerRole: String(row.reviewer_role) as TeamRole,
      decision: String(row.decision) as ReviewDecision,
      comment: String(row.comment),
      decisionLatencySeconds: Number(row.decision_latency_seconds ?? 0),
      invalidatedAt: row.invalidated_at ? String(row.invalidated_at) : undefined,
      createdAt: String(row.created_at),
    }))
  }

  /**
   * DOMAIN_MODEL.md §5.8 / V0.3 §9.10. Owners and maintainers assign; a reviewer may claim an unassigned proposal for
   * themselves. The author is never eligible, and a proposal that edits `.aperture/` can only go to an owner, because
   * only an owner can approve it. With no assignee named, the least-loaded eligible actor is picked.
   */
  assignReviewer(input: { proposalId: string; assigneeActorId?: string; dueHours?: number; reason?: string }, actorId: string): ReviewAssignment {
    const proposal = this.getChangeProposal(input.proposalId)
    this.assertProposalOpen(proposal)
    const role = this.requireProjectRole(actorId, proposal.projectId, ALL_ROLES, 'review_assignment_forbidden')
    const current = this.activeAssignment(proposal.id)
    const selfClaim = input.assigneeActorId === actorId
    if (!(['owner', 'maintainer'].includes(role) || (role === 'reviewer' && selfClaim && !current))) throw new AppError(403, 'Only owners and maintainers assign reviewers; a reviewer may claim an unassigned proposal for themselves', 'review_assignment_forbidden')
    const identity = this.decisionIdentity(actorId)
    const policyFiles = proposal.policyFiles ?? []
    // In Team mode only a member who can actually decide is worth assigning: an unbound assignee would be stuck.
    const teamMode = this.getIdentityMode() === 'team'
    const load = this.listReviewerLoad(proposal.projectId).filter((candidate) => !teamMode || candidate.identityVerified)
    let assignee: ReviewerLoad | undefined
    if (input.assigneeActorId) {
      assignee = load.find((candidate) => candidate.actorId === input.assigneeActorId)
      if (!assignee && teamMode && this.listReviewerLoad(proposal.projectId).some((candidate) => candidate.actorId === input.assigneeActorId)) throw new AppError(409, 'Team mode: the assignee has no verified GitHub identity and could not decide', 'assignee_identity_unbound')
      if (!assignee) throw new AppError(409, 'Assignee must be an active owner, maintainer or reviewer of this project', 'assignee_not_reviewer')
      if (assignee.actorId === proposal.authorActorId) throw new AppError(409, 'The author cannot be assigned to review their own change proposal', 'self_assignment_forbidden')
      if (policyFiles.length && assignee.role !== 'owner') throw new AppError(409, `This change modifies policy files (${policyFiles.join(', ')}); only an owner can be assigned`, 'assignee_cannot_approve_policy_change')
    } else {
      assignee = load
        .filter((candidate) => candidate.actorId !== proposal.authorActorId && candidate.actorId !== current?.assigneeActorId && (!policyFiles.length || candidate.role === 'owner'))
        .sort((left, right) => left.openAssignmentCount - right.openAssignmentCount || left.displayName.localeCompare(right.displayName))[0]
      if (!assignee) throw new AppError(409, 'No eligible reviewer is available for this change proposal', 'no_eligible_reviewer')
    }
    if (current?.assigneeActorId === assignee.actorId) throw new AppError(409, `Review is already assigned to ${assignee.displayName}`, 'already_assigned')
    const reason = (input.reason ?? '').trim()
    if (current && !reason) throw new AppError(409, `Taking the review away from ${current.assigneeDisplayName} needs a reason`, 'reassign_reason_required')
    const dueHours = input.dueHours ?? 24
    if (!Number.isInteger(dueHours) || dueHours < 1 || dueHours > 336) throw new AppError(400, 'dueHours must be an integer between 1 and 336', 'invalid_due_hours')
    const basis: ReviewAssignment['basis'] = !input.assigneeActorId ? 'load_balanced' : selfClaim ? 'self_claim' : 'manual'
    const timestamp = nowIso()
    const dueAt = new Date(Date.parse(timestamp) + dueHours * 3600_000).toISOString()
    const assignmentId = id('RVA')
    return this.inTransaction(() => {
      if (current) this.db.prepare("UPDATE review_assignments SET status = 'reassigned', ended_at = ? WHERE id = ?").run(timestamp, current.id)
      this.db.prepare('INSERT INTO review_assignments(id, change_proposal_id, assignee_actor_id, assigned_by_actor_id, basis, reason, status, head_sha, reassigned_from, assigned_at, due_at, cycle_started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(assignmentId, proposal.id, assignee.actorId, actorId, basis, reason, 'pending', proposal.headSha, current?.id ?? null, timestamp, dueAt, timestamp)
      this.appendEvent({ aggregateType: 'change_proposal', aggregateId: proposal.id, eventType: 'review.assigned', actorId, payload: { assignmentId, assigneeActorId: assignee.actorId, basis, reason, headSha: proposal.headSha, dueAt, assigneeOpenLoad: assignee.openAssignmentCount, policyFiles, reassignedFrom: current?.id ?? null, previousAssigneeActorId: current?.assigneeActorId ?? null, identity } })
      return this.listReviewAssignments(proposal.id).find((item) => item.id === assignmentId)!
    })
  }

  listReviewAssignments(proposalId?: string, projectIds?: string[]): ReviewAssignment[] {
    const filter = proposalId ? { sql: 'WHERE review_assignments.change_proposal_id = ?', params: [proposalId] } : projectClause('change_proposals.project_id', projectIds)
    const rows = this.db.prepare(`
      SELECT review_assignments.*, actors.display_name AS assignee_display_name, change_proposals.status AS proposal_status FROM review_assignments
      JOIN actors ON actors.id = review_assignments.assignee_actor_id
      JOIN change_proposals ON change_proposals.id = review_assignments.change_proposal_id
      ${filter.sql}
      ORDER BY review_assignments.assigned_at, review_assignments.rowid
    `).all(...filter.params) as Array<Record<string, SqlValue>>
    const now = Date.now()
    return rows.map((row) => {
      const status = String(row.status) as ReviewAssignment['status']
      return {
        id: String(row.id),
        changeProposalId: String(row.change_proposal_id),
        assigneeActorId: String(row.assignee_actor_id),
        assigneeDisplayName: String(row.assignee_display_name),
        assignedByActorId: String(row.assigned_by_actor_id),
        basis: String(row.basis) as ReviewAssignment['basis'],
        reason: String(row.reason),
        status,
        headSha: String(row.head_sha),
        ...(row.reassigned_from ? { reassignedFrom: String(row.reassigned_from) } : {}),
        assignedAt: String(row.assigned_at),
        dueAt: String(row.due_at),
        cycleStartedAt: String(row.cycle_started_at),
        ...(row.evidence_opened_at ? { evidenceOpenedAt: String(row.evidence_opened_at) } : {}),
        ...(row.decided_at ? { decidedAt: String(row.decided_at) } : {}),
        ...(row.time_spent_seconds !== null ? { timeSpentSeconds: Number(row.time_spent_seconds) } : {}),
        ...(row.ended_at ? { endedAt: String(row.ended_at) } : {}),
        overdue: ['pending', 'in_review'].includes(status) && !['merged', 'closed'].includes(String(row.proposal_status)) && Date.parse(String(row.due_at)) < now,
      }
    })
  }

  /**
   * Open load counts reviews still waiting on the assignee; a proposal sent back for changes is waiting on the author.
   * With a project, the candidates are that project's owners, maintainers and reviewers, each with their project role;
   * the load still counts every project, because it is the same person's time.
   */
  listReviewerLoad(projectId?: string): ReviewerLoad[] {
    const rows = this.db.prepare(`
      SELECT actors.id, actors.display_name, ${projectId ? "CASE WHEN actors.role = 'owner' THEN 'owner' ELSE project_members.role END" : 'actors.role'} AS role, (
        SELECT COUNT(*) FROM review_assignments
        JOIN change_proposals ON change_proposals.id = review_assignments.change_proposal_id
        WHERE review_assignments.assignee_actor_id = actors.id AND review_assignments.status IN ('pending', 'in_review') AND change_proposals.status NOT IN ('merged', 'closed')
      ) AS open_count, (SELECT login FROM identity_bindings WHERE identity_bindings.actor_id = actors.id AND subject IS NOT NULL) AS verified_login
      FROM actors ${projectId ? 'LEFT JOIN project_members ON project_members.actor_id = actors.id AND project_members.project_id = ?' : ''}
      WHERE actors.status = 'active' AND ${projectId ? "(actors.role = 'owner' OR project_members.role IN ('maintainer', 'reviewer'))" : "actors.role IN ('owner', 'maintainer', 'reviewer')"}
      ORDER BY actors.display_name
    `).all(...(projectId ? [projectId] : [])) as Array<Record<string, SqlValue>>
    return rows.map((row) => ({ actorId: String(row.id), displayName: String(row.display_name), role: String(row.role) as TeamRole, openAssignmentCount: Number(row.open_count), identityVerified: row.verified_login !== null, githubLogin: row.verified_login === null ? undefined : String(row.verified_login) }))
  }

  private activeAssignment(proposalId: string) {
    return this.listReviewAssignments(proposalId).find((item) => item.status !== 'reassigned')
  }

  listCurrentChangeRequests(proposalId: string) {
    const proposal = this.getChangeProposal(proposalId)
    return this.listReviews().filter((review) => review.changeProposalId === proposalId && review.headSha === proposal.headSha && !review.invalidatedAt && review.decision === 'changes_requested').map((review) => ({ reviewId: review.id, reviewerActorId: review.reviewerActorId, reviewerDisplayName: review.reviewerDisplayName, comment: review.comment, createdAt: review.createdAt }))
  }

  getReviewMetrics(projectIds?: string[]): ReviewMetrics {
    const now = Date.now()
    const proposals = this.listChangeProposals(projectIds)
    const reviews = this.listReviews(projectIds)
    const firstTerminalDecisionByRevision = new Map<string, ReviewRecord>()
    for (const review of [...reviews].reverse()) {
      if (review.decision === 'commented') continue
      const revisionKey = `${review.changeProposalId}:${review.headSha}`
      if (!firstTerminalDecisionByRevision.has(revisionKey)) firstTerminalDecisionByRevision.set(revisionKey, review)
    }
    const latencies = [...firstTerminalDecisionByRevision.values()].map((review) => review.decisionLatencySeconds).sort((left, right) => left - right)
    const medianDecisionLatencySeconds = latencies.length === 0 ? 0 : latencies.length % 2 === 1 ? latencies[Math.floor(latencies.length / 2)] : Math.round((latencies[latencies.length / 2 - 1] + latencies[latencies.length / 2]) / 2)
    const pending = proposals.filter((proposal) => proposal.status === 'review_ready')
    // The first terminal decision per proposal drives first-pass and rework; per revision it would count a
    // reworked change as passing first time on its second revision.
    const firstDecisionByProposal = new Map<string, ReviewRecord>()
    for (const review of [...reviews].reverse()) {
      if (review.decision === 'commented') continue
      if (!firstDecisionByProposal.has(review.changeProposalId)) firstDecisionByProposal.set(review.changeProposalId, review)
    }
    const approvals = reviews.filter((review) => review.decision === 'approved' && !review.invalidatedAt)
    const evidenceExpandedApprovalCount = approvals.filter((review) => Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM evidence_views
      JOIN evidence_packages ON evidence_packages.id = evidence_views.evidence_id
      WHERE evidence_packages.change_proposal_id = ? AND evidence_packages.head_sha = ?
        AND evidence_views.reviewer_actor_id = ? AND evidence_views.viewed_at <= ?
    `).get(review.changeProposalId, review.headSha, review.reviewerActorId, review.createdAt) as { count: number }).count) > 0).length
    return {
      pendingCount: pending.length,
      changesRequestedCount: proposals.filter((proposal) => proposal.status === 'changes_requested').length,
      approvedCount: proposals.filter((proposal) => proposal.status === 'approved').length,
      currentDecisionCount: reviews.filter((review) => !review.invalidatedAt).length,
      invalidatedDecisionCount: reviews.filter((review) => Boolean(review.invalidatedAt)).length,
      medianDecisionLatencySeconds,
      oldestPendingSeconds: pending.length === 0 ? 0 : Math.max(...pending.map((proposal) => Math.max(0, Math.floor((now - Date.parse(proposal.reviewCycleStartedAt)) / 1000)))),
      activeReviewerCount: new Set(reviews.filter((review) => !review.invalidatedAt).map((review) => review.reviewerActorId)).size,
      approvalDecisionCount: approvals.length,
      evidenceExpandedApprovalCount,
      decidedProposalCount: firstDecisionByProposal.size,
      firstPassApprovalCount: [...firstDecisionByProposal.values()].filter((review) => review.decision === 'approved').length,
      reworkedProposalCount: new Set(reviews.filter((review) => review.decision === 'changes_requested').map((review) => review.changeProposalId)).size,
      acceptedChangeCount: proposals.filter((proposal) => ['approved', 'merged'].includes(proposal.status)).length,
    }
  }

  getReviewReadiness(proposalId: string): ReviewReadiness {
    const proposal = this.getChangeProposal(proposalId)
    const checkRows = this.db.prepare('SELECT * FROM check_runs WHERE change_proposal_id = ? AND head_sha = ? AND invalidated_at IS NULL ORDER BY started_at, rowid').all(proposalId, proposal.headSha) as Array<Record<string, SqlValue>>
    const evidenceRows = this.db.prepare('SELECT * FROM evidence_packages WHERE change_proposal_id = ? AND head_sha = ? AND invalidated_at IS NULL ORDER BY created_at, rowid').all(proposalId, proposal.headSha) as Array<Record<string, SqlValue>>
    const checks = checkRows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      status: String(row.status) as 'queued' | 'in_progress' | 'completed',
      conclusion: row.conclusion ? String(row.conclusion) as 'success' | 'failure' | 'neutral' | 'cancelled' : undefined,
      evidenceRef: row.evidence_ref ? String(row.evidence_ref) : undefined,
      exitCode: row.exit_code === null ? undefined : Number(row.exit_code),
      durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms),
      stdoutDigest: row.stdout_digest ? String(row.stdout_digest) : undefined,
      stderrDigest: row.stderr_digest ? String(row.stderr_digest) : undefined,
      source: (row.source ? String(row.source) : 'external') as 'run' | 'external',
      runId: row.run_id ? String(row.run_id) : undefined,
      startedAt: String(row.started_at),
      completedAt: row.completed_at ? String(row.completed_at) : undefined,
    }))
    const evidence = evidenceRows.map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      uri: String(row.uri),
      sha256: String(row.sha256),
      summary: parseJson<Record<string, unknown>>(String(row.summary_json)),
      viewCount: Number((this.db.prepare('SELECT COUNT(*) AS count FROM evidence_views WHERE evidence_id = ?').get(String(row.id)) as { count: number }).count),
      createdAt: String(row.created_at),
    }))
    const successfulCheckCount = checks.filter((check) => check.status === 'completed' && check.conclusion === 'success').length
    const pendingCheckCount = checks.filter((check) => check.status !== 'completed').length
    // The run's postprocessor maps criteria while it still knows each check's kind and test provenance. Checks
    // recorded externally carry neither, so the fallback rule treats every check as deterministic evidence and
    // leaves model-verified criteria unmapped — which blocks, rather than letting them pass on nothing.
    const intent = this.getIntentVersion(proposal.intentVersionId)
    const packagedCoverage = evidence.map((item) => item.summary.criteriaCoverage).find((value): value is CriterionCoverage[] => Array.isArray(value))
    const coverage = packagedCoverage ?? mapCriteriaToChecks(intent, checks.filter((check) => !check.name.endsWith('@baseline')).map((check) => ({ name: check.name, kind: 'test' as const, provenance: check.source === 'external' ? 'external' : undefined })))
    // Without a packaged mapping, zero checks means none have been reported yet — pending, not proven unmappable.
    const computed = coverage.map((item) => ({ ...item, status: !packagedCoverage && item.verificationType === 'deterministic' && !item.checkNames.length ? 'pending' as const : criterionStatus(item, checks) }))
    // An Override Decision only replaces the status it was judged against: if the evidence has since changed
    // (a failed external check re-reported as success, say), the computed status stands again.
    const overrides = this.activeOverrides(proposalId, proposal.headSha)
    const criteria = computed.map((item) => {
      const override = overrides.get(item.criterionId)
      return override && override.overriddenStatus === item.status ? { ...item, status: 'overridden' as const, override } : item
    })
    // A failed check stops blocking only when every critical criterion that rests on it has been overridden.
    // Checks no criterion maps to — workspace, baseline and dataset integrity — can never be waived.
    const failedChecks = checks.filter((check) => check.status === 'completed' && ['failure', 'cancelled'].includes(check.conclusion ?? ''))
    const waived = (name: string) => {
      const dependents = criteria.filter((item) => item.checkNames.includes(name))
      return dependents.some((item) => item.status === 'overridden') && !dependents.some((item) => item.criticality === 'critical' && item.status !== 'overridden')
    }
    const waivedCheckCount = failedChecks.filter((check) => waived(check.name)).length
    const failedCheckCount = failedChecks.length - waivedCheckCount
    const criticalCriteria = criteria.filter((item) => item.criticality === 'critical')
    const criterionBlockers = [
      ...criticalCriteria.filter((item) => item.status === 'unmapped').map((item) => `${item.label} is critical but no check maps to it: ${item.unmappedReason ?? 'no check of its verification type was run.'}`),
      ...criticalCriteria.filter((item) => item.status === 'failed').map((item) => `${item.label} is critical and its evidence failed (${item.checkNames.join(', ')}).`),
      ...criticalCriteria.filter((item) => item.status === 'self_graded').map((item) => `${item.label} is critical but only passed tests the run could have authored (${item.checkNames.join(', ')}); declare testPaths so the tests are re-run from the base revision, or add a build check.`),
      // DOMAIN_MODEL.md §5.6: a model evaluation must not be the only critical evidence for a high risk change.
      ...(intent.riskLevel === 'high' && criticalCriteria.length > 0 && criticalCriteria.every((item) => item.verificationType === 'model') ? ['High risk changes cannot rest on model evaluation alone; add a critical deterministic or human criterion.'] : []),
    ]
    const blockers = [
      ...(checks.length === 0 ? ['No checks recorded for the current head revision.'] : []),
      ...(failedCheckCount > 0 ? [`${failedCheckCount} check(s) failed or were cancelled.`] : []),
      ...(pendingCheckCount > 0 ? [`${pendingCheckCount} check(s) are still pending.`] : []),
      ...(evidence.length === 0 ? ['No evidence package is bound to the current head revision.'] : []),
      ...criterionBlockers,
    ]
    const status = failedCheckCount > 0 || criterionBlockers.length > 0 ? 'blocked' : blockers.length > 0 ? 'incomplete' : 'ready'
    return {
      changeProposalId: proposalId,
      headSha: proposal.headSha,
      status,
      checks,
      evidence,
      successfulCheckCount,
      failedCheckCount,
      waivedCheckCount,
      pendingCheckCount,
      invalidatedCheckCount: Number((this.db.prepare('SELECT COUNT(*) AS count FROM check_runs WHERE change_proposal_id = ? AND invalidated_at IS NOT NULL').get(proposalId) as { count: number }).count),
      invalidatedEvidenceCount: Number((this.db.prepare('SELECT COUNT(*) AS count FROM evidence_packages WHERE change_proposal_id = ? AND invalidated_at IS NOT NULL').get(proposalId) as { count: number }).count),
      criteria,
      blockers,
      policyFiles: proposal.policyFiles ?? null,
      builderStop: proposal.runId ? this.builderStop(proposal.runId) : null,
    }
  }

  /** The Builder's own report that it was stopped at a budget, from the run that produced the head under review. */
  private builderStop(runId: string): ReviewReadiness['builderStop'] {
    const report = this.listAggregateEvents('agent_run', runId).filter((event) => event.eventType === 'agent_run.message' && typeof event.payload.stopped === 'string').at(-1)
    return report ? { runId, reason: report.payload.stopped as BuilderStopReason, summary: String(report.payload.summary ?? '') } : null
  }

  listReviewReadiness(projectIds?: string[]): ReviewReadiness[] {
    return this.listChangeProposals(projectIds).map((proposal) => this.getReviewReadiness(proposal.id))
  }

  /** Team-level events (actors, identity, provider settings) carry no project and are visible to every member. */
  listEvents(limit = 200, projectIds?: string[]): DomainEvent[] {
    const filter = projectIds ? `WHERE project_id IS NULL${projectIds.length ? ` OR project_id IN (${projectIds.map(() => '?').join(', ')})` : ''}` : ''
    const rows = this.db.prepare(`SELECT * FROM domain_events ${filter} ORDER BY recorded_at DESC, rowid DESC LIMIT ?`).all(...(projectIds ?? []), Math.min(Math.max(limit, 1), 1000)) as Array<Record<string, SqlValue>>
    return rows.map((row) => this.mapEvent(row))
  }

  listAggregateEvents(aggregateType: string, aggregateId: string): DomainEvent[] {
    const rows = this.db.prepare('SELECT * FROM domain_events WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY aggregate_version').all(aggregateType, aggregateId) as Array<Record<string, SqlValue>>
    return rows.map((row) => this.mapEvent(row))
  }

  /**
   * Merging is the last moment the audit trail can still refuse something, so it re-verifies the hash chains the
   * decision rests on: the proposal's own events and those of every run that produced its evidence. Append-only
   * triggers stop UPDATE and DELETE; this catches a row inserted around them (a forged approval, say). A chain
   * rewritten consistently from genesis still verifies, so each evidence package's recorded chain heads must also be
   * events of the chains as they are now.
   */
  assertMergeEventChainsIntact(proposalId: string) {
    const rows = this.db.prepare('SELECT id, run_id, summary_json FROM evidence_packages WHERE change_proposal_id = ?').all(proposalId) as Array<{ id: string; run_id: string; summary_json: string }>
    const runIds = [...new Set(rows.map((row) => row.run_id))]
    const broken = [['change_proposal', proposalId], ...runIds.map((runId) => ['agent_run', runId])].filter(([type, aggregateId]) => !this.verifyAggregateEventChain(type, aggregateId)).map(([type, aggregateId]) => `${type} ${aggregateId}`)
    for (const row of rows) {
      const heads = parseJson<{ eventChainHeads?: { runEventChainHead?: unknown; proposalEventChainHead?: unknown } }>(row.summary_json).eventChainHeads
      if (!heads) continue
      if (!this.isOnEventChain('agent_run', row.run_id, heads.runEventChainHead)) broken.push(`agent_run ${row.run_id} (head recorded by ${row.id})`)
      if (!this.isOnEventChain('change_proposal', proposalId, heads.proposalEventChainHead)) broken.push(`change_proposal ${proposalId} (head recorded by ${row.id})`)
    }
    if (broken.length) throw new AppError(409, `The event chain of ${broken.join(', ')} does not verify; the audit trail was altered outside the Control Plane`, 'event_chain_broken')
  }

  private isOnEventChain(aggregateType: string, aggregateId: string, digest: unknown) {
    return digest === 'genesis' || (typeof digest === 'string' && this.listAggregateEvents(aggregateType, aggregateId).some((event) => event.eventDigest === digest))
  }

  verifyAggregateEventChain(aggregateType: string, aggregateId: string) {
    const events = this.listAggregateEvents(aggregateType, aggregateId)
    let previousDigest = 'genesis'
    for (const event of events) {
      const canonical = { aggregateType: event.aggregateType, aggregateId: event.aggregateId, aggregateVersion: event.aggregateVersion, eventType: event.eventType, actorId: event.actorId ?? null, payload: event.payload, previousEventDigest: previousDigest, occurredAt: event.occurredAt }
      if (event.previousEventDigest !== previousDigest || event.eventDigest !== `sha256:${sha256(JSON.stringify(canonical))}`) return false
      previousDigest = event.eventDigest
    }
    return true
  }

  private eventProjectId(aggregateType: string, aggregateId: string): string | null {
    if (aggregateType === 'project') return aggregateId
    const table = PROJECT_TABLES[aggregateType]
    if (!table) return null
    return (this.db.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(aggregateId) as { project_id: string | null } | undefined)?.project_id ?? null
  }

  private appendEvent(input: { aggregateType: string; aggregateId: string; eventType: string; actorId?: string; payload: Record<string, unknown>; correlationId?: string; causationId?: string }) {
    const last = this.db.prepare('SELECT aggregate_version, event_digest FROM domain_events WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY aggregate_version DESC LIMIT 1').get(input.aggregateType, input.aggregateId) as { aggregate_version: number; event_digest: string } | undefined
    const aggregateVersion = (last?.aggregate_version ?? 0) + 1
    const previousEventDigest = last?.event_digest ?? 'genesis'
    const occurredAt = nowIso()
    const canonical = { aggregateType: input.aggregateType, aggregateId: input.aggregateId, aggregateVersion, eventType: input.eventType, actorId: input.actorId ?? null, payload: input.payload, previousEventDigest, occurredAt }
    const event: DomainEvent = { id: id('EVT'), ...canonical, actorId: input.actorId, eventDigest: `sha256:${sha256(JSON.stringify(canonical))}`, correlationId: input.correlationId, causationId: input.causationId, recordedAt: nowIso() }
    this.db.prepare('INSERT INTO domain_events(id, project_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, payload_json, previous_event_digest, event_digest, correlation_id, causation_id, occurred_at, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(event.id, this.eventProjectId(input.aggregateType, input.aggregateId), event.aggregateType, event.aggregateId, event.aggregateVersion, event.eventType, event.actorId ?? null, JSON.stringify(event.payload), event.previousEventDigest, event.eventDigest, event.correlationId ?? null, event.causationId ?? null, event.occurredAt, event.recordedAt)
    return event
  }

  private mapProject(row: Record<string, SqlValue>): Project {
    return { id: String(row.id), slug: String(row.slug), name: String(row.name), description: String(row.description), codeHost: String(row.code_host) as Project['codeHost'], codeHostConfig: parseJson<Project['codeHostConfig']>(String(row.code_host_config)), ...(row.repository_path ? { repositoryPath: String(row.repository_path) } : {}), defaultBranch: String(row.default_branch), mergeMode: String(row.merge_mode) as Project['mergeMode'], status: String(row.status) as Project['status'], ...(row.created_by_actor_id ? { createdByActorId: String(row.created_by_actor_id) } : {}), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
  }

  private mapIdentityBinding(row: Record<string, SqlValue>): IdentityBinding {
    return { provider: 'github', expectedLogin: String(row.expected_login), status: row.subject ? 'verified' : 'declared', subject: row.subject ? String(row.subject) : undefined, login: row.login ? String(row.login) : undefined, verifiedAt: row.verified_at ? String(row.verified_at) : undefined, declaredByActorId: String(row.declared_by_actor_id), declaredAt: String(row.declared_at) }
  }

  private mapWorkItem(row: Record<string, SqlValue>): WorkItem {
    return { id: String(row.id), projectId: String(row.project_id ?? DEFAULT_PROJECT_ID), sequence: Number(row.sequence ?? 0), title: String(row.title), description: String(row.description), productType: String(row.product_type ?? 'application') as WorkItem['productType'], status: String(row.status) as WorkItem['status'], ownerActorId: String(row.owner_actor_id), authorityProvider: String(row.authority_provider), authorityRef: String(row.authority_ref), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
  }

  private mapChangeProposal(row: Record<string, SqlValue>): ChangeProposal {
    return { id: String(row.id), projectId: String(row.project_id ?? DEFAULT_PROJECT_ID), workItemId: String(row.work_item_id), intentVersionId: String(row.intent_version_id), runId: row.run_id ? String(row.run_id) : undefined, repositoryPath: String(row.repository_path), baseRef: String(row.base_ref), baseSha: String(row.base_sha), headRef: String(row.head_ref), headSha: String(row.head_sha), authorActorId: String(row.author_actor_id), status: String(row.status) as ChangeProposal['status'], changedFiles: Number(row.changed_files), additions: Number(row.additions), deletions: Number(row.deletions), ...(row.policy_files_json ? { policyFiles: parseJson<string[]>(String(row.policy_files_json)) } : {}), reviewCycleStartedAt: String(row.review_cycle_started_at ?? row.created_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
  }

  private mapMergeEvidence(row: Record<string, SqlValue>): MergeEvidence {
    return { id: String(row.id), changeProposalId: String(row.change_proposal_id), baseRef: String(row.base_ref), baseShaBefore: String(row.base_sha_before), approvedHeadSha: String(row.approved_head_sha), mergedSha: String(row.merged_sha), strategy: String(row.strategy) as MergeEvidence['strategy'], ...(row.host_merge_json ? { hostMerge: parseJson<HostMergeRecord>(String(row.host_merge_json)) } : {}), approvalReviewIds: parseJson<string[]>(String(row.approval_review_ids_json)), checkIds: parseJson<string[]>(String(row.check_ids_json)), evidenceIds: parseJson<string[]>(String(row.evidence_ids_json)), proposalEventChainHead: String(row.proposal_event_chain_head), evidenceDigest: String(row.evidence_digest), mergedByActorId: String(row.merged_by_actor_id), mergedAt: String(row.merged_at) }
  }

  private mapReleaseCandidate(row: Record<string, SqlValue>): ReleaseCandidate {
    const approval = this.db.prepare('SELECT * FROM release_approvals WHERE release_candidate_id = ?').get(String(row.id)) as Record<string, SqlValue> | undefined
    return { id: String(row.id), projectId: String(row.project_id ?? DEFAULT_PROJECT_ID), changeProposalId: String(row.change_proposal_id), mergeEvidenceId: String(row.merge_evidence_id), repositoryPath: String(row.repository_path), sourceRef: String(row.source_ref), commitSha: String(row.commit_sha), sourceTreeDigest: String(row.source_tree_digest), sourceFileCount: Number(row.source_file_count), artifactClass: row.artifact_class ? String(row.artifact_class) as ReleaseCandidate['artifactClass'] : 'source_snapshot', artifactEvidence: row.artifact_evidence_json ? parseJson<ReleaseCandidate['artifactEvidence']>(String(row.artifact_evidence_json)) : [], artifactBindingDigest: row.artifact_binding_digest ? String(row.artifact_binding_digest) : undefined, contentDigest: String(row.content_digest), status: String(row.status) as ReleaseCandidate['status'], createdByActorId: String(row.created_by_actor_id), createdAt: String(row.created_at), approvedAt: row.approved_at ? String(row.approved_at) : undefined, approval: approval ? { id: String(approval.id), approverActorId: String(approval.approver_actor_id), comment: String(approval.comment), candidateContentDigest: String(approval.candidate_content_digest), approvedAt: String(approval.approved_at) } : undefined }
  }

  private verifyReleaseCandidate(candidate: ReleaseCandidate) {
    const mergeEvidence = this.getMergeEvidence(candidate.changeProposalId)
    const expectedBindingDigest = `sha256:${sha256(JSON.stringify({ artifactClass: candidate.artifactClass, evidence: candidate.artifactEvidence }))}`
    if (candidate.artifactBindingDigest && candidate.artifactBindingDigest !== expectedBindingDigest) throw new AppError(409, 'Release Candidate artifact binding digest verification failed', 'release_artifact_binding_mismatch')
    const canonical = candidate.artifactBindingDigest
      ? { changeProposalId: candidate.changeProposalId, mergeEvidenceId: candidate.mergeEvidenceId, mergeEvidenceDigest: mergeEvidence.evidenceDigest, repositoryPath: candidate.repositoryPath, sourceRef: candidate.sourceRef, commitSha: candidate.commitSha, sourceTreeDigest: candidate.sourceTreeDigest, sourceFileCount: candidate.sourceFileCount, artifactBindingDigest: candidate.artifactBindingDigest }
      : { changeProposalId: candidate.changeProposalId, mergeEvidenceId: candidate.mergeEvidenceId, mergeEvidenceDigest: mergeEvidence.evidenceDigest, repositoryPath: candidate.repositoryPath, sourceRef: candidate.sourceRef, commitSha: candidate.commitSha, sourceTreeDigest: candidate.sourceTreeDigest, sourceFileCount: candidate.sourceFileCount }
    if (candidate.mergeEvidenceId !== mergeEvidence.id || candidate.contentDigest !== `sha256:${sha256(JSON.stringify(canonical))}`) throw new AppError(409, 'Release Candidate content digest verification failed', 'release_candidate_digest_mismatch')
    if (candidate.approval && candidate.approval.candidateContentDigest !== candidate.contentDigest) throw new AppError(409, 'Release approval is not bound to the current candidate digest', 'release_approval_digest_mismatch')
    return candidate
  }

  private verifyMergeEvidence(evidence: MergeEvidence) {
    const canonical = { changeProposalId: evidence.changeProposalId, baseRef: evidence.baseRef, baseShaBefore: evidence.baseShaBefore, approvedHeadSha: evidence.approvedHeadSha, mergedSha: evidence.mergedSha, strategy: evidence.strategy, approvalReviewIds: evidence.approvalReviewIds, checkIds: evidence.checkIds, evidenceIds: evidence.evidenceIds, proposalEventChainHead: evidence.proposalEventChainHead, mergedByActorId: evidence.mergedByActorId, mergedAt: evidence.mergedAt, ...(evidence.hostMerge ? { hostMerge: evidence.hostMerge } : {}) }
    if (evidence.evidenceDigest !== `sha256:${sha256(JSON.stringify(canonical))}`) throw new AppError(409, 'Merge evidence digest verification failed', 'merge_evidence_digest_mismatch')
    if (!this.isOnEventChain('change_proposal', evidence.changeProposalId, evidence.proposalEventChainHead)) throw new AppError(409, 'Merge evidence names a proposal event chain head that is no longer on the chain', 'merge_evidence_chain_mismatch')
    return evidence
  }

  private mapAgentRun(row: Record<string, SqlValue>): AgentRun {
    return { id: String(row.id), projectId: String(row.project_id ?? DEFAULT_PROJECT_ID), workItemId: String(row.work_item_id), intentVersionId: String(row.intent_version_id), repositoryPath: String(row.repository_path), baseRef: String(row.base_ref), baseSha: String(row.base_sha), startSha: String(row.start_sha ?? row.base_sha), revisionOfProposalId: row.revision_of_proposal_id ? String(row.revision_of_proposal_id) : undefined, branchRef: String(row.branch_ref), worktreePath: String(row.worktree_path), adapterId: String(row.adapter_id), isolation: String(row.isolation) as AgentRun['isolation'], runtimeImageRef: row.runtime_image_ref ? String(row.runtime_image_ref) : undefined, runtimeAttestationDigest: row.runtime_attestation_digest ? String(row.runtime_attestation_digest) : undefined, networkEgress: String(row.network_egress ?? 'unrestricted') as AgentRun['networkEgress'], productionEligible: Number(row.production_eligible ?? 0) === 1, status: String(row.status) as AgentRun['status'], queuedAt: row.queued_at ? String(row.queued_at) : undefined, workerPid: row.worker_pid ? Number(row.worker_pid) : undefined, cancellationRequestedAt: row.cancellation_requested_at ? String(row.cancellation_requested_at) : undefined, startedByActorId: String(row.started_by_actor_id), changeProposalId: row.change_proposal_id ? String(row.change_proposal_id) : undefined, exitCode: row.exit_code === null ? undefined : Number(row.exit_code), stdoutDigest: row.stdout_digest ? String(row.stdout_digest) : undefined, stderrDigest: row.stderr_digest ? String(row.stderr_digest) : undefined, errorMessage: row.error_message ? String(row.error_message) : undefined, startedAt: String(row.started_at), completedAt: row.completed_at ? String(row.completed_at) : undefined }
  }

  private mapEvent(row: Record<string, SqlValue>): DomainEvent {
    return { id: String(row.id), aggregateType: String(row.aggregate_type), aggregateId: String(row.aggregate_id), aggregateVersion: Number(row.aggregate_version), eventType: String(row.event_type), actorId: row.actor_id ? String(row.actor_id) : undefined, payload: parseJson<Record<string, unknown>>(String(row.payload_json)), previousEventDigest: String(row.previous_event_digest), eventDigest: String(row.event_digest), correlationId: row.correlation_id ? String(row.correlation_id) : undefined, causationId: row.causation_id ? String(row.causation_id) : undefined, occurredAt: String(row.occurred_at), recordedAt: String(row.recorded_at) }
  }
}
