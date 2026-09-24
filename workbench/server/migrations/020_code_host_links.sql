-- migrate:foreign-keys-off (merge_evidence is rebuilt below; release_candidates keeps referencing it by name)
-- A hosted project publishes each proposal as a pull request. The link lives beside the proposal rather than in it
-- (V0.3 §8.2: no host-specific fields in the core schema), and is only bookkeeping: the proposal, its reviews and its
-- gate stay the authority, and losing this table loses nothing but the pointer to the host's copy.
CREATE TABLE code_host_links (
  change_proposal_id TEXT PRIMARY KEY REFERENCES change_proposals(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  provider TEXT NOT NULL CHECK (provider IN ('github')),
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  -- The branch the platform pushes the approved head to; stable across revisions so the pull request survives them.
  published_ref TEXT NOT NULL,
  head_sha_published TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'merged', 'closed')),
  gate_state_published TEXT CHECK (gate_state_published IN ('pending', 'success', 'failure')),
  gate_sha_published TEXT,
  gate_description_published TEXT,
  last_error TEXT,
  synced_at TEXT NOT NULL
);

CREATE INDEX idx_code_host_links_project ON code_host_links(project_id, state);

-- `host_merge`: the host merged under its own branch protection and the platform recorded it afterwards. What the
-- host reported, and why the merge counts as outside the gate if it does, is kept alongside and folded into the
-- evidence digest, so a later reader cannot quietly turn an unapproved host merge into an approved one.
CREATE TABLE merge_evidence_next (
  id TEXT PRIMARY KEY,
  change_proposal_id TEXT NOT NULL UNIQUE REFERENCES change_proposals(id) ON DELETE CASCADE,
  base_ref TEXT NOT NULL,
  base_sha_before TEXT NOT NULL,
  approved_head_sha TEXT NOT NULL,
  merged_sha TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('fast_forward', 'host_merge')),
  approval_review_ids_json TEXT NOT NULL,
  check_ids_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  proposal_event_chain_head TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  merged_by_actor_id TEXT NOT NULL REFERENCES actors(id),
  merged_at TEXT NOT NULL,
  host_merge_json TEXT
);
INSERT INTO merge_evidence_next(id, change_proposal_id, base_ref, base_sha_before, approved_head_sha, merged_sha, strategy, approval_review_ids_json, check_ids_json, evidence_ids_json, proposal_event_chain_head, evidence_digest, merged_by_actor_id, merged_at)
  SELECT id, change_proposal_id, base_ref, base_sha_before, approved_head_sha, merged_sha, strategy, approval_review_ids_json, check_ids_json, evidence_ids_json, proposal_event_chain_head, evidence_digest, merged_by_actor_id, merged_at FROM merge_evidence;
DROP TABLE merge_evidence;
ALTER TABLE merge_evidence_next RENAME TO merge_evidence;
CREATE INDEX idx_merge_evidence_actor ON merge_evidence(merged_by_actor_id, merged_at);
CREATE TRIGGER merge_evidence_no_update BEFORE UPDATE ON merge_evidence BEGIN SELECT RAISE(ABORT, 'merge_evidence is append-only'); END;
CREATE TRIGGER merge_evidence_no_delete BEFORE DELETE ON merge_evidence BEGIN SELECT RAISE(ABORT, 'merge_evidence is append-only'); END;

-- The actor the syncer records host facts under: imported checks, host merges, pull requests closed on the host. It
-- cannot sign in (no credential, disabled) and as a developer it can never approve or merge anything itself.
INSERT INTO actors(id, username, display_name, role, status, created_at)
VALUES ('ACT-SYSTEM-CODE-HOST', 'system:code-host', 'Code Host Sync', 'developer', 'disabled', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
