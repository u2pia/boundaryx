ALTER TABLE work_items ADD COLUMN product_type TEXT NOT NULL DEFAULT 'application' CHECK (product_type IN ('application', 'agent_system'));
