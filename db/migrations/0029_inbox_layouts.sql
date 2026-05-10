-- Multiple-inbox split layouts.
--
-- A layout is a saved arrangement of N "panes", each pane driven by a search
-- query (either a saved-searches row reference or an inline raw query string).
-- The user picks a layout from the sidebar and the inbox view fans out into
-- side-by-side thread lists, each running its pane's query through the
-- existing search/list infrastructure.
--
-- The pane list is stored as a single JSON column rather than a child table:
-- panes are always read together, never queried by id, and the cardinality is
-- low (a handful of panes per layout). One JSON blob keeps writes atomic and
-- avoids the join + ordering rigmarole a child table would need.
--
-- `is_default` is enforced unique-per-user via a partial index — only one
-- layout per user may carry the flag.
--
-- Lives in control DB. No mail-DB / bootstrap change.
CREATE TABLE inbox_layouts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  config      TEXT NOT NULL,                -- JSON array: [{ saved_search_id?: string, query?: string, label: string }]
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX inbox_layouts_user ON inbox_layouts(user_id, is_default DESC, name);

-- Only one default per user.
CREATE UNIQUE INDEX inbox_layouts_user_default
  ON inbox_layouts(user_id) WHERE is_default = 1;
