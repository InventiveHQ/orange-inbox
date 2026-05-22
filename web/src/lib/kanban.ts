import { getDb } from "./db";
import { logAudit } from "./audit";
import type { ThreadListItem } from "./queries";

// Per-mailbox Kanban board (see db/migrations/0054_kanban.sql).
//
// A board is just the mailbox's ordered set of `kanban_columns`; a thread's
// placement is one row in `thread_kanban` (no row = first column). Everything
// here is team-shared per mailbox — access is gated on `user_mailbox_access`,
// the same membership model assignThread uses. Result unions mirror
// lib/assignments.ts so the API routes can map a `code` to an HTTP status.

const MAX_COLUMN_NAME = 60;
const MAX_COLUMNS = 12;
const BOARD_CARD_LIMIT = 500;

// Seeded lazily on first board open. Keep in sync with the comment in the
// 0054 migration.
const DEFAULT_COLUMNS = ["New", "In progress", "Done"];

export interface KanbanColumn {
  id: string;
  mailbox_id: string;
  name: string;
  position: number;
}

// A board card extends the standard inbox row with its column placement and
// the joined-in assignee (so the board can render an assignee chip and the
// "unassigned / assigned to me" filter without a second round-trip).
export interface KanbanCard extends ThreadListItem {
  // Always a real column id on this board — callers resolve "no row" /
  // dangling ids to the first column before this is set.
  column_id: string;
  assignee_id: string | null;
  assignee_email: string | null;
  assignee_display_name: string | null;
}

export interface KanbanBoardData {
  mailbox_id: string;
  mailbox_label: string;
  columns: KanbanColumn[];
  cards: KanbanCard[];
}

// Membership gate — exported so the API routes can reuse it. Mirrors the
// inline check in assignThread / the assignable route.
export async function userCanAccessMailbox(
  mailboxId: string,
  userId: string,
): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `SELECT 1 FROM user_mailbox_access
        WHERE mailbox_id = ? AND user_id = ? LIMIT 1`,
    )
    .bind(mailboxId, userId)
    .first();
  return !!row;
}

