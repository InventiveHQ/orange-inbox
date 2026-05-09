-- Global admin flag on users. Replaces the previous granular gating
-- (per-domain admin / per-mailbox owner) for management actions: only users
-- with is_admin = 1 can add domains, add mailboxes, or manage mailbox members.
-- The per-domain / per-mailbox role columns remain as access grants but are
-- no longer used for management gating.
--
-- Bootstrap is manual:
--   UPDATE users SET is_admin = 1 WHERE email = '<your-email>';

PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
