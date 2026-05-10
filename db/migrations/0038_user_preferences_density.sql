-- Lives in control DB. No mail-DB / bootstrap change.
--
-- Adds a "density" column to user_preferences for the Comfortable / Cozy /
-- Compact toggle in Settings → Appearance. Defaults to 'comfortable' so the
-- pre-existing rows keep their previous look on first render.

ALTER TABLE user_preferences
  ADD COLUMN density TEXT NOT NULL DEFAULT 'comfortable';
