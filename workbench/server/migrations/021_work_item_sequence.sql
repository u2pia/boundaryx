-- Work items get a number within their project, like an issue number, so a team can say "#3" instead of an id.
-- Existing items are numbered in the order they were created; the number never changes or gets reused.
ALTER TABLE work_items ADD COLUMN sequence INTEGER;
UPDATE work_items SET sequence = (
  SELECT COUNT(*) FROM work_items AS earlier
  WHERE earlier.project_id IS work_items.project_id
    AND (earlier.created_at < work_items.created_at OR (earlier.created_at = work_items.created_at AND earlier.rowid <= work_items.rowid))
);
CREATE UNIQUE INDEX work_items_project_sequence ON work_items(project_id, sequence);
