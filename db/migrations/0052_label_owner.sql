-- Close the v1 "global label" broken-access-control gap. Global labels
-- (mailbox_id IS NULL) previously had no owner, so canManageLabel() treated
-- them as manageable by every signed-in user — any user could rename or
-- delete any global label (and DELETE cascades through message_labels /
-- thread_labels, stripping the label everywhere).
--
-- This adds an owner column. New global labels record their creator;
-- canManageLabel() then restricts mutation to that owner or an admin.
--
-- The column is a plain nullable TEXT rather than a REFERENCES FK because
-- SQLite cannot add a foreign-key constraint via ALTER TABLE ADD COLUMN
-- (see 0003/0015, which add *_user_id columns the same way). It is
-- nullable: existing rows keep NULL and are treated as legacy/unowned,
-- which canManageLabel() restricts to admins only.

ALTER TABLE labels ADD COLUMN created_by_user_id TEXT;
