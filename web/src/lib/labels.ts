import { getDb } from "./db";
import { isMailboxOwner } from "./mailbox-access";

// Labels are Gmail-style tags applied to threads (via message_labels rows).
// A label scoped to a mailbox (mailbox_id NOT NULL) shows up only inside that
// mailbox; mailbox_id NULL = "global" — usable across any mailbox the user
// can access.
//
// V1 SIMPLIFICATION: the schema has no creator/owner column on labels, so
// global labels are visible to (and manageable by) every signed-in user in
// the deployment. For a proper multi-user story we'd need to add a
// labels.created_by_user_id column (and a separate user_label_access table
// if we want per-user sharing of globals). Mailbox-scoped labels already get
// proper isolation via user_mailbox_access.

export interface LabelRow {
  id: string;
  name: string;
  color: string | null;
  mailbox_id: string | null;
}

// Labels visible to the user: global labels (v1: all of them) plus labels
// scoped to a mailbox the user has any access role on.
export async function listLabelsForUser(userId: string): Promise<LabelRow[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT l.id, l.name, l.color, l.mailbox_id
         FROM labels l
         LEFT JOIN user_mailbox_access uma
           ON uma.mailbox_id = l.mailbox_id AND uma.user_id = ?
        WHERE l.mailbox_id IS NULL OR uma.user_id IS NOT NULL
        ORDER BY l.name`,
    )
    .bind(userId)
    .all<LabelRow>();
  return results ?? [];
}

export interface ThreadLabel {
  id: string;
  name: string;
  color: string | null;
}

// Labels applied to a single thread (via any of its messages). Distinct so
// the same label appearing on multiple messages collapses into one row.
export async function listThreadLabels(threadId: string): Promise<ThreadLabel[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT DISTINCT l.id, l.name, l.color
         FROM labels l
         INNER JOIN message_labels ml ON ml.label_id = l.id
         INNER JOIN messages m ON m.id = ml.message_id
        WHERE m.thread_id = ?
        ORDER BY l.name`,
    )
    .bind(threadId)
    .all<ThreadLabel>();
  return results ?? [];
}

// Single-query label fetch for an entire thread list. Used by ThreadList
// rendering when the per-thread labels haven't been folded into the main
// listThreads aggregate (e.g. callers that pre-loaded threads elsewhere).
export async function bulkLoadThreadLabels(
  threadIds: string[],
): Promise<Map<string, ThreadLabel[]>> {
  const out = new Map<string, ThreadLabel[]>();
  if (threadIds.length === 0) return out;

  // D1 supports up to ~100 bound params per statement comfortably. The
  // inbox list is capped at 200 elsewhere, but bulkLoad callers will
  // typically be under that.
  const placeholders = threadIds.map(() => "?").join(",");
  const { results } = await getDb()
    .prepare(
      `SELECT DISTINCT m.thread_id AS thread_id, l.id, l.name, l.color
         FROM labels l
         INNER JOIN message_labels ml ON ml.label_id = l.id
         INNER JOIN messages m ON m.id = ml.message_id
        WHERE m.thread_id IN (${placeholders})
        ORDER BY l.name`,
    )
    .bind(...threadIds)
    .all<ThreadLabel & { thread_id: string }>();

  for (const row of results ?? []) {
    const arr = out.get(row.thread_id) ?? [];
    arr.push({ id: row.id, name: row.name, color: row.color });
    out.set(row.thread_id, arr);
  }
  return out;
}

// True if the user can rename/delete the label. For mailbox-scoped labels,
// require owner role on that mailbox. For global labels, v1 lets anyone
// signed in manage them — see file header for the gap.
export async function canManageLabel(
  userId: string,
  labelId: string,
): Promise<boolean> {
  const label = await getDb()
    .prepare("SELECT id, mailbox_id FROM labels WHERE id = ?")
    .bind(labelId)
    .first<{ id: string; mailbox_id: string | null }>();
  if (!label) return false;
  if (label.mailbox_id == null) return true; // v1 global gap
  return isMailboxOwner(userId, label.mailbox_id);
}

// True if the user may apply this label to this thread. Requires:
//   1. some access role on the thread's mailbox, AND
//   2. the label is global OR scoped to the same mailbox as the thread.
export async function canApplyLabelToThread(
  userId: string,
  labelId: string,
  threadId: string,
): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `SELECT t.mailbox_id AS thread_mailbox_id,
              l.mailbox_id AS label_mailbox_id,
              uma.user_id AS access_user
         FROM threads t
         LEFT JOIN labels l ON l.id = ?2
         LEFT JOIN user_mailbox_access uma
           ON uma.mailbox_id = t.mailbox_id AND uma.user_id = ?1
        WHERE t.id = ?3`,
    )
    .bind(userId, labelId, threadId)
    .first<{
      thread_mailbox_id: string | null;
      label_mailbox_id: string | null;
      access_user: string | null;
    }>();

  if (!row) return false;
  if (!row.access_user) return false;
  if (row.label_mailbox_id == null) return true; // global label
  return row.label_mailbox_id === row.thread_mailbox_id;
}
