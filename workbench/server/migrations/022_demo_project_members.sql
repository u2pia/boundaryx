-- The default project holds the workbench's sample data, and everyone sees it: every existing non-owner member joins
-- it with their team role. Owners are implicit members of every project and never appear here.
INSERT OR IGNORE INTO project_members(project_id, actor_id, role, added_by_actor_id, added_at)
SELECT 'PRJ-DEFAULT', id, role, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM actors
WHERE role != 'owner' AND username NOT LIKE 'system:%';
