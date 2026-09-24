ALTER TABLE agent_runs ADD COLUMN runtime_image_ref TEXT;
ALTER TABLE agent_runs ADD COLUMN runtime_attestation_digest TEXT;
ALTER TABLE agent_runs ADD COLUMN network_egress TEXT NOT NULL DEFAULT 'unrestricted' CHECK (network_egress IN ('denied', 'allowlist', 'unrestricted'));
ALTER TABLE agent_runs ADD COLUMN production_eligible INTEGER NOT NULL DEFAULT 0 CHECK (production_eligible IN (0, 1));
