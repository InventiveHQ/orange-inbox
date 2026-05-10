-- Per-user sidebar mailbox ordering (issue #52).
--
-- Users can drag-to-reorder mailbox rows in the sidebar. The order is
-- per-user (different users sharing a mailbox can put it in different
-- positions in their own sidebar), so the position lives on the existing
-- user_mailbox_access row rather than on mailboxes itself.
--
-- Lives in control DB. Default 0 means "unordered" → fall back to
-- alphabetical (domain.name, mailbox.local_part). The list query orders by
-- sort_order ASC first, so any row a user has explicitly placed
-- (sort_order >= 1) leads the alphabetical default-zero rows. Once a user
-- drags, the PATCH endpoint writes 1..N over every accessible mailbox, so
-- the entire list becomes deterministic again.
--
-- Index: (user_id, sort_order, mailbox_id) — covers the sidebar listing's
-- ORDER BY and tie-breaks by mailbox_id, which keeps the row order stable
-- across calls when sort_order happens to collide.
ALTER TABLE user_mailbox_access ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
CREATE INDEX user_mailbox_access_order
  ON user_mailbox_access(user_id, sort_order, mailbox_id);
