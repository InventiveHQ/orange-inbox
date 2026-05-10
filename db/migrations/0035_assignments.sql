-- Issue #27: shared mailbox assignment + internal notes.
--
-- thread_assignments: at most one assignee per thread (PK on thread_id). The
-- assigner ("assigned_by") is recorded for the audit log + future history.
-- Both columns reference users(id) — when a user is removed via cascade, the
-- assignment row disappears so the thread reverts to unassigned.
CREATE TABLE thread_assignments (
  thread_id     TEXT PRIMARY KEY,
  assignee_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX thread_assignments_assignee ON thread_assignments(assignee_id, assigned_at DESC);

-- thread_notes: per-thread internal notes that don't leave the inbox. Rendered
-- inline in ThreadView with a distinct yellow tint and an "Internal note"
-- label. Author can delete their own notes; anyone with mailbox access can see
-- every note on a thread.
CREATE TABLE thread_notes (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX thread_notes_thread ON thread_notes(thread_id, created_at);
