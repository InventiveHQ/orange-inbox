-- Bootstrap schema for an OVERFLOW mail database.
--
-- This is the subset of the primary DB's schema that the mail plane needs:
-- threads, messages, attachments, message_labels, and the FTS5 index +
-- triggers. Run this once against each newly-provisioned overflow D1 (the
-- scripts/provision-overflow.sh helper does it for you).
--
-- Control-plane tables (users, mailboxes, domains, drafts, contacts,
-- canned_responses, labels, mail_dbs, thread_locations, threads_index,
-- thread_labels, scheduled_messages, temp_uploads) are NOT created here —
-- they live exclusively in the primary DB.
--
-- Foreign keys to control-plane tables (e.g. mailbox_id) are NOT enforced
-- here because the referenced tables don't exist in this DB. Integrity is
-- maintained at the application layer.

PRAGMA foreign_keys = ON;

CREATE TABLE threads (
  id                  TEXT PRIMARY KEY,
  mailbox_id          TEXT NOT NULL,
  subject_normalized  TEXT NOT NULL,
  last_message_at     INTEGER NOT NULL,
  message_count       INTEGER NOT NULL DEFAULT 0,
  unread_count        INTEGER NOT NULL DEFAULT 0,
  archived            INTEGER NOT NULL DEFAULT 0,
  starred             INTEGER NOT NULL DEFAULT 0,
  snoozed_until       INTEGER,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX threads_mailbox_recent
  ON threads(mailbox_id, archived, last_message_at DESC);
CREATE INDEX threads_snoozed ON threads(snoozed_until)
  WHERE snoozed_until IS NOT NULL;

CREATE TABLE messages (
  id                 TEXT PRIMARY KEY,
  thread_id          TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  mailbox_id         TEXT NOT NULL,
  message_id_header  TEXT NOT NULL,
  in_reply_to        TEXT,
  references_chain   TEXT,
  direction          TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_addr          TEXT NOT NULL,
  from_name          TEXT,
  to_json            TEXT NOT NULL,
  cc_json            TEXT,
  bcc_json           TEXT,
  subject            TEXT,
  date               INTEGER NOT NULL,
  received_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  snippet            TEXT,
  raw_r2_key         TEXT NOT NULL,
  html_r2_key        TEXT,
  text_body          TEXT,
  read               INTEGER NOT NULL DEFAULT 0,
  starred            INTEGER NOT NULL DEFAULT 0,
  sent_by_user_id    TEXT,
  spam_reported_by_user_id TEXT,
  -- 0018_message_trust: per-message trust signals.
  --   auth_results   — JSON {spf,dkim,dmarc,from_domain} parsed from the
  --                    inbound Authentication-Results header; NULL if the
  --                    header was absent or unparseable.
  --   first_contact  — 1 when this is the first message in this mailbox
  --                    from from_addr (set at ingest, never updated after).
  --   reply_to_addr  — Reply-To header, but only when it differs from
  --                    from_addr; NULL otherwise.
  auth_results       TEXT,
  first_contact      INTEGER NOT NULL DEFAULT 0,
  reply_to_addr      TEXT
);
CREATE UNIQUE INDEX messages_mailbox_msgid ON messages(mailbox_id, message_id_header);
CREATE INDEX        messages_thread_date   ON messages(thread_id, date);
CREATE INDEX        messages_mailbox_date  ON messages(mailbox_id, date DESC);
CREATE INDEX messages_sent_by ON messages(sent_by_user_id) WHERE sent_by_user_id IS NOT NULL;
CREATE INDEX messages_spam_reported ON messages(spam_reported_by_user_id)
  WHERE spam_reported_by_user_id IS NOT NULL;

CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename      TEXT,
  content_type  TEXT,
  size          INTEGER NOT NULL,
  inline_cid    TEXT,
  r2_key        TEXT NOT NULL
);
CREATE INDEX attachments_message ON attachments(message_id);

-- Per-message labels. The label_id references labels in the control DB —
-- not enforced as a foreign key here for the cross-DB reasons above.
CREATE TABLE message_labels (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label_id   TEXT NOT NULL,
  PRIMARY KEY (message_id, label_id)
);

-- Full-text search index — same shape as 0006_search.sql in the primary.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject,
  snippet,
  text_body,
  content=messages,
  content_rowid=rowid,
  tokenize="unicode61 remove_diacritics 2"
);

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, snippet, text_body)
    VALUES (new.rowid, new.subject, new.snippet, new.text_body);
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, snippet, text_body)
    VALUES ('delete', old.rowid, old.subject, old.snippet, old.text_body);
END;

CREATE TRIGGER messages_au AFTER UPDATE OF subject, snippet, text_body ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, snippet, text_body)
    VALUES ('delete', old.rowid, old.subject, old.snippet, old.text_body);
  INSERT INTO messages_fts(rowid, subject, snippet, text_body)
    VALUES (new.rowid, new.subject, new.snippet, new.text_body);
END;
