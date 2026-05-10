-- Lives in control DB. No mail-DB / bootstrap change.
--
-- Confidential mode (#66) — Gmail-style. The recipient receives a placeholder
-- email body ("{sender} sent you a confidential message — view at <url>")
-- while the actual message text/HTML is held server-side in this table. The
-- token in the public /c/<token> URL doubles as the row id (cryptographically
-- random UUID), so possession of the link is the only thing required to view.
--
-- view_passcode is optional, 4-digit, set by the sender out-of-band. Empty
-- string is not the same as NULL: NULL means "no passcode prompt", a stored
-- value means "the view page must collect a matching 4-digit code first".
--
-- We track views (incremented on each successful render) and a revoked flag
-- (settable later by the sender from their outbound message header) so the
-- /c/<token> route can return 410 Gone without leaking content.

CREATE TABLE confidential_messages (
  id              TEXT PRIMARY KEY,            -- token in the public URL
  source_message_id TEXT NOT NULL,              -- our outbound id
  body_text       TEXT NOT NULL,
  body_html       TEXT,
  expires_at      INTEGER NOT NULL,
  view_passcode   TEXT,                         -- 4-digit, NULL if none
  views           INTEGER NOT NULL DEFAULT 0,
  revoked         INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX confidential_messages_expires ON confidential_messages(expires_at);
