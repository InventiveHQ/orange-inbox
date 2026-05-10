-- Filter rules — declarative "if message matches → do these things" automations
-- evaluated at inbound-mail time by email-worker/src/store.ts.
--
-- Scope: control-plane only. The conditions are read against parsed message
-- fields (from, subject, recipient local-part, has-attachment) and actions hit
-- the same DB ops the manual UI calls (apply_label, archive, mark_as_read,
-- delete). No mail-DB columns added → no overflow-DB bootstrap change needed.
--
-- mailbox_id NULL = "applies to every mailbox the user has access to". A
-- specific id scopes the rule to that mailbox only.
--
-- conditions_json + actions_json are stored opaquely; shape is owned by
-- web/src/lib/rules.ts. Keeping it JSON instead of a relational shape lets us
-- iterate on the matcher vocabulary without further migrations.

PRAGMA foreign_keys = ON;

CREATE TABLE rules (
  id              TEXT PRIMARY KEY,                       -- uuid
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id      TEXT REFERENCES mailboxes(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  conditions_json TEXT NOT NULL,                          -- JSON-encoded RuleCondition[]
  actions_json    TEXT NOT NULL,                          -- JSON-encoded RuleAction[]
  enabled         INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Inbound-evaluation lookup: "all enabled rules that could fire on a message
-- delivered to mailbox X, ordered for deterministic firing." We filter on
-- (mailbox_id IS NULL OR mailbox_id = ?) at the call site; the index covers
-- the most common bucket (all-mailboxes rules) and the per-mailbox bucket.
CREATE INDEX rules_user_enabled
  ON rules(user_id, enabled, sort_order);

CREATE INDEX rules_mailbox
  ON rules(mailbox_id)
  WHERE mailbox_id IS NOT NULL;
