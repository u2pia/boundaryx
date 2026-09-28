-- BUILDER_CONTEXT_TOOLS_SKILLS_DESIGN.md §3.8: an Intent can say what is out of scope and give input/expected
-- examples. Both are part of the content digest when present, so approving the Intent approves them; NULL keeps
-- an Intent's digest what it was before these fields existed.
ALTER TABLE intent_versions ADD COLUMN non_goals_json TEXT;
ALTER TABLE intent_versions ADD COLUMN examples_json TEXT;
