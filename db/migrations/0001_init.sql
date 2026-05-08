-- orange-inbox initial schema.
-- Multi-domain mail store. One D1 instance can hold mail for many domains and
-- many mailboxes (addresses) per domain. The "All" / Unified inbox is just
-- queries without a mailbox_id filter; per-domain silos add a domain_id filter.

PRAGMA foreign_keys = ON;

-- ----------------------------------------------------------------------------
-- domains: top-level tenants. Each verified Cloudflare Email Routing zone
-- becomes a row here.
-- ----------------------------------------------------------------------------
CREATE TABLE domains (
  id           TEXT PRIMARY KEY,                       -- uuid
  name         TEXT NOT NULL UNIQUE,                   -- "example.com"
  display_name TEXT,                                   -- friendly label
  verified_at  INTEGER,                                -- unix seconds; NULL = pending
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ----------------------------------------------------------------------------
-- mailboxes: a specific address on a domain (hello@example.com, sales@…).
-- Catch-all mailboxes accept anything not matched by a more-specific row.
-- ----------------------------------------------------------------------------
CREATE TABLE mailboxes (
  id             TEXT PRIMARY KEY,
  domain_id      TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  local_part     TEXT NOT NULL,                        -- "hello" for hello@example.com
  display_name   TEXT,                                 -- "From: <display> <addr>"
  signature_html TEXT,
  is_catch_all   INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(domain_id, local_part)
);

CREATE INDEX mailboxes_domain ON mailboxes(domain_id);

-- ----------------------------------------------------------------------------
-- threads: a Gmail-style conversation. Threading uses the standard RFC 5322
-- chain (Message-ID, In-Reply-To, References) with normalized-subject fallback;
-- see the threading helper in shared code (Stage 2).
-- ----------------------------------------------------------------------------
CREATE TABLE threads (
  id                  TEXT PRIMARY KEY,
  mailbox_id          TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  subject_normalized  TEXT NOT NULL,                   -- lowercase, Re:/Fwd: stripped
  last_message_at     INTEGER NOT NULL,
  message_count       INTEGER NOT NULL DEFAULT 0,
  unread_count        INTEGER NOT NULL DEFAULT 0,
  archived            INTEGER NOT NULL DEFAULT 0,
  starred             INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

-- The driving query for the inbox view: "give me the most recent non-archived
-- threads in this mailbox". This composite index is what makes scrolling fast.
CREATE INDEX threads_mailbox_recent
  ON threads(mailbox_id, archived, last_message_at DESC);

-- ----------------------------------------------------------------------------
-- messages: individual emails. We keep small fields inline (snippet, text body,
-- a few JSON addr lists) and push large bodies/attachments to R2.
-- ----------------------------------------------------------------------------
CREATE TABLE messages (
  id                 TEXT PRIMARY KEY,
  thread_id          TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  mailbox_id         TEXT NOT NULL REFERENCES mailboxes(id),
  message_id_header  TEXT NOT NULL,                    -- RFC Message-ID
  in_reply_to        TEXT,
  references_chain   TEXT,                             -- space-separated msg-ids
  direction          TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_addr          TEXT NOT NULL,
  from_name          TEXT,
  to_json            TEXT NOT NULL,                    -- JSON [{addr,name}]
  cc_json            TEXT,
  bcc_json           TEXT,
  subject            TEXT,
  date               INTEGER NOT NULL,                 -- envelope/Date header
  received_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  snippet            TEXT,                             -- first ~200 chars of text/plain
  raw_r2_key         TEXT NOT NULL,                    -- path to .eml in RAW_MAIL
  html_r2_key        TEXT,                             -- big HTML body in RAW_MAIL
  text_body          TEXT,                             -- inline if small
  read               INTEGER NOT NULL DEFAULT 0,
  starred            INTEGER NOT NULL DEFAULT 0
);

-- Same Message-ID can legitimately appear in multiple mailboxes when a
-- message is CC'd to several of our addresses, so the unique constraint is
-- (mailbox, message-id), not message-id alone.
CREATE UNIQUE INDEX messages_mailbox_msgid ON messages(mailbox_id, message_id_header);
CREATE INDEX        messages_thread_date   ON messages(thread_id, date);
CREATE INDEX        messages_mailbox_date  ON messages(mailbox_id, date DESC);

-- ----------------------------------------------------------------------------
-- attachments: one row per file. Bytes live in the ATTACHMENTS R2 bucket.
-- ----------------------------------------------------------------------------
CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename      TEXT,
  content_type  TEXT,
  size          INTEGER NOT NULL,
  inline_cid    TEXT,                                  -- CID for inline images
  r2_key        TEXT NOT NULL
);

CREATE INDEX attachments_message ON attachments(message_id);

-- ----------------------------------------------------------------------------
-- labels (Gmail-style, many-to-many with messages). A label scoped to a
-- specific mailbox shows up only in that silo; mailbox_id NULL = global.
-- ----------------------------------------------------------------------------
CREATE TABLE labels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT,
  mailbox_id  TEXT REFERENCES mailboxes(id) ON DELETE CASCADE,
  UNIQUE(mailbox_id, name)
);

CREATE TABLE message_labels (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label_id   TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, label_id)
);
