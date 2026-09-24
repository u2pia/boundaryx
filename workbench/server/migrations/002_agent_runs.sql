CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  intent_version_id TEXT NOT NULL REFERENCES intent_versions(id),
  repository_path TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  branch_ref TEXT NOT NULL UNIQUE,
  worktree_path TEXT NOT NULL UNIQUE,
  adapter_id TEXT NOT NULL,
  isolation TEXT NOT NULL CHECK (isolation IN ('unisolated_process', 'container')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  started_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  change_proposal_id TEXT REFERENCES change_proposals(id),
  exit_code INTEGER,
  stdout_digest TEXT,
  stderr_digest TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_agent_runs_work_item ON agent_runs(work_item_id, started_at DESC);
CREATE INDEX idx_agent_runs_status ON agent_runs(status, started_at DESC);
