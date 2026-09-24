ALTER TABLE agent_runs ADD COLUMN start_sha TEXT;
UPDATE agent_runs SET start_sha = base_sha WHERE start_sha IS NULL;

ALTER TABLE agent_runs ADD COLUMN revision_of_proposal_id TEXT REFERENCES change_proposals(id);
CREATE INDEX idx_agent_runs_revision_proposal ON agent_runs(revision_of_proposal_id, started_at DESC);
