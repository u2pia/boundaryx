-- Checks must carry their origin so that a reviewer can tell a Control Plane run
-- result apart from a self-reported external result, and so that a run-produced
-- check can never be silently overwritten through the public API.
ALTER TABLE check_runs ADD COLUMN source TEXT NOT NULL DEFAULT 'external' CHECK (source IN ('run', 'external'));
ALTER TABLE check_runs ADD COLUMN run_id TEXT;
