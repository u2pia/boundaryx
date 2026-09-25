-- DOMAIN_MODEL.md §5.6: the AC → check mapping may come from a person. An Intent author can name the checks that prove
-- a criterion; NULL keeps the deterministic rule. The value is part of the Intent's content digest when present.
ALTER TABLE acceptance_criteria ADD COLUMN verified_by_json TEXT;
