-- Event digests are unkeyed: whoever holds the database file can append a forged event that chains correctly. Every
-- event now also carries a seal, an HMAC of its id and digest under a key kept outside the database. Events that
-- existed when this migration ran are sealed once, here, and marked backfilled; an event without a seal after that was
-- written around the Control Plane. Seals are never updated or deleted.

CREATE TABLE event_seals (
  event_id TEXT PRIMARY KEY REFERENCES domain_events(id),
  key_id TEXT NOT NULL,
  seal TEXT NOT NULL,
  backfilled INTEGER NOT NULL DEFAULT 0 CHECK (backfilled IN (0, 1)),
  sealed_at TEXT NOT NULL
);

CREATE TRIGGER event_seals_no_update BEFORE UPDATE ON event_seals
BEGIN SELECT RAISE(ABORT, 'event_seals are append-only'); END;
CREATE TRIGGER event_seals_no_delete BEFORE DELETE ON event_seals
BEGIN SELECT RAISE(ABORT, 'event_seals are append-only'); END;
