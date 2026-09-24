-- DOMAIN_MODEL.md §9.1.1: the agent has write access to the repository, so it can edit the files that govern it.
-- Every proposal records which `.aperture/` files its head changes relative to its base, so the change is marked in
-- the review queue and its approval is held to a stricter rule.
--
-- NULL means "not scanned": proposals created before this migration were never diffed, and an empty list would
-- falsely claim that they touched no policy file. The next refresh fills the column in.
ALTER TABLE change_proposals ADD COLUMN policy_files_json TEXT;
