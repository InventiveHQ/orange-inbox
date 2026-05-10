-- Lives in control DB. Aliases are a labelling layer over the existing
-- mailbox routing — inbound mail still hits the matching mailbox, but the
-- user can compose 'as' the alias.
--
-- Aliases sit alongside mailboxes: a single mailbox_id can have many aliases
-- (e.g. catch-all `*@yourdomain.com` exposes `netflix`, `signups`, etc).
-- Promoted aliases get a display_name and (optionally) their own signature
-- for outbound mail; inbound mail keeps landing in the parent mailbox so
-- threading and per-mailbox role/permission checks are unaffected.

PRAGMA foreign_keys = ON;

CREATE TABLE mailbox_aliases (
  id           TEXT PRIMARY KEY,
  mailbox_id   TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  local_part   TEXT NOT NULL,
  display_name TEXT,
  signature_html TEXT,
  promoted_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(mailbox_id, local_part)
);
CREATE INDEX mailbox_aliases_local ON mailbox_aliases(local_part);
