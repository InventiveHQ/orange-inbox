-- Saved searches (a.k.a. Smart Mailboxes).
--
-- A saved search is a named entry in the sidebar that re-runs a stored
-- search query (raw operator-aware string — `from:`, `is:unread`,
-- `has:attachment`, `before:`, `after:`, `mailbox:`, etc.) when clicked.
-- Clicking a saved search routes to /search?q=<query>; the query string
-- itself is interpreted by the existing search pipeline at request time,
-- so no denormalised result set lives in this table.
--
-- Lives in control DB. No mail-DB / bootstrap change needed.

CREATE TABLE saved_searches (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  query       TEXT NOT NULL,        -- raw search string with operators
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX saved_searches_user ON saved_searches(user_id, sort_order, name);
