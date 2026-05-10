-- Mute thread.
--
-- A muted thread is hidden from per-mailbox inbox views and stays archived
-- when new replies arrive. It still shows in "All Mail", search, starred,
-- and label views — mute is "stop pestering me", not "delete".
--
-- `muted` lives on threads_index in the control DB only — same place as
-- archived/starred/unread_count post-0009. The mail-DB threads table is
-- not consulted for UI flags after 0009, so no bootstrap/overflow change
-- is needed.

ALTER TABLE threads_index ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;

CREATE INDEX threads_index_mailbox_muted
  ON threads_index(mailbox_id, muted, last_message_at DESC);
