-- ICS export tokens (#83).
--
-- Per-user opaque tokens that grant read-only access to a user's calendar feed
-- as a webcal:// subscription. The token is the ONLY auth — anyone who holds
-- it can poll the feed forever, so we keep rotation cheap (delete + mint).
--
-- `revoked_at` is a soft-delete: rotation sets it on the old row and inserts
-- a new one. We leave revoked rows around so a user can audit whether their
-- last rotation was recent enough.
--
-- `scope` is reserved for future "share just this mailbox" use. v1 only ever
-- writes 'all'.
--
-- `last_used_at` is updated by the feed handler on each successful hit so the
-- settings UI can show a freshness signal ("you haven't used this in 3
-- months, maybe rotate it").
--
-- Lives in control DB. No mail-DB / bootstrap.sql change.

CREATE TABLE user_ics_tokens (
  token        TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope        TEXT NOT NULL DEFAULT 'all',  -- 'all' | mailbox_id
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX user_ics_tokens_user ON user_ics_tokens(user_id);
