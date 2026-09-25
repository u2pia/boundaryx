-- The rows a merge rests on (reviews, checks, evidence, governance decisions) were plain tables: anyone with the
-- database file could rewrite a review's decision or an evidence summary without touching the event chain. They are
-- now append-only except for the one change the Control Plane makes to them: invalidating a row when a new head
-- supersedes it. External checks are the exception, because their reporter updates them in place; every update still
-- records an event, and the merge gate binds each check to its latest event.

CREATE TRIGGER review_decisions_no_delete BEFORE DELETE ON review_decisions
BEGIN SELECT RAISE(ABORT, 'review_decisions are append-only'); END;
CREATE TRIGGER review_decisions_only_invalidate BEFORE UPDATE ON review_decisions
WHEN OLD.invalidated_at IS NOT NULL OR NEW.invalidated_at IS NULL
  OR NEW.id IS NOT OLD.id OR NEW.change_proposal_id IS NOT OLD.change_proposal_id OR NEW.head_sha IS NOT OLD.head_sha
  OR NEW.reviewer_actor_id IS NOT OLD.reviewer_actor_id OR NEW.decision IS NOT OLD.decision OR NEW.comment IS NOT OLD.comment
  OR NEW.created_at IS NOT OLD.created_at OR NEW.decision_latency_seconds IS NOT OLD.decision_latency_seconds
BEGIN SELECT RAISE(ABORT, 'review_decisions are append-only; only invalidation is allowed'); END;

CREATE TRIGGER evidence_packages_no_delete BEFORE DELETE ON evidence_packages
BEGIN SELECT RAISE(ABORT, 'evidence_packages are append-only'); END;
CREATE TRIGGER evidence_packages_only_invalidate BEFORE UPDATE ON evidence_packages
WHEN OLD.invalidated_at IS NOT NULL OR NEW.invalidated_at IS NULL
  OR NEW.id IS NOT OLD.id OR NEW.change_proposal_id IS NOT OLD.change_proposal_id OR NEW.run_id IS NOT OLD.run_id
  OR NEW.head_sha IS NOT OLD.head_sha OR NEW.uri IS NOT OLD.uri OR NEW.sha256 IS NOT OLD.sha256
  OR NEW.summary_json IS NOT OLD.summary_json OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'evidence_packages are append-only; only invalidation is allowed'); END;

CREATE TRIGGER governance_decisions_no_delete BEFORE DELETE ON governance_decisions
BEGIN SELECT RAISE(ABORT, 'governance_decisions are append-only'); END;
CREATE TRIGGER governance_decisions_only_invalidate BEFORE UPDATE ON governance_decisions
WHEN OLD.invalidated_at IS NOT NULL OR NEW.invalidated_at IS NULL
  OR NEW.id IS NOT OLD.id OR NEW.change_proposal_id IS NOT OLD.change_proposal_id OR NEW.head_sha IS NOT OLD.head_sha
  OR NEW.decision_type IS NOT OLD.decision_type OR NEW.criterion_id IS NOT OLD.criterion_id
  OR NEW.overridden_status IS NOT OLD.overridden_status OR NEW.actor_id IS NOT OLD.actor_id OR NEW.reason IS NOT OLD.reason
  OR NEW.evidence_sha256_json IS NOT OLD.evidence_sha256_json OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'governance_decisions are append-only; only invalidation is allowed'); END;

CREATE TRIGGER check_runs_no_delete BEFORE DELETE ON check_runs
BEGIN SELECT RAISE(ABORT, 'check_runs are append-only'); END;
CREATE TRIGGER check_runs_identity_fixed BEFORE UPDATE ON check_runs
WHEN NEW.id IS NOT OLD.id OR NEW.change_proposal_id IS NOT OLD.change_proposal_id OR NEW.head_sha IS NOT OLD.head_sha OR NEW.name IS NOT OLD.name
BEGIN SELECT RAISE(ABORT, 'a check run keeps its proposal, head and name'); END;
-- A result an Agent Run produced is final; the platform only ever invalidates it.
CREATE TRIGGER check_runs_run_results_final BEFORE UPDATE ON check_runs
WHEN OLD.source = 'run' AND (OLD.invalidated_at IS NOT NULL OR NEW.invalidated_at IS NULL
  OR NEW.status IS NOT OLD.status OR NEW.conclusion IS NOT OLD.conclusion OR NEW.evidence_ref IS NOT OLD.evidence_ref
  OR NEW.exit_code IS NOT OLD.exit_code OR NEW.duration_ms IS NOT OLD.duration_ms OR NEW.stdout_digest IS NOT OLD.stdout_digest
  OR NEW.stderr_digest IS NOT OLD.stderr_digest OR NEW.source IS NOT OLD.source OR NEW.run_id IS NOT OLD.run_id
  OR NEW.started_at IS NOT OLD.started_at OR NEW.completed_at IS NOT OLD.completed_at)
BEGIN SELECT RAISE(ABORT, 'check results produced by an Agent Run are final; only invalidation is allowed'); END;

CREATE TRIGGER change_proposals_no_delete BEFORE DELETE ON change_proposals
BEGIN SELECT RAISE(ABORT, 'change_proposals are never deleted'); END;
