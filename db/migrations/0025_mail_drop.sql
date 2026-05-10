-- Mail Drop: large outbound attachments uploaded to R2 instead of inlined,
-- and replaced in the body with a tokenised download link
-- (https://<host>/d/<token>). Closes #71.
--
-- Lives in control DB. No mail-DB / bootstrap change — share-link bookkeeping
-- is per-user and joins users(id), so it belongs alongside the other
-- control-plane tables. The bytes themselves stay in the existing
-- ATTACHMENTS R2 bucket; this table is just the public-token index.

PRAGMA foreign_keys = ON;

CREATE TABLE r2_share_links (
  id            TEXT PRIMARY KEY,           -- token in the public URL
  r2_bucket     TEXT NOT NULL,              -- 'ATTACHMENTS' for now; future-proofed
  r2_key        TEXT NOT NULL,
  filename      TEXT,
  content_type  TEXT,
  size          INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  max_downloads INTEGER,                    -- NULL = unlimited within ttl
  downloaded    INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX r2_share_links_user ON r2_share_links(created_by, created_at DESC);
