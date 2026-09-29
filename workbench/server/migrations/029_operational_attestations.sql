CREATE TABLE operational_attestations (
  id TEXT PRIMARY KEY,
  attestation_type TEXT NOT NULL CHECK (attestation_type IN ('backup_restore_drill')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('control_plane')),
  subject_id TEXT NOT NULL,
  evidence_uri TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  performed_at TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  attested_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  identity_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_operational_attestations_type_validity ON operational_attestations(attestation_type, valid_until DESC);

CREATE TABLE operational_attestation_revocations (
  id TEXT PRIMARY KEY,
  operational_attestation_id TEXT NOT NULL UNIQUE REFERENCES operational_attestations(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  revoked_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  identity_json TEXT NOT NULL,
  revoked_at TEXT NOT NULL
);

CREATE TRIGGER operational_attestations_no_update BEFORE UPDATE ON operational_attestations BEGIN SELECT RAISE(ABORT, 'operational attestations are append-only'); END;
CREATE TRIGGER operational_attestations_no_delete BEFORE DELETE ON operational_attestations BEGIN SELECT RAISE(ABORT, 'operational attestations are append-only'); END;
CREATE TRIGGER operational_attestation_revocations_no_update BEFORE UPDATE ON operational_attestation_revocations BEGIN SELECT RAISE(ABORT, 'operational attestation revocations are append-only'); END;
CREATE TRIGGER operational_attestation_revocations_no_delete BEFORE DELETE ON operational_attestation_revocations BEGIN SELECT RAISE(ABORT, 'operational attestation revocations are append-only'); END;
