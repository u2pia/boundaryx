ALTER TABLE change_proposals ADD COLUMN review_cycle_started_at TEXT;
UPDATE change_proposals SET review_cycle_started_at = created_at WHERE review_cycle_started_at IS NULL;

ALTER TABLE review_decisions ADD COLUMN decision_latency_seconds INTEGER NOT NULL DEFAULT 0;
UPDATE review_decisions
SET decision_latency_seconds = MAX(
  0,
  CAST((julianday(created_at) - julianday((
    SELECT created_at
    FROM change_proposals
    WHERE change_proposals.id = review_decisions.change_proposal_id
  ))) * 86400 AS INTEGER)
);
