-- Drafts: in-progress outbound messages saved by a user before sending.
-- Drafts are owned by the user (only the author can see/edit), but they
-- carry a mailbox_id so the From address survives a reload. ON DELETE
-- CASCADE on both user_id and mailbox_id keeps things tidy when access
-- changes.

PRAGMA foreign_keys = ON;

CREATE TABLE drafts (
  id                   TEXT PRIMARY KEY,                   -- uuid
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id           TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  to_json              TEXT,                               -- JSON array of strings
  cc_json              TEXT,
  bcc_json             TEXT,
  subject              TEXT,
  body                 TEXT,
  reply_to_message_id  TEXT,                               -- soft ref; original may be deleted
  created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at           INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Drafts list is "my drafts, newest first".
CREATE INDEX drafts_user_recent ON drafts(user_id, updated_at DESC);
