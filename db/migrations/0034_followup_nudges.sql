-- Follow-up nudges (issue #26).
--
-- Lives in control DB (threads_index). No mail-DB / bootstrap change.
--
-- A "nudge" surfaces threads where the user sent a message and is now waiting
-- on a reply that hasn't arrived in N days. Per-thread opt-in (the user
-- toggles "Follow-up nudges" from ThreadActions) so we never pester on
-- conversations the user explicitly doesn't care about following up on.
--
-- The "is the most-recent message outbound?" check is NOT cached here for
-- v1: it requires the mail DB the thread lives in, so listDueFollowups fans
-- out via getMailDbForThread per candidate. Candidate set is bounded by the
-- partial index (`follow_up_enabled = 1`) so the fan-out stays cheap. A
-- `last_direction` cache column can land later once it's clearer how often
-- this view is hit.

-- Whether nudges are enabled on this thread. 0 = opt-out (default), 1 = the
-- user has explicitly turned on follow-up tracking for this conversation.
ALTER TABLE threads_index ADD COLUMN follow_up_enabled INTEGER NOT NULL DEFAULT 0;

-- Days after which the thread becomes due. NULL means use the user/global
-- default (currently hard-coded to 4 in listDueFollowups).
ALTER TABLE threads_index ADD COLUMN follow_up_days INTEGER;

-- Partial index: only nudge-enabled rows matter for the "due" query. Keeps
-- the index tiny on accounts where the feature is rarely toggled on, while
-- still letting listDueFollowups do an indexed scan against last_message_at.
CREATE INDEX threads_index_followup
  ON threads_index(follow_up_enabled, last_message_at)
  WHERE follow_up_enabled = 1;
