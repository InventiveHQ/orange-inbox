-- Lives in control DB. No mail-DB / bootstrap change needed.
--
-- Per-mailbox vacation / out-of-office auto-responder. The email-worker
-- consults `mailbox_autoresponders` after a message lands and (when the
-- responder is enabled, the date window covers `now`, and none of the
-- RFC 3834 anti-loop checks trip) calls back into the web worker via the
-- service binding to actually send the canned reply.
--
-- `mailbox_autoresponder_log` is the cooldown ledger: one row per
-- (mailbox, recipient, sent_at). The anti-loop check looks for a row in
-- the past `cooldown_hours` so we don't spam the same correspondent on
-- every inbound during the window.

CREATE TABLE mailbox_autoresponders (
  mailbox_id     TEXT PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
  enabled        INTEGER NOT NULL DEFAULT 0,
  starts_at      INTEGER,                   -- unix seconds; NULL = no lower bound
  ends_at        INTEGER,                   -- unix seconds; NULL = no upper bound
  subject        TEXT NOT NULL,
  body_text      TEXT NOT NULL,
  body_html      TEXT,
  cooldown_hours INTEGER NOT NULL DEFAULT 24
);

CREATE TABLE mailbox_autoresponder_log (
  mailbox_id  TEXT NOT NULL,
  to_addr     TEXT NOT NULL,
  sent_at     INTEGER NOT NULL,
  PRIMARY KEY (mailbox_id, to_addr, sent_at)
);
CREATE INDEX mailbox_autoresponder_log_recent ON mailbox_autoresponder_log(mailbox_id, to_addr, sent_at DESC);
