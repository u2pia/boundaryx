CREATE TABLE merge_evidence (
  id TEXT PRIMARY KEY,
  change_proposal_id TEXT NOT NULL UNIQUE REFERENCES change_proposals(id) ON DELETE CASCADE,
  base_ref TEXT NOT NULL,
  base_sha_before TEXT NOT NULL,
  approved_head_sha TEXT NOT NULL,
  merged_sha TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('fast_forward')),
  approval_review_ids_json TEXT NOT NULL,
  check_ids_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  proposal_event_chain_head TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  merged_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  merged_at TEXT NOT NULL
);

CREATE INDEX idx_merge_evidence_actor ON merge_evidence(merged_by_actor_id, merged_at);

CREATE TRIGGER merge_evidence_no_update
BEFORE UPDATE ON merge_evidence
BEGIN
  SELECT RAISE(ABORT, 'merge_evidence is append-only');
END;

CREATE TRIGGER merge_evidence_no_delete
BEFORE DELETE ON merge_evidence
BEGIN
  SELECT RAISE(ABORT, 'merge_evidence is append-only');
END;
