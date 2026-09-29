-- A Decision Brief view is an adoption measurement, not an approval. It is bound to the reviewer and exact head
-- revision, recorded once, and never updated so repeated refreshes cannot manufacture shorter review times.
CREATE TABLE decision_brief_views (
  id TEXT PRIMARY KEY,
  change_proposal_id TEXT NOT NULL REFERENCES change_proposals(id) ON DELETE CASCADE,
  head_sha TEXT NOT NULL,
  reviewer_actor_id TEXT NOT NULL REFERENCES actors(id),
  viewed_at TEXT NOT NULL,
  UNIQUE(change_proposal_id, head_sha, reviewer_actor_id)
);

CREATE INDEX idx_decision_brief_views_reviewer ON decision_brief_views(reviewer_actor_id, viewed_at);

CREATE TRIGGER decision_brief_views_no_update BEFORE UPDATE ON decision_brief_views
BEGIN SELECT RAISE(ABORT, 'decision_brief_views are append-only'); END;

CREATE TRIGGER decision_brief_views_no_delete BEFORE DELETE ON decision_brief_views
BEGIN SELECT RAISE(ABORT, 'decision_brief_views are append-only'); END;
