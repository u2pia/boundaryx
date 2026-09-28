-- An Intent can be drafted by the configured LLM and edited by the developer before it is submitted. The draft is
-- kept as the model returned it (after normalisation), so an Intent version can say which draft it started from and
-- which parts a person changed. Neither column enters the content digest: they record where the text came from, not
-- what was approved.
CREATE TABLE intent_drafts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  created_by TEXT NOT NULL REFERENCES actors(id),
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  product_type TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  reply_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER intent_drafts_no_delete BEFORE DELETE ON intent_drafts
BEGIN SELECT RAISE(ABORT, 'intent_drafts are append-only'); END;
CREATE TRIGGER intent_drafts_no_update BEFORE UPDATE ON intent_drafts
BEGIN SELECT RAISE(ABORT, 'intent_drafts are append-only'); END;

ALTER TABLE intent_versions ADD COLUMN draft_id TEXT REFERENCES intent_drafts(id);
-- The fields of the submitted Intent that differ from the draft, as a JSON array; [] means submitted unchanged.
ALTER TABLE intent_versions ADD COLUMN draft_changes_json TEXT;
