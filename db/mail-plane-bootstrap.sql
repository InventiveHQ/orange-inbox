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
  created_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX threads_mailbox_recent
  ON threads(mailbox_id, archived, last_message_at DESC);

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
  reply_to_addr      TEXT,
  -- 0019_list_unsubscribe: List-Unsubscribe metadata (RFC 2369 / 8058)
  -- extracted at ingest so the Subscriptions page can aggregate per-sender
  -- without re-parsing.
  list_unsub_url     TEXT,
  list_unsub_mailto  TEXT,
  list_unsub_one_click INTEGER NOT NULL DEFAULT 0,
  unsubscribed_at    INTEGER,
  -- 0027_message_categories: heuristic auto-categorization at ingest
  -- (one of 'primary' / 'promotions' / 'updates' / 'social' / 'forums').
  -- NULL on rows ingested before the categorizer landed; the listing query
  -- treats NULL as Primary so the column can be added without a backfill.
  category           TEXT,
  -- 0033_read_tracking: per-message opt-in read-receipt token. Non-null when
  -- the sender enabled "Track opens" in the composer; the outbound HTML body
  -- carries a <img src="/api/track/<token>.png"> that the recipient's mail
  -- client fetches on display. Open events live in the control DB
  -- (message_read_events) — see migration 0033 for details.
  tracking_token     TEXT,
  -- 0037_triage_axes: two-axis triage classifier set at ingest (see
  -- email-worker/src/triage.ts). is_marketing flags bulk/promotional mail;
  -- is_action_item flags messages the user likely needs to act on. The
  -- web triage bar filters the unified inbox into four quadrants over
  -- these two columns.
  is_marketing       INTEGER NOT NULL DEFAULT 0,
  is_action_item     INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX messages_mailbox_msgid ON messages(mailbox_id, message_id_header);
CREATE INDEX        messages_thread_date   ON messages(thread_id, date);
CREATE INDEX        messages_mailbox_date  ON messages(mailbox_id, date DESC);
CREATE INDEX messages_sent_by ON messages(sent_by_user_id) WHERE sent_by_user_id IS NOT NULL;
CREATE INDEX messages_spam_reported ON messages(spam_reported_by_user_id)
  WHERE spam_reported_by_user_id IS NOT NULL;
CREATE INDEX messages_list_unsub
  ON messages(mailbox_id, from_addr)
  WHERE list_unsub_url IS NOT NULL OR list_unsub_mailto IS NOT NULL;
CREATE INDEX messages_category_date ON messages(category, date DESC);
-- 0031_triage_axes: compound index for the triage listing (filter by
-- both axes per-mailbox, order by date desc).
CREATE INDEX messages_triage
  ON messages(mailbox_id, is_marketing, is_action_item, date DESC);

CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename      TEXT,
  content_type  TEXT,
  size          INTEGER NOT NULL,
  inline_cid    TEXT,
  r2_key        TEXT NOT NULL,
  is_executable INTEGER NOT NULL DEFAULT 0
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

-- 0026_calendar_events: inline calendar invites (#70). Populated at ingest by
-- the email-worker when the message has a text/calendar attachment; the web
-- reader LEFT JOINs this table to render an inline RSVP card above the body.
--
-- #89 added rrule + tz so recurrence and the originating IANA zone propagate
-- through the promotion path into calendar_events.rrule / .tz. Existing
-- overflow DBs need the manual ALTER from db/scripts/0003_mail_db_rrule_tz.sql.
CREATE TABLE message_calendar_events (
  message_id TEXT PRIMARY KEY,
  starts_at  INTEGER NOT NULL,
  ends_at    INTEGER,
  summary    TEXT,
  location   TEXT,
  organizer  TEXT,
  uid        TEXT,
  method     TEXT,
  raw_ics    TEXT NOT NULL,
  -- #89: RFC 5545 RRULE value (sans "RRULE:" prefix) + IANA TZID lifted from
  -- DTSTART;TZID=. Both NULL on single-shot, floating, or UTC-only invites.
  -- Threaded through promoteInvitesForThread → calendar_events.rrule / .tz.
  rrule      TEXT,
  tz         TEXT
);
CREATE INDEX message_calendar_events_starts ON message_calendar_events(starts_at DESC);
