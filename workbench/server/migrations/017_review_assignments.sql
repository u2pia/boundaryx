-- DOMAIN_MODEL.md §5.8: a Review Assignment names who owns the review of a proposal, by when, and whether they opened
-- the evidence before deciding. At most one assignment is active per proposal; reassigning ends the old record
-- (status 'reassigned') and inserts a new one, so the history of who held the review is never overwritten.
--
-- cycle_started_at restarts when a new head revision resets the assignment, so time_spent_seconds measures the
-- reviewer's time on the revision they decided, not the time the proposal spent in rework.
CREATE TABLE review_assignments (
  id TEXT PRIMARY KEY,
  change_proposal_id TEXT NOT NULL REFERENCES change_proposals(id) ON DELETE CASCADE,
  assignee_actor_id TEXT NOT NULL REFERENCES actors(id),
  assigned_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  basis TEXT NOT NULL CHECK (basis IN ('manual', 'self_claim', 'load_balanced')),
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_review', 'changes_requested', 'approved', 'reassigned')),
  head_sha TEXT NOT NULL,
  reassigned_from TEXT REFERENCES review_assignments(id),
  assigned_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  cycle_started_at TEXT NOT NULL,
  evidence_opened_at TEXT,
  decided_at TEXT,
  time_spent_seconds INTEGER,
  ended_at TEXT
);

CREATE INDEX idx_review_assignments_assignee ON review_assignments(assignee_actor_id, status);
CREATE UNIQUE INDEX idx_review_assignment_active ON review_assignments(change_proposal_id) WHERE status != 'reassigned';
