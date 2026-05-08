-- Contacts (per-mailbox address book) and canned responses (templates).
--
-- Contacts:
--   Each row is scoped to one mailbox. user_id is nullable:
--     user_id IS NULL    -> shared contact, visible to every member of the mailbox
--     user_id IS NOT NULL -> personal contact for that one user inside this mailbox
--   The compose typeahead pulls all contacts the current user can see for the
--   chosen From mailbox; the contacts page surfaces them with a shared/personal
--   badge.
--
--   send_count / receive_count are bumped by lib/contacts.ts; both stay 0 for
--   manually-created rows until traffic happens.
--
-- Canned responses:
--   Templates with placeholder substitution at insert time. Either personal
--   (user_id set, mailbox_id NULL) or mailbox-shared (mailbox_id set, user_id
--   NULL). Listing shows the union of personal + every shared template the
--   user has access to.

PRAGMA foreign_keys = ON;

CREATE TABLE contacts (
  id              TEXT PRIMARY KEY,                       -- uuid
  mailbox_id      TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  user_id         TEXT REFERENCES users(id) ON DELETE CASCADE,  -- NULL = shared
  email           TEXT NOT NULL,
  email_lc        TEXT NOT NULL,                          -- lower(email), for dedupe + search
  name            TEXT,
  notes           TEXT,
  send_count      INTEGER NOT NULL DEFAULT 0,
  receive_count   INTEGER NOT NULL DEFAULT 0,
  first_seen_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Dedupe scope: same email twice on a mailbox+user-bucket is the same contact.
-- COALESCE so NULL user_id (shared) collapses to a single row per mailbox+email.
CREATE UNIQUE INDEX contacts_unique
  ON contacts(mailbox_id, COALESCE(user_id, ''), email_lc);

-- Used by the typeahead: "for this mailbox, prefix-match email or name".
CREATE INDEX contacts_search ON contacts(mailbox_id, email_lc);

-- Used by the contacts page when filtering by mailbox.
CREATE INDEX contacts_mailbox_recent ON contacts(mailbox_id, last_seen_at DESC);

CREATE TABLE canned_responses (
  id              TEXT PRIMARY KEY,
  user_id         TEXT REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id      TEXT REFERENCES mailboxes(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,                          -- short label shown in the menu
  subject_template TEXT,                                  -- optional; replaces subject when inserted
  body_template   TEXT NOT NULL,                          -- supports {{placeholders}}
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK ((user_id IS NOT NULL) OR (mailbox_id IS NOT NULL))
);

CREATE INDEX canned_user    ON canned_responses(user_id)    WHERE user_id    IS NOT NULL;
CREATE INDEX canned_mailbox ON canned_responses(mailbox_id) WHERE mailbox_id IS NOT NULL;
