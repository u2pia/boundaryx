ALTER TABLE check_runs ADD COLUMN exit_code INTEGER;
ALTER TABLE check_runs ADD COLUMN duration_ms INTEGER;
ALTER TABLE check_runs ADD COLUMN stdout_digest TEXT;
ALTER TABLE check_runs ADD COLUMN stderr_digest TEXT;

CREATE TABLE evidence_views (
  id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL REFERENCES evidence_packages(id) ON DELETE CASCADE,
  reviewer_actor_id TEXT NOT NULL REFERENCES actors(id),
  viewed_sha256 TEXT NOT NULL,
  viewed_at TEXT NOT NULL,
  UNIQUE(evidence_id, reviewer_actor_id, viewed_sha256)
);

CREATE INDEX idx_evidence_views_evidence ON evidence_views(evidence_id, viewed_at);
CREATE INDEX idx_evidence_views_reviewer ON evidence_views(reviewer_actor_id, viewed_at);
