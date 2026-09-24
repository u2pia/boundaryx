-- DOMAIN_MODEL.md §6.1: only an Approved Intent may create a production Run. V0.3 §10.1 lets a low risk Intent
-- become Ready through a lightweight rule; medium and high risk need a named approver who is not the author.
--
-- The approval binds to the version's content_digest, so editing an Intent means a new version and a new approval.
-- A newer version supersedes the older ones: a run started against a stale Intent would build the wrong thing.
ALTER TABLE intent_versions ADD COLUMN status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded'));
ALTER TABLE intent_versions ADD COLUMN approved_by TEXT REFERENCES actors(id);
ALTER TABLE intent_versions ADD COLUMN approved_at TEXT;
ALTER TABLE intent_versions ADD COLUMN approval_basis TEXT CHECK (approval_basis IS NULL OR approval_basis IN ('low_risk_rule', 'named_approval'));
ALTER TABLE intent_versions ADD COLUMN approval_comment TEXT;

-- Backfill truthfully: low risk versions met the rule when they were written; medium and high risk were never
-- approved by anyone, so they stay draft rather than being given a fabricated approver.
UPDATE intent_versions SET status = 'approved', approved_at = created_at, approval_basis = 'low_risk_rule' WHERE risk_level = 'low';
UPDATE intent_versions SET status = 'superseded' WHERE EXISTS (SELECT 1 FROM intent_versions newer WHERE newer.work_item_id = intent_versions.work_item_id AND newer.version > intent_versions.version);
