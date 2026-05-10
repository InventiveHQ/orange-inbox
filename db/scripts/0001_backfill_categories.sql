-- Backfill messages.category for inbound rows ingested before #68 landed.
--
-- This is a one-shot script (NOT a tracked migration). Run via:
--   cd web && npx wrangler d1 execute orange-inbox \
--     --remote --file ../db/scripts/0001_backfill_categories.sql
--
-- The live categorizer in email-worker/src/categorize.ts uses signals not
-- persisted on the messages row (Auto-Submitted, Precedence, List-Id). This
-- backfill works with the columns we DO have on existing rows:
--   from_addr           — sender domain + local-part
--   subject             — transactional patterns
--   list_unsub_url      — proxy for "has List-Unsubscribe"
--   list_unsub_mailto   — same
--
-- Precedence (mirrors categorize.ts): Updates beats Social beats Promotions.
-- Forums (List-Id) cannot be detected from stored columns; those rows stay
-- NULL and surface in Primary, which is what they'd do anyway absent the
-- category column.
--
-- We only touch inbound rows where category IS currently NULL — re-running
-- this is safe but a no-op once it has run.

-- ── Updates ────────────────────────────────────────────────────────────────
-- Transactional / automation domains + subject patterns.
UPDATE messages
   SET category = 'updates'
 WHERE direction = 'inbound'
   AND category IS NULL
   AND (
        LOWER(from_addr) LIKE '%@stripe.com'
     OR LOWER(from_addr) LIKE '%@paypal.com'
     OR LOWER(from_addr) LIKE '%@github.com'
     OR LOWER(from_addr) LIKE '%@vercel.com'
     OR LOWER(from_addr) LIKE '%@aws.amazon.com'
     OR LOWER(from_addr) LIKE '%@cloudflare.com'
     OR LOWER(COALESCE(subject, '')) GLOB '*receipt*'
     OR LOWER(COALESCE(subject, '')) GLOB '*invoice*'
     OR LOWER(COALESCE(subject, '')) GLOB '*order*'
     OR LOWER(COALESCE(subject, '')) GLOB '*verify*'
     OR LOWER(COALESCE(subject, '')) GLOB '*verification*'
     OR LOWER(COALESCE(subject, '')) GLOB '*confirm*'
     OR LOWER(COALESCE(subject, '')) GLOB '*password reset*'
   );

-- ── Social ─────────────────────────────────────────────────────────────────
-- Major social networks (and GitHub, though Updates already claimed it via
-- @github.com — keeping the rule mirrors categorize.ts for clarity).
UPDATE messages
   SET category = 'social'
 WHERE direction = 'inbound'
   AND category IS NULL
   AND (
        LOWER(from_addr) LIKE '%@facebook.com'
     OR LOWER(from_addr) LIKE '%@linkedin.com'
     OR LOWER(from_addr) LIKE '%@x.com'
     OR LOWER(from_addr) LIKE '%@twitter.com'
     OR LOWER(from_addr) LIKE '%@instagram.com'
     OR LOWER(from_addr) LIKE '%@pinterest.com'
     OR LOWER(from_addr) LIKE '%@reddit.com'
     OR LOWER(from_addr) LIKE '%@tiktok.com'
     OR LOWER(from_addr) LIKE '%@youtube.com'
   );

-- ── Promotions ─────────────────────────────────────────────────────────────
-- Has any List-Unsubscribe header + promotional local-part. We can't see
-- Precedence: bulk or other List-* headers from stored columns, so this is
-- the lesser-of-evils variant of the live rule.
UPDATE messages
   SET category = 'promotions'
 WHERE direction = 'inbound'
   AND category IS NULL
   AND (list_unsub_url IS NOT NULL OR list_unsub_mailto IS NOT NULL)
   AND (
        LOWER(SUBSTR(from_addr, 1, INSTR(from_addr, '@') - 1)) IN
          ('noreply','no-reply','hello','news','newsletter','hi','team','info','contact')
   );

-- ── Promotions, fallback ───────────────────────────────────────────────────
-- Any remaining rows with List-Unsubscribe headers but a non-promotional
-- local-part are also Promotions — the live categorizer would file them
-- there too once Precedence/List-* signals failed. This is the catch-all.
UPDATE messages
   SET category = 'promotions'
 WHERE direction = 'inbound'
   AND category IS NULL
   AND (list_unsub_url IS NOT NULL OR list_unsub_mailto IS NOT NULL);

-- Everything still NULL stays NULL → surfaces under Primary via the
-- `(category IS NULL OR category = 'primary')` predicate in queries.ts.
