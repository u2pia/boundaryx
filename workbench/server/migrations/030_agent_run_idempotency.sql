ALTER TABLE agent_runs ADD COLUMN request_key TEXT;
ALTER TABLE agent_runs ADD COLUMN admission_request_digest TEXT;

CREATE UNIQUE INDEX idx_agent_runs_actor_request_key
  ON agent_runs(started_by_actor_id, request_key)
  WHERE request_key IS NOT NULL;
