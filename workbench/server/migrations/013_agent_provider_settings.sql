-- Which LLM produced a change used to be implicit: the Builder Agent inherited whatever provider the
-- agent CLI's own user-level config happened to point at. That made the provider unconfigurable from
-- the Control Plane, and — worse for review — invisible in the evidence, so a reviewer could not tell
-- which model authored the change under review. The provider is now an operator-owned setting with a
-- single current row, editable from the workbench and written into every run's runtime attestation.
--
-- The API key is stored so the operator can enter it once in the UI; `api_key_env` is the alternative
-- for operators who would rather keep the secret in the server process environment. Exactly one of the
-- two is used, and neither is ever returned by the read API or written into an evidence package.
CREATE TABLE agent_provider_settings (
  id TEXT PRIMARY KEY CHECK (id = 'current'),
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  base_url TEXT NOT NULL,
  wire_api TEXT NOT NULL CHECK (wire_api IN ('responses', 'chat')),
  api_key TEXT,
  api_key_env TEXT,
  reasoning_effort TEXT CHECK (reasoning_effort IN ('minimal', 'low', 'medium', 'high')),
  updated_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  updated_at TEXT NOT NULL
);
