ALTER TABLE release_candidates ADD COLUMN artifact_class TEXT;
ALTER TABLE release_candidates ADD COLUMN artifact_evidence_json TEXT;
ALTER TABLE release_candidates ADD COLUMN artifact_binding_digest TEXT;

