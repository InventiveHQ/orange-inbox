-- Per-user upload staging for outbound attachments.
--
-- A client uploads a file via /api/uploads, which stores the bytes in the
-- ATTACHMENTS R2 bucket and inserts a row here. When the user hits Send,
-- the message API references the upload by its id; ownership is verified
-- against user_id before bytes are pulled from R2 into the email builder.
--
-- Rows are intentionally short-lived. A future sweeper should delete rows
-- (and their R2 objects) older than ~24h that are not referenced by a
-- still-saved draft, to keep R2 from growing unboundedly.

PRAGMA foreign_keys = ON;

CREATE TABLE temp_uploads (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename     TEXT,
  content_type TEXT,
  size         INTEGER NOT NULL,
  r2_key       TEXT NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX temp_uploads_user    ON temp_uploads(user_id);
CREATE INDEX temp_uploads_created ON temp_uploads(created_at);
