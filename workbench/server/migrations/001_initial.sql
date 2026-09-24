CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'maintainer', 'reviewer', 'developer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL
);

CREATE TABLE local_credentials (
  actor_id TEXT PRIMARY KEY REFERENCES actors(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_actor ON sessions(actor_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'active', 'review', 'done', 'cancelled')),
  owner_actor_id TEXT NOT NULL REFERENCES actors(id),
  authority_provider TEXT NOT NULL,
  authority_ref TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE intent_versions (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  goal TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  content_digest TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  UNIQUE(work_item_id, version)
);

CREATE TABLE acceptance_criteria (
  id TEXT PRIMARY KEY,
  intent_version_id TEXT NOT NULL REFERENCES intent_versions(id) ON DELETE CASCADE,
  statement TEXT NOT NULL,
  criticality TEXT NOT NULL CHECK (criticality IN ('normal', 'critical')),
  verification_type TEXT NOT NULL CHECK (verification_type IN ('deterministic', 'model', 'human')),
  ordinal INTEGER NOT NULL,
  UNIQUE(intent_version_id, ordinal)
);

CREATE TABLE change_proposals (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  intent_version_id TEXT NOT NULL REFERENCES intent_versions(id),
  run_id TEXT,
  repository_path TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  author_actor_id TEXT NOT NULL REFERENCES actors(id),
  status TEXT NOT NULL CHECK (status IN ('draft', 'review_ready', 'changes_requested', 'approved', 'merged', 'closed')),
  changed_files INTEGER NOT NULL,
  additions INTEGER NOT NULL,
  deletions INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_change_proposals_work_item ON change_proposals(work_item_id);
CREATE INDEX idx_change_proposals_head ON change_proposals(head_sha);

CREATE TABLE check_runs (
  id TEXT PRIMARY KEY,
  change_proposal_id TEXT NOT NULL REFERENCES change_proposals(id) ON DELETE CASCADE,
  head_sha TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'in_progress', 'completed')),
  conclusion TEXT CHECK (conclusion IN ('success', 'failure', 'neutral', 'cancelled')),
  evidence_ref TEXT,
  invalidated_at TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(change_proposal_id, head_sha, name)
);

CREATE TABLE evidence_packages (
  id TEXT PRIMARY KEY,
  change_proposal_id TEXT NOT NULL REFERENCES change_proposals(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  uri TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  invalidated_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_evidence_proposal_head ON evidence_packages(change_proposal_id, head_sha);

CREATE TABLE review_decisions (
  id TEXT PRIMARY KEY,
  change_proposal_id TEXT NOT NULL REFERENCES change_proposals(id) ON DELETE CASCADE,
  head_sha TEXT NOT NULL,
  reviewer_actor_id TEXT NOT NULL REFERENCES actors(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested', 'commented')),
  comment TEXT NOT NULL,
  invalidated_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_review_proposal_head ON review_decisions(change_proposal_id, head_sha);

CREATE TABLE domain_events (
  id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_id TEXT REFERENCES actors(id),
  payload_json TEXT NOT NULL,
  previous_event_digest TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  correlation_id TEXT,
  causation_id TEXT,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE(aggregate_type, aggregate_id, aggregate_version)
);

CREATE INDEX idx_domain_events_aggregate ON domain_events(aggregate_type, aggregate_id, aggregate_version);
CREATE INDEX idx_domain_events_recorded ON domain_events(recorded_at);

CREATE TRIGGER domain_events_no_update
BEFORE UPDATE ON domain_events
BEGIN
  SELECT RAISE(ABORT, 'domain_events are append-only');
END;

CREATE TRIGGER domain_events_no_delete
BEFORE DELETE ON domain_events
BEGIN
  SELECT RAISE(ABORT, 'domain_events are append-only');
END;
