-- Resolve lifecycle on shared-mailbox assignments.
--
-- An assigned thread now has an explicit "resolved" state. The assignment
-- row sticks around after resolve (so "Resolved by Alice on Mon" is
-- visible), but the row is filtered out of /inbox/assigned and the sidebar
-- badge so the active queue stays focused.
--
-- Reopen = clear resolved_at/resolved_by; re-assigning a resolved thread
-- (via assignThread) also clears them implicitly so the lifecycle restarts
-- cleanly under the new assignee.

ALTER TABLE thread_assignments ADD COLUMN resolved_at INTEGER;
ALTER TABLE thread_assignments ADD COLUMN resolved_by TEXT
  REFERENCES users(id) ON DELETE SET NULL;

-- The active-assignment listing reads against this partial index — the full
-- thread_assignments_assignee index (added 0035) still covers history /
-- audit queries that want resolved rows too.
CREATE INDEX thread_assignments_active
  ON thread_assignments(assignee_id, assigned_at DESC)
  WHERE resolved_at IS NULL;
