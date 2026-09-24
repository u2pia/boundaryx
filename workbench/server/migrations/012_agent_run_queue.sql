-- Agent Runs are no longer executed inside the HTTP request that starts them: the request only
-- admits and prepares the run, and a worker process executes it. That needs a 'queued' status and a
-- record of which worker owns a run, so the Control Plane can report progress and cancel.
-- SQLite cannot relax a CHECK constraint in place, so the table is rebuilt.
ALTER TABLE agent_runs RENAME TO agent_runs_old;

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
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  started_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  change_proposal_id TEXT REFERENCES change_proposals(id),
  exit_code INTEGER,
  stdout_digest TEXT,
  stderr_digest TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  runtime_image_ref TEXT,
  runtime_attestation_digest TEXT,
  network_egress TEXT NOT NULL DEFAULT 'unrestricted' CHECK (network_egress IN ('denied', 'allowlist', 'unrestricted')),
  production_eligible INTEGER NOT NULL DEFAULT 0 CHECK (production_eligible IN (0, 1)),
  start_sha TEXT,
  revision_of_proposal_id TEXT REFERENCES change_proposals(id),
  queued_at TEXT,
  worker_pid INTEGER,
  cancellation_requested_at TEXT,
  cancellation_requested_by TEXT REFERENCES actors(id)
);

INSERT INTO agent_runs (id, work_item_id, intent_version_id, repository_path, base_ref, base_sha, branch_ref, worktree_path, adapter_id, isolation, status, started_by_actor_id, change_proposal_id, exit_code, stdout_digest, stderr_digest, error_message, started_at, completed_at, runtime_image_ref, runtime_attestation_digest, network_egress, production_eligible, start_sha, revision_of_proposal_id)
SELECT id, work_item_id, intent_version_id, repository_path, base_ref, base_sha, branch_ref, worktree_path, adapter_id, isolation, status, started_by_actor_id, change_proposal_id, exit_code, stdout_digest, stderr_digest, error_message, started_at, completed_at, runtime_image_ref, runtime_attestation_digest, network_egress, production_eligible, start_sha, revision_of_proposal_id
FROM agent_runs_old;

DROP TABLE agent_runs_old;

CREATE INDEX idx_agent_runs_work_item ON agent_runs(work_item_id, started_at DESC);
CREATE INDEX idx_agent_runs_status ON agent_runs(status, started_at DESC);

-- The context the agent was granted is decided when the run is admitted but consumed by the worker,
-- so it has to survive the boundary between the two processes.
CREATE TABLE agent_run_plans (
  agent_run_id TEXT PRIMARY KEY REFERENCES agent_runs(id),
  declared_context_paths TEXT NOT NULL,
  request_path TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
