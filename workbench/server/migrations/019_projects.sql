-- A Project is one repository under one code host, and the unit of access: members hold a role per project, and a
-- non-member cannot see the project's work at all. DOMAIN_MODEL.md keeps multi-repository Intents out of scope, so
-- one project maps to exactly one repository.
--
-- V0.3 §8.2: the core schema must not require host-specific fields. Everything a host needs beyond the working
-- repository lives in `code_host_config` as JSON, and that JSON never holds a secret — a host credential is referenced
-- by the name of an environment variable, resolved at use.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  code_host TEXT NOT NULL CHECK (code_host IN ('local', 'github')),
  code_host_config TEXT NOT NULL DEFAULT '{}',
  -- The Git directory runs and merges operate on. NULL means not configured yet: the project can hold work items but
  -- cannot start a run. For a hosted project this is the control plane's managed clone.
  repository_path TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  merge_mode TEXT NOT NULL DEFAULT 'control_plane' CHECK (merge_mode IN ('control_plane', 'host_protected')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by_actor_id TEXT REFERENCES actors(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Platform owners (actors.role = 'owner') are implicit owners of every project and never appear here.
CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('maintainer', 'reviewer', 'developer')),
  added_by_actor_id TEXT REFERENCES actors(id),
  added_at TEXT NOT NULL,
  PRIMARY KEY (project_id, actor_id)
);

CREATE INDEX idx_project_members_actor ON project_members(actor_id);

ALTER TABLE work_items ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE agent_runs ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE change_proposals ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE release_candidates ADD COLUMN project_id TEXT REFERENCES projects(id);
-- NULL for events that belong to the team rather than a project (actors, identity, provider settings).
ALTER TABLE domain_events ADD COLUMN project_id TEXT REFERENCES projects(id);

CREATE INDEX idx_work_items_project ON work_items(project_id);
CREATE INDEX idx_agent_runs_project ON agent_runs(project_id);
CREATE INDEX idx_change_proposals_project ON change_proposals(project_id);
CREATE INDEX idx_release_candidates_project ON release_candidates(project_id);
CREATE INDEX idx_domain_events_project ON domain_events(project_id, recorded_at);

-- Every installation starts with one project, so a fresh setup has somewhere to put its first work item. It has no
-- repository until an owner configures one. Existing repositories are split into their own projects by the
-- migration hook in database.ts, which needs directory names and deduplication that SQL cannot express cleanly.
INSERT INTO projects(id, slug, name, description, code_host, code_host_config, repository_path, default_branch, merge_mode, status, created_by_actor_id, created_at, updated_at)
VALUES ('PRJ-DEFAULT', 'default', '默认项目', '', 'local', '{}', NULL, 'main', 'control_plane', 'active', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
