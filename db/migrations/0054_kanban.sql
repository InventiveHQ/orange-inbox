-- Per-mailbox Kanban board.
--
-- A shared mailbox needs a board view — what's untouched, what someone is on,
-- what's finished — on top of the flat chronological list. The board is just
-- an ordered set of status columns; the mailbox IS the board, so there's no
-- separate `kanban_boards` table. Columns and card placement are shared by
-- everyone with mailbox access (same team model as thread_assignments).
--
-- Kanban status is independent of the thread_assignments resolve lifecycle:
-- moving a card to a "Done" column does not touch assignment state.
--
-- Lives in the control DB beside threads_index / thread_assignments. No
-- mail-plane / db/mail-plane-bootstrap.sql change.

CREATE TABLE kanban_columns (
  id          TEXT PRIMARY KEY,
  mailbox_id  TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX kanban_columns_mailbox ON kanban_columns(mailbox_id, position);

-- A thread's placement on its mailbox's board. At most one row per thread
-- (PK). No row = the thread sits in the board's first column, so
-- newly-arrived mail appears on the board with zero writes. column_id
-- ON DELETE CASCADE: deleting a column drops its placement rows, so those
-- cards fall back to the first column.
CREATE TABLE thread_kanban (
  thread_id   TEXT PRIMARY KEY,
  column_id   TEXT NOT NULL REFERENCES kanban_columns(id) ON DELETE CASCADE,
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by  TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX thread_kanban_column ON thread_kanban(column_id);

-- Default columns (New / In progress / Done) are seeded lazily the first
-- time a mailbox's board is opened — see lib/kanban.ts ensureBoard. No
-- backfill here, mirroring how the app avoids backfills elsewhere.
