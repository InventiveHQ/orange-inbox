-- Attachment safety: tag executable / dangerous attachments at parse time
-- (closes #23). The web UI uses this column to render a warning badge and
-- gate downloads behind an "I know what I'm doing" confirm.
--
-- Applies to mail DBs (where `attachments` lives). For existing overflows,
-- run the equivalent ALTER manually:
--
--   ALTER TABLE attachments ADD COLUMN is_executable INTEGER NOT NULL DEFAULT 0;
--
-- New overflows: bootstrap.sql also updated.

ALTER TABLE attachments ADD COLUMN is_executable INTEGER NOT NULL DEFAULT 0;
