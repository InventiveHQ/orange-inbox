-- Per-contact time zone (#88).
--
-- Three columns: the IANA zone itself, where we got it (manual override
-- always wins over inferred), and when we last ran inference. The "when"
-- column doubles as the gate for one-time-per-contact signature scans —
-- `tz_inferred_at IS NULL` means we've never tried, so the read path is
-- allowed to spend a bit of time on the heuristic. Once it's set,
-- subsequent reads stay fast even if no zone was found.
--
-- Precedence (enforced in lib/contacts.ts):
--   manual    > signature > domain
--   never overwrite a higher-precedence value with a lower-precedence one.
--
-- Lazy-on-read inference fires from getContactForUser; the rescan from
-- a manual edit clears tz_inferred_at to allow re-running the heuristic.
ALTER TABLE contacts ADD COLUMN tz TEXT;
ALTER TABLE contacts ADD COLUMN tz_source TEXT;        -- 'manual' | 'signature' | 'domain' | NULL
ALTER TABLE contacts ADD COLUMN tz_inferred_at INTEGER;
