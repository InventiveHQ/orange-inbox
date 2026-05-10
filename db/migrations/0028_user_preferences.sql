-- Lives in control DB. No mail-DB / bootstrap change.
--
-- Per-user appearance preferences: theme override and accent color. Both have
-- sensible defaults so a row only has to exist once a user touches Settings →
-- Appearance. Until then the layout falls back to "system" + the default
-- orange accent.

CREATE TABLE user_preferences (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme        TEXT NOT NULL DEFAULT 'system',  -- 'light' | 'dark' | 'system'
  accent_hex   TEXT NOT NULL DEFAULT '#f97316', -- default orange
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
