-- Issue #28: per-mailbox audit log. Records who did what to which thread so
-- shared-mailbox members can see the trail (assign, archive, label,
-- internal-note, reply, etc.). Per-mailbox view rendered by AuditLogView; only
-- members of the mailbox can read it. `thread_id` is nullable because some
-- future actions may be mailbox-level (member added etc.); `payload` is a JSON
-- blob whose shape depends on the action.
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  mailbox_id  TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id   TEXT,
  action      TEXT NOT NULL,
  payload     TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX audit_log_mailbox ON audit_log(mailbox_id, created_at DESC);
CREATE INDEX audit_log_user    ON audit_log(user_id, created_at DESC);
CREATE INDEX audit_log_thread  ON audit_log(thread_id, created_at DESC);
