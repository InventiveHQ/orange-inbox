-- Sub-day follow-up cadences. Adds a minutes-precision column alongside
-- the legacy `follow_up_days` column so existing rows keep behaving the
-- same; new writes go to `follow_up_minutes`. Readers prefer
-- `follow_up_minutes` and fall back to `follow_up_days * 1440`.
--
-- Why a parallel column rather than rewriting follow_up_days as a REAL:
-- SQLite can't change column type in place, and downstream queries +
-- types already coerce follow_up_days to INTEGER. Keeping both columns
-- means we don't have to fan out a multi-PR migration to flip the type
-- everywhere at once — the next reader-side cleanup can drop
-- follow_up_days when convenient.

ALTER TABLE threads_index ADD COLUMN follow_up_minutes INTEGER;

UPDATE threads_index
  SET follow_up_minutes = follow_up_days * 1440
  WHERE follow_up_days IS NOT NULL AND follow_up_minutes IS NULL;
