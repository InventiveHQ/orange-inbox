-- Per-mailbox access for personal vs shared inboxes.
--
-- Until now, access was per-domain via `user_domain_access` (controls who can
-- administer the domain) and that doubled as the read filter. That meant
-- every user with access to a domain saw every mailbox on it — no notion of
-- "this is Alice's personal inbox" vs "support@ that the team shares".
--
-- After this migration:
--   user_domain_access  → only governs domain-admin powers
--                         (create/delete mailboxes, grant access).
--   user_mailbox_access → governs read/send for a specific mailbox.
--                         A mailbox with one row is "personal"; with
--                         several rows it's "shared".
--
-- Roles:
--   owner   — read/send + invite/remove members + delete the mailbox
--   member  — read/send
--   reader  — read only (cannot send)

PRAGMA foreign_keys = ON;

CREATE TABLE user_mailbox_access (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner','member','reader')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, mailbox_id)
);

CREATE INDEX user_mailbox_access_mailbox ON user_mailbox_access(mailbox_id);

-- Internal attribution for shared mailboxes: which user actually clicked
-- Send. Outbound MIME headers stay unified (recipients see "support@…",
-- not "Alice on behalf of support@…"), but we surface the sender inside
-- the orange-inbox UI for team accountability.
ALTER TABLE messages ADD COLUMN sent_by_user_id TEXT;

CREATE INDEX messages_sent_by ON messages(sent_by_user_id) WHERE sent_by_user_id IS NOT NULL;

-- Backfill: every existing user-domain access becomes owner on every
-- mailbox in that domain. Existing single-user behavior is preserved.
INSERT INTO user_mailbox_access (user_id, mailbox_id, role)
SELECT uda.user_id, mb.id, 'owner'
  FROM user_domain_access uda
  INNER JOIN mailboxes mb ON mb.domain_id = uda.domain_id;
