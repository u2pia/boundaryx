-- DOMAIN_MODEL.md §6.4: Reject and Override are Decisions, and every Decision names its Actor, time, object,
-- reason and the Evidence Version it relied on. Approve and RequestChanges stay in review_decisions; the two
-- decisions that end or bypass a gate get their own table so they can never be mistaken for a review.
--
-- An override waives one critical acceptance criterion's blocking status at one head revision. It is
-- invalidated with the head, exactly like the checks and evidence it was judged against.
CREATE TABLE governance_decisions (
  id TEXT PRIMARY KEY,
  change_proposal_id TEXT NOT NULL REFERENCES change_proposals(id) ON DELETE CASCADE,
  head_sha TEXT NOT NULL,
  decision_type TEXT NOT NULL CHECK (decision_type IN ('override', 'reject')),
  criterion_id TEXT,
  overridden_status TEXT,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  reason TEXT NOT NULL,
  evidence_sha256_json TEXT NOT NULL,
  invalidated_at TEXT,
  created_at TEXT NOT NULL,
  CHECK ((decision_type = 'override') = (criterion_id IS NOT NULL))
);

CREATE INDEX idx_governance_decisions_proposal_head ON governance_decisions(change_proposal_id, head_sha);
CREATE UNIQUE INDEX idx_governance_override_active ON governance_decisions(change_proposal_id, head_sha, criterion_id) WHERE decision_type = 'override' AND invalidated_at IS NULL;
