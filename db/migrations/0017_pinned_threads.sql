-- Pinned threads.
--
-- A pinned thread sticks to the top of the inbox regardless of
-- last_message_at. Pin is purely a UI affordance — archive, snooze, and
-- mute still work normally on pinned threads (an archived+pinned thread
-- is hidden from the inbox the same way as any other archived thread).
--
-- `pinned` lives on threads_index in the control DB only — same place as
-- archived/starred/muted/unread_count post-0009. The mail-DB threads table
-- is not consulted for UI flags after 0009, so no bootstrap/overflow change
-- is needed.

ALTER TABLE threads_index ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

CREATE INDEX threads_index_mailbox_pinned
  ON threads_index(mailbox_id, pinned DESC, last_message_at DESC);