export async function listColumns(mailboxId: string): Promise<KanbanColumn[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT id, mailbox_id, name, position
         FROM kanban_columns
        WHERE mailbox_id = ?
        ORDER BY position, created_at`,
    )
    .bind(mailboxId)
    .all<KanbanColumn>();
  return results ?? [];
}

// Seed New / In progress / Done the first time a mailbox's board is opened.
// IDs are deterministic (`<mailbox>-kb-<n>`) so two concurrent first-opens
// both INSERT OR IGNORE the same rows — the loser is a no-op rather than a
// duplicate set of columns. Never re-seeds: deleteColumn refuses to remove
// the last column, so a board always keeps >= 1 column once seeded.
export async function ensureBoard(mailboxId: string): Promise<KanbanColumn[]> {
  const existing = await listColumns(mailboxId);
  if (existing.length > 0) return existing;
  const now = Math.floor(Date.now() / 1000);
  const db = getDb();
  for (let i = 0; i < DEFAULT_COLUMNS.length; i++) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO kanban_columns
           (id, mailbox_id, name, position, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(`${mailboxId}-kb-${i}`, mailboxId, DEFAULT_COLUMNS[i], i, now)
      .run();
  }
  return listColumns(mailboxId);
}

interface BoardCardRow {
  id: string;
  subject_normalized: string;
  last_message_at: number;
  message_count: number;
  unread_count: number;
  starred: number;
  archived: number;
  muted: number;
  pinned: number;
  follow_up_enabled: number;
  follow_up_days: number | null;
  follow_up_minutes: number | null;
  domain_id: string;
  domain_name: string;
  mailbox_id: string;
  mailbox_local_part: string;
  last_subject: string | null;
  last_from_addr: string | null;
  last_from_name: string | null;
  last_snippet: string | null;
  labels_json: string | null;
  column_id: string | null;
  assignee_id: string | null;
  assignee_email: string | null;
  assignee_display_name: string | null;
}

// Load the full board for `mailboxId`: its columns plus every non-archived
// thread as a card. Returns null when the caller can't see the mailbox.
//
// One query mirrors listThreads' row shape (threads_index + the thread_labels
// JSON aggregate) and LEFT JOINs thread_kanban (column placement) and
// thread_assignments + users (assignee). Cards with no placement — or a
// placement pointing at a since-deleted column — resolve to the first column
// in JS, so the "no row = first column" invariant needs no DB writes.
export async function loadBoard(
  userId: string,
  mailboxId: string,
): Promise<KanbanBoardData | null> {
  if (!(await userCanAccessMailbox(mailboxId, userId))) return null;

  const meta = await getDb()
    .prepare(
      `SELECT mb.local_part AS local_part, d.name AS domain_name
         FROM mailboxes mb
         INNER JOIN domains d ON d.id = mb.domain_id
        WHERE mb.id = ?`,
    )
    .bind(mailboxId)
    .first<{ local_part: string; domain_name: string }>();
  if (!meta) return null;

  const columns = await ensureBoard(mailboxId);
  const firstColumnId = columns[0]?.id ?? "";
  const validColumnIds = new Set(columns.map(c => c.id));

  const sql = `
    SELECT
      ti.thread_id AS id,
      ti.subject_normalized,
      ti.last_message_at,
      ti.message_count,
      ti.unread_count,
      ti.starred,
      ti.archived,
      ti.muted,
      ti.pinned,
      ti.follow_up_enabled,
      ti.follow_up_days,
      ti.follow_up_minutes,
      d.id   AS domain_id,
      d.name AS domain_name,
      mb.id  AS mailbox_id,
      mb.local_part AS mailbox_local_part,
      ti.last_subject   AS last_subject,
      ti.last_from_addr AS last_from_addr,
      ti.last_from_name AS last_from_name,
      ti.last_snippet   AS last_snippet,
      tk.column_id      AS column_id,
      ta.assignee_id    AS assignee_id,
      u.email           AS assignee_email,
      u.display_name    AS assignee_display_name,
      (
        SELECT JSON_GROUP_ARRAY(
                 JSON_OBJECT('id', l.id, 'name', l.name, 'color', l.color)
               )
          FROM (
            SELECT l.id, l.name, l.color
              FROM thread_labels tl
              INNER JOIN labels l ON l.id = tl.label_id
             WHERE tl.thread_id = ti.thread_id
             ORDER BY l.name
          ) AS l
      ) AS labels_json
    FROM threads_index ti
    INNER JOIN mailboxes mb ON mb.id = ti.mailbox_id
    INNER JOIN domains d   ON d.id = mb.domain_id
    LEFT JOIN thread_kanban tk      ON tk.thread_id = ti.thread_id
    LEFT JOIN thread_assignments ta ON ta.thread_id = ti.thread_id
    LEFT JOIN users u               ON u.id = ta.assignee_id
    WHERE ti.mailbox_id = ?
      AND ti.archived = 0
    ORDER BY ti.last_message_at DESC
    LIMIT ?
  `;
  const { results } = await getDb()
    .prepare(sql)
    .bind(mailboxId, BOARD_CARD_LIMIT)
    .all<BoardCardRow>();

  const cards: KanbanCard[] = (results ?? []).map(row => {
    let labels: ThreadListItem["labels"] = [];
    if (row.labels_json) {
      try {
        const parsed = JSON.parse(row.labels_json) as ThreadListItem["labels"];
        if (Array.isArray(parsed)) labels = parsed;
      } catch {
        labels = [];
      }
    }
    const { labels_json: _drop, column_id, ...rest } = row;
    void _drop;
    return {
      ...rest,
      labels,
      column_id:
        column_id && validColumnIds.has(column_id) ? column_id : firstColumnId,
    };
  });

  return {
    mailbox_id: mailboxId,
    mailbox_label: `${meta.local_part}@${meta.domain_name}`,
    columns,
    cards,
  };
}

// ─── Mutations ───────────────────────────────────────────────────────────

export type MoveResult =
  | { ok: true }
  | { ok: false; code: "forbidden" | "not_found" | "bad_column" };

// Place a thread in a column (idempotent upsert). Validates that the caller
// can see the thread's mailbox and that `columnId` is a column of that same
// mailbox — so a card can never be parked on another board's column.
export async function moveThread(
  threadId: string,
  columnId: string,
  byUserId: string,
): Promise<MoveResult> {
  const row = await getDb()
    .prepare(
      `SELECT ti.mailbox_id AS mailbox_id, uma.user_id AS by_access
         FROM threads_index ti
         LEFT JOIN user_mailbox_access uma
           ON uma.mailbox_id = ti.mailbox_id AND uma.user_id = ?
        WHERE ti.thread_id = ?`,
    )
    .bind(byUserId, threadId)
    .first<{ mailbox_id: string | null; by_access: string | null }>();
  if (!row || !row.mailbox_id) return { ok: false, code: "not_found" };
  if (!row.by_access) return { ok: false, code: "forbidden" };

  const column = await getDb()
    .prepare(`SELECT 1 FROM kanban_columns WHERE id = ? AND mailbox_id = ? LIMIT 1`)
    .bind(columnId, row.mailbox_id)
    .first();
  if (!column) return { ok: false, code: "bad_column" };

  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .prepare(
      `INSERT INTO thread_kanban (thread_id, column_id, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (thread_id) DO UPDATE
         SET column_id  = excluded.column_id,
             updated_at = excluded.updated_at,
             updated_by = excluded.updated_by`,
    )
    .bind(threadId, columnId, now, byUserId)
    .run();

  await logAudit({
    userId: byUserId,
    mailboxId: row.mailbox_id,
    threadId,
    action: "kanban_move",
    payload: { column_id: columnId },
  });
  return { ok: true };
}

export type ColumnResult =
  | { ok: true; column: KanbanColumn }
  | { ok: false; code: "forbidden" | "invalid" | "too_many" | "not_found" };

export async function createColumn(
  mailboxId: string,
  name: string,
  byUserId: string,
): Promise<ColumnResult> {
  if (!(await userCanAccessMailbox(mailboxId, byUserId))) {
    return { ok: false, code: "forbidden" };
  }
  const clean = (name ?? "").trim();
  if (!clean || clean.length > MAX_COLUMN_NAME) {
    return { ok: false, code: "invalid" };
  }
  const columns = await listColumns(mailboxId);
  if (columns.length >= MAX_COLUMNS) return { ok: false, code: "too_many" };

  const id = crypto.randomUUID();
  const position = columns.length
    ? columns[columns.length - 1].position + 1
    : 0;
  await getDb()
    .prepare(
      `INSERT INTO kanban_columns (id, mailbox_id, name, position, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, mailboxId, clean, position, Math.floor(Date.now() / 1000))
    .run();
  return { ok: true, column: { id, mailbox_id: mailboxId, name: clean, position } };
}

async function getColumn(columnId: string): Promise<KanbanColumn | null> {
  const row = await getDb()
    .prepare(`SELECT id, mailbox_id, name, position FROM kanban_columns WHERE id = ?`)
    .bind(columnId)
    .first<KanbanColumn>();
  return row ?? null;
}

export async function renameColumn(
  columnId: string,
  name: string,
  byUserId: string,
): Promise<ColumnResult> {
  const column = await getColumn(columnId);
  if (!column) return { ok: false, code: "not_found" };
  if (!(await userCanAccessMailbox(column.mailbox_id, byUserId))) {
    return { ok: false, code: "forbidden" };
  }
  const clean = (name ?? "").trim();
  if (!clean || clean.length > MAX_COLUMN_NAME) {
    return { ok: false, code: "invalid" };
  }
  await getDb()
    .prepare(`UPDATE kanban_columns SET name = ? WHERE id = ?`)
    .bind(clean, columnId)
    .run();
  return { ok: true, column: { ...column, name: clean } };
}

export type DeleteColumnResult =
  | { ok: true }
  | { ok: false; code: "forbidden" | "not_found" | "last_column" };

// Delete a column. The board must keep at least one column. thread_kanban
// rows cascade away, so cards in the deleted column fall back to the first
// remaining column (resolved by loadBoard).
export async function deleteColumn(
  columnId: string,
  byUserId: string,
): Promise<DeleteColumnResult> {
  const column = await getColumn(columnId);
  if (!column) return { ok: false, code: "not_found" };
  if (!(await userCanAccessMailbox(column.mailbox_id, byUserId))) {
    return { ok: false, code: "forbidden" };
  }
  const columns = await listColumns(column.mailbox_id);
  if (columns.length <= 1) return { ok: false, code: "last_column" };
  await getDb()
    .prepare(`DELETE FROM kanban_columns WHERE id = ?`)
    .bind(columnId)
    .run();
  return { ok: true };
}

export type ReorderResult =
  | { ok: true; columns: KanbanColumn[] }
  | { ok: false; code: "forbidden" | "invalid" };

// Persist a new column order. `orderedIds` must be exactly a permutation of
// the mailbox's current column ids.
export async function reorderColumns(
  mailboxId: string,
  orderedIds: unknown,
  byUserId: string,
): Promise<ReorderResult> {
  if (!(await userCanAccessMailbox(mailboxId, byUserId))) {
    return { ok: false, code: "forbidden" };
  }
  const columns = await listColumns(mailboxId);
  const existing = new Set(columns.map(c => c.id));
  if (
    !Array.isArray(orderedIds) ||
    orderedIds.length !== columns.length ||
    !orderedIds.every(id => typeof id === "string" && existing.has(id))
  ) {
    return { ok: false, code: "invalid" };
  }
  const db = getDb();
  for (let i = 0; i < orderedIds.length; i++) {
    await db
      .prepare(`UPDATE kanban_columns SET position = ? WHERE id = ? AND mailbox_id = ?`)
      .bind(i, orderedIds[i] as string, mailboxId)
      .run();
  }
  return { ok: true, columns: await listColumns(mailboxId) };
}
