-- Backfill messages.is_marketing / is_action_item for inbound rows ingested
-- before #3 + #7 landed.
--
-- This is a one-shot script (NOT a tracked migration). Run via:
--   cd web && npx wrangler d1 execute orange-inbox \
--     --remote --file ../db/scripts/0002_backfill_triage.sql
--
-- The live classifier in email-worker/src/triage.ts uses signals not
-- persisted on the messages row (auth_results.dmarc, contacts membership,
-- VIPs, first_contact-vs-owned-mailbox). This backfill approximates the
-- heuristic using only stored columns:
--
--   is_marketing  ← list_unsub_url / list_unsub_mailto / promo categories
--   is_action_item ← imperative-verb subject patterns OR a '?' in the first
--                    500 chars of text_body
--
-- We only touch inbound rows. Existing flags default to 0 via the migration,
-- so re-running is idempotent over the WHERE clauses below.

-- ── is_marketing ─────────────────────────────────────────────────────────
-- Any List-Unsubscribe header (live rule, exact match) OR a category that
-- the categorizer already filed as bulk.
UPDATE messages
   SET is_marketing = 1
 WHERE direction = 'inbound'
   AND is_marketing = 0
   AND (
        list_unsub_url IS NOT NULL
     OR list_unsub_mailto IS NOT NULL
     OR category IN ('promotions','social','updates','forums')
   );

-- ── is_action_item ───────────────────────────────────────────────────────
-- Subject contains an imperative verb / urgency cue. GLOB is case-sensitive
-- so we LOWER() first; the `* … *` wrap makes it a substring match.
UPDATE messages
   SET is_action_item = 1
 WHERE direction = 'inbound'
   AND is_action_item = 0
   AND (
        LOWER(COALESCE(subject, '')) GLOB '*review*'
     OR LOWER(COALESCE(subject, '')) GLOB '*approve*'
     OR LOWER(COALESCE(subject, '')) GLOB '*sign*'
     OR LOWER(COALESCE(subject, '')) GLOB '*confirm*'
     OR LOWER(COALESCE(subject, '')) GLOB '*verify*'
     OR LOWER(COALESCE(subject, '')) GLOB '*respond*'
     OR LOWER(COALESCE(subject, '')) GLOB '*reply*'
     OR LOWER(COALESCE(subject, '')) GLOB '*urgent*'
     OR LOWER(COALESCE(subject, '')) GLOB '*asap*'
     OR LOWER(COALESCE(subject, '')) GLOB '*by eod*'
     OR LOWER(COALESCE(subject, '')) GLOB '*by tomorrow*'
   );

-- A literal '?' in the first 500 chars of the plain text body. Using LIKE
-- with the implicit '?' wildcard would also work but is harder to reason
-- about; we INSTR-substr instead. text_body is NULL on rows that arrived
-- as HTML-only — those skip this rule, which is fine for backfill.
UPDATE messages
   SET is_action_item = 1
 WHERE direction = 'inbound'
   AND is_action_item = 0
   AND text_body IS NOT NULL
   AND INSTR(SUBSTR(text_body, 1, 500), '?') > 0;
