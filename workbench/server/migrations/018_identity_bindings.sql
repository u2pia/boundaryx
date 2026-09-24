-- DOMAIN_MODEL.md invariant 10: identity cannot be self-asserted. A human Actor is bound to at most one external
-- identity; the Owner declares which login is expected, and only the provider can prove it. After the first proof the
-- provider's numeric subject is pinned, so a renamed or recycled login cannot take the binding over.
--
-- Nothing here is GitHub-specific in shape: `provider` is a column, not a table name, and every column that only
-- exists after a proof (subject, login, verified_at) is nullable. V0.3: the core schema must not require GitHub fields.
CREATE TABLE identity_bindings (
  actor_id TEXT PRIMARY KEY REFERENCES actors(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github')),
  expected_login TEXT NOT NULL,
  subject TEXT,
  login TEXT,
  verified_at TEXT,
  declared_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  declared_at TEXT NOT NULL,
  CHECK ((subject IS NULL) = (verified_at IS NULL))
);

CREATE UNIQUE INDEX idx_identity_bindings_subject ON identity_bindings(provider, subject) WHERE subject IS NOT NULL;
CREATE UNIQUE INDEX idx_identity_bindings_expected ON identity_bindings(provider, lower(expected_login));

-- V0.3 §8.3 trust modes. Development accepts local, self-asserted identities and marks them as such; Team requires
-- every decision to come from a session proven by the external provider. One row, changed only by an event.
CREATE TABLE identity_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('development', 'team')),
  updated_by_actor_id TEXT REFERENCES actors(id),
  updated_at TEXT NOT NULL
);

INSERT INTO identity_settings(id, mode, updated_at) VALUES (1, 'development', '1970-01-01T00:00:00.000Z');

-- How a session was proven. Existing sessions were all password sessions.
ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password' CHECK (auth_method IN ('password', 'github'));

-- One-time OAuth state. Only its hash is stored; the PKCE verifier never leaves the server. Access tokens are
-- never stored anywhere.
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
