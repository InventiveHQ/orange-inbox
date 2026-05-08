-- Multi-database (overflow) support.
--
-- The default deploy still uses a single D1 database for everything; nothing
-- in this migration changes that. What it does add is the *machinery* for
-- spilling new threads into additional D1s once the primary DB hits a soft
-- size cap.
--
-- Architecture in one paragraph:
--   The "control plane" (users, mailboxes, drafts, contacts, templates,
--   labels — all bounded) lives in the primary DB forever. The "mail plane"
--   (threads, messages, attachments, FTS) ALSO starts in the primary DB. When
--   primary fills up, an operator provisions an additional D1 ("overflow")
--   binding and registers it in `mail_dbs`. From then on, NEW threads land in
--   the overflow DB; existing threads keep going to wherever their parent
--   message lives so threading never fragments. The control DB tracks the
--   set of mail DBs and a per-thread location index, plus a denormalised
--   `threads_index` so the inbox listing query stays a single SQL even when
--   threads are scattered.
--
-- Source of truth, post-migration:
--   threads_index            owns thread-level UI state (archived, starred,
--                            snoozed_until, unread_count, last-message
--                            snippet) — listing reads only this table.
--   threads (in mail DB)     keeps the bag-of-messages anchor for FK and
--                            history, but its archived/starred/etc. flags
--                            are no longer authoritative.
--
-- Backfill: every existing thread is recorded as living in 'primary'.

PRAGMA foreign_keys = ON;

-- Registry of every mail DB the deployment knows about. The 'primary' row
-- always exists and points at the same env binding the rest of the app uses
-- (env.DB). Additional rows are inserted by operators after they create a new
-- D1 and add its binding to wrangler.jsonc.
CREATE TABLE mail_dbs (
  id              TEXT PRIMARY KEY,                       -- 'primary' or operator-chosen id
  binding_name    TEXT NOT NULL,                          -- env.<binding_name>; matches wrangler.jsonc
  display_name    TEXT,
  -- Two caps so we degrade safely:
  --   soft_max_bytes — once exceeded, this DB stops accepting NEW threads.
  --                    Existing threads keep flowing in (so reply chains
  --                    don't fragment) up to hard_max_bytes.
  --   hard_max_bytes — once exceeded, this DB rejects ALL writes. The cron
  --                    capacity-checker flips active=0 here too. Set below
  --                    D1's 10 GB hard ceiling so we never lose data when
  --                    the binding refuses inserts.
  --   Defaults: 8 GiB soft, 9.5 GiB hard. NULL on either column means "no
  --   cap on this dimension"; the runtime treats unset as +Infinity.
  soft_max_bytes  INTEGER,
  hard_max_bytes  INTEGER,
  byte_estimate   INTEGER NOT NULL DEFAULT 0,             -- last computed size; updated by cron
  active          INTEGER NOT NULL DEFAULT 1,             -- 1 = accepts new threads, 0 = read-only / sealed
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO mail_dbs (id, binding_name, display_name, soft_max_bytes, hard_max_bytes)
  VALUES ('primary', 'DB', 'Primary', 8589934592, 10200547328);  -- 8 GiB / 9.5 GiB

-- Per-thread location. Resolver default (when no row exists) is 'primary',
-- so single-DB deploys never write to this table.
CREATE TABLE thread_locations (
  thread_id   TEXT PRIMARY KEY,
  mail_db_id  TEXT NOT NULL REFERENCES mail_dbs(id)
);

CREATE INDEX thread_locations_db ON thread_locations(mail_db_id);

-- Denormalised per-thread state used by the inbox listing. Mirrors a
-- subset of fields from `threads` (in the thread's mail DB) plus the
-- last-message snippet fields. Maintained by lib/send.ts (outbound),
-- email-worker (inbound), and the thread-mutation routes (archive/star/
-- snooze/mark-read).
CREATE TABLE threads_index (
  thread_id           TEXT PRIMARY KEY,
  mailbox_id          TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  mail_db_id          TEXT NOT NULL REFERENCES mail_dbs(id),
  subject_normalized  TEXT NOT NULL,
  last_message_at     INTEGER NOT NULL,
  message_count       INTEGER NOT NULL DEFAULT 0,
  unread_count        INTEGER NOT NULL DEFAULT 0,
  archived            INTEGER NOT NULL DEFAULT 0,
  starred             INTEGER NOT NULL DEFAULT 0,
  snoozed_until       INTEGER,
  last_message_id     TEXT,
  last_subject        TEXT,
  last_from_addr      TEXT,
  last_from_name      TEXT,
  last_snippet        TEXT,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX threads_index_mailbox_recent
  ON threads_index(mailbox_id, archived, last_message_at DESC);

-- Cache of which labels are applied to each thread (deduped across messages).
-- Listing reads only this — message_labels stays in the mail DB as the
-- per-message source of truth, and label-apply/remove writes both.
CREATE TABLE thread_labels (
  thread_id  TEXT NOT NULL,
  label_id   TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (thread_id, label_id)
);

CREATE INDEX thread_labels_label ON thread_labels(label_id);

-- ─── Backfill ────────────────────────────────────────────────────────────
-- Existing threads all live in 'primary'. Pull their listing fields plus
-- the latest message's snippet/from/subject for each thread.

INSERT INTO threads_index (
  thread_id, mailbox_id, mail_db_id,
  subject_normalized, last_message_at, message_count, unread_count,
  archived, starred,
  last_message_id, last_subject, last_from_addr, last_from_name, last_snippet,
  created_at
)
SELECT
  t.id, t.mailbox_id, 'primary',
  t.subject_normalized, t.last_message_at, t.message_count, t.unread_count,
  t.archived, t.starred,
  m.id, m.subject, m.from_addr, m.from_name, m.snippet,
  t.created_at
FROM threads t
LEFT JOIN messages m ON m.id = (
  SELECT id FROM messages WHERE thread_id = t.id ORDER BY date DESC LIMIT 1
);

-- thread_locations stays empty — missing row implicitly = 'primary'.
-- Backfilling rows here would just be storage waste.

-- thread_labels backfill: distinct (thread, label) pairs across every
-- labelled message in the existing data.
INSERT INTO thread_labels (thread_id, label_id)
SELECT DISTINCT m.thread_id, ml.label_id
  FROM message_labels ml
  INNER JOIN messages m ON m.id = ml.message_id;
