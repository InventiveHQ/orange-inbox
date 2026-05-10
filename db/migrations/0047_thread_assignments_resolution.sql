-- Issue #99: assignment resolve/reopen lifecycle + resolved-history view.
--
-- Active assignments (not yet resolved) keep `resolved_at` / `resolved_by`
-- NULL — the existing listAssignedToUser filter (`resolved_at IS NULL`) is
-- what makes /inbox/assigned an active-only list. Resolved rows persist on
-- the same table so the audit trail and the "who closed this out" lookup
-- stay simple — no separate history table to keep in sync.
--
-- `resolved_by` is who clicked Resolve, which is *not* always the assignee
-- (a teammate can resolve on someone else's behalf). FK cascades to NULL on
-- user delete: we'd rather lose the attribution than the historical fact
-- that the assignment was resolved. The assignment row itself is still
-- bound by the existing assignee_id FK CASCADE, so a fully-deleted user
-- still drops their assignments outright.
ALTER TABLE thread_assignments ADD COLUMN resolved_at INTEGER;
ALTER TABLE thread_assignments ADD COLUMN resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL;

-- Index for the resolved-history listing — `listAssignedToUserResolved`
-- orders by resolved_at DESC and filters by assignee_id, so a composite
-- index in that order is the right shape. Partial on `resolved_at IS NOT NULL`
-- keeps the index tight (active assignments dominate the table by row count
-- and don't benefit from being in this index).
CREATE INDEX thread_assignments_resolved
  ON thread_assignments(assignee_id, resolved_at DESC)
  WHERE resolved_at IS NOT NULL;
