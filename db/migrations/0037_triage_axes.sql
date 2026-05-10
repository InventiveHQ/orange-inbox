-- Two-axis triage classifier (closes #3, #7): tag every inbound message with
-- a (is_marketing, is_action_item) pair at parse time. The web UI's triage
-- bar uses the pair to filter the unified inbox into four quadrants:
--
--   (not marketing, action)    — "Primary action" / things to do (default)
--   (not marketing, no action) — "Quiet" — FYI/no-action humans (issue #7)
--   (marketing, action)        — receipts / verifies — bulk, but actionable
--   (marketing, no action)     — newsletters and standard promo blasts
--
-- Applies to mail DBs. For existing overflows, manual ALTER:
--
--     ALTER TABLE messages ADD COLUMN is_marketing INTEGER NOT NULL DEFAULT 0;
--     ALTER TABLE messages ADD COLUMN is_action_item INTEGER NOT NULL DEFAULT 0;
--     CREATE INDEX messages_triage
--       ON messages(mailbox_id, is_marketing, is_action_item, date DESC);
--
-- db/mail-plane-bootstrap.sql is also updated so newly-provisioned overflows
-- pick up both columns automatically.
--
-- No backfill is bundled with the migration. Existing rows default to
-- (0, 0) — i.e. "quiet humans" — which is the safest neutral until a backfill
-- (see db/scripts/0002_backfill_triage.sql) runs.

ALTER TABLE messages ADD COLUMN is_marketing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN is_action_item INTEGER NOT NULL DEFAULT 0;

-- Compound index supports the per-mailbox triage listing: filter on both
-- axes, order by date desc. Mirrors messages_category_date shape.
CREATE INDEX messages_triage
  ON messages(mailbox_id, is_marketing, is_action_item, date DESC);
