-- Auto-categorization tabs (closes #68): tag every inbound message with one
-- of {primary, promotions, updates, social, forums} at parse time. The web
-- UI renders a tab strip above the inbox thread list and filters by category.
--
-- Two columns live in two different DBs by design:
--
--   messages.category lives in mail DBs (per-message, set at ingest from
--     headers/sender/subject heuristics — see email-worker/src/categorize.ts).
--     For existing mail-DB OVERFLOWS, run the equivalent ALTERs manually:
--
--       ALTER TABLE messages ADD COLUMN category TEXT;
--       CREATE INDEX messages_category_date ON messages(category, date DESC);
--
--     mail-plane-bootstrap.sql is also updated so newly-provisioned overflows
--     pick the column up automatically.
--
--   category_overrides lives in the control DB. Per-user, per-sender manual
--     overrides ("always file mail from this sender as Updates") that take
--     precedence over the heuristic. Cascades on user delete.
--
-- No backfill: existing rows have NULL category and the listing query treats
-- NULL as Primary so the migration is non-disruptive.

ALTER TABLE messages ADD COLUMN category TEXT;
-- Index supports the per-category listing query that the new tabs drive.
CREATE INDEX messages_category_date ON messages(category, date DESC);

CREATE TABLE category_overrides (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_addr  TEXT NOT NULL,
  category   TEXT NOT NULL,
  added_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, from_addr)
);
