CREATE TABLE release_candidates (
  id TEXT PRIMARY KEY,
  change_proposal_id TEXT NOT NULL REFERENCES change_proposals(id),
  merge_evidence_id TEXT NOT NULL REFERENCES merge_evidence(id),
  repository_path TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  source_tree_digest TEXT NOT NULL,
  source_file_count INTEGER NOT NULL,
  content_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('review_ready', 'approved', 'cancelled')),
  created_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  approved_at TEXT,
  UNIQUE(change_proposal_id, commit_sha)
);

CREATE TABLE release_approvals (
  id TEXT PRIMARY KEY,
  release_candidate_id TEXT NOT NULL UNIQUE REFERENCES release_candidates(id) ON DELETE CASCADE,
  approver_actor_id TEXT NOT NULL REFERENCES actors(id),
  comment TEXT NOT NULL,
  candidate_content_digest TEXT NOT NULL,
  approved_at TEXT NOT NULL
);

CREATE INDEX idx_release_candidates_status ON release_candidates(status, created_at DESC);
CREATE INDEX idx_release_approvals_actor ON release_approvals(approver_actor_id, approved_at DESC);

CREATE TRIGGER release_approvals_no_update
BEFORE UPDATE ON release_approvals
BEGIN
  SELECT RAISE(ABORT, 'release_approvals are append-only');
END;

CREATE TRIGGER release_approvals_no_delete
BEFORE DELETE ON release_approvals
BEGIN
  SELECT RAISE(ABORT, 'release_approvals are append-only');
END;
