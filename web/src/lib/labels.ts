import { getDb } from "./db";
import type { User } from "./auth";

// Labels are Gmail-style tags applied to threads (via message_labels rows).
// A label scoped to a mailbox (mailbox_id NOT NULL) shows up only inside that
// mailbox; mailbox_id NULL = "global" — usable across any mailbox the user
// can access.
//
// OWNERSHIP MODEL: global labels (mailbox_id NULL) are *visible* to every
// signed-in user, but mutation (rename/delete) is restricted by ownership.
// labels.created_by_user_id records the creator; only that user (or an
// admin) may modify or delete a global label — see canManageLabel(). Legacy
// global labels predating this column have created_by_user_id NULL and are
// treated as unowned: only admins may manage them. Mailbox-scoped labels are
// isolated/managed via user_mailbox_access + admin as before. (A separate
// user_label_access table would be needed for per-user sharing of globals.)

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

// Labels applied to a single thread. Reads the denormalised thread_labels
// cache in the control DB (maintained alongside per-message message_labels
// writes by the apply/remove routes) — so this stays a single control-DB
// query no matter which mail DB the thread's messages live in.
export async function listThreadLabels(threadId: string): Promise<ThreadLabel[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT l.id, l.name, l.color
         FROM thread_labels tl
         INNER JOIN labels l ON l.id = tl.label_id
        WHERE tl.thread_id = ?
        ORDER BY l.name`,
    )
    .bind(threadId)
    .all<ThreadLabel>();
  return results ?? [];
}

// Single-query label fetch for an entire thread list. Like listThreadLabels,
// reads exclusively from the control-DB thread_labels cache.
export async function bulkLoadThreadLabels(
  threadIds: string[],
): Promise<Map<string, ThreadLabel[]>> {
  const out = new Map<string, ThreadLabel[]>();
  if (threadIds.length === 0) return out;

  const placeholders = threadIds.map(() => "?").join(",");
  const { results } = await getDb()
    .prepare(
      `SELECT tl.thread_id AS thread_id, l.id, l.name, l.color
         FROM thread_labels tl
         INNER JOIN labels l ON l.id = tl.label_id
        WHERE tl.thread_id IN (${placeholders})
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

// True if the user can rename/delete the label. Mailbox-scoped labels
// require global admin (mailbox management is admin-only). Global labels
// (mailbox_id NULL) require ownership: the creator (created_by_user_id) or
// an admin. Legacy global labels with a NULL created_by_user_id are unowned
// and manageable by admins only — see file header.
export async function canManageLabel(
  user: User,
  labelId: string,
): Promise<boolean> {
  const label = await getDb()
    .prepare("SELECT id, mailbox_id, created_by_user_id FROM labels WHERE id = ?")
    .bind(labelId)
    .first<{
      id: string;
      mailbox_id: string | null;
      created_by_user_id: string | null;
    }>();
  if (!label) return false;
  if (user.is_admin) return true;
  if (label.mailbox_id == null) {
    // Global label: only the recorded owner may manage it. Legacy rows with
    // a NULL owner are unowned and fall through to admins-only above.
    return label.created_by_user_id != null
      && label.created_by_user_id === user.id;
  }
  // Mailbox-scoped labels are admin-only (handled by the is_admin check above).
  return false;
}

// True if the user may apply this label to this thread. Requires:
//   1. some access role on the thread's mailbox, AND
//   2. the label is global OR scoped to the same mailbox as the thread.
//
// Uses threads_index (control DB) instead of the mail-DB threads table so
// this stays a single control-DB query post-overflow.
export async function canApplyLabelToThread(
  userId: string,
  labelId: string,
  threadId: string,
): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `SELECT ti.mailbox_id AS thread_mailbox_id,
              l.mailbox_id  AS label_mailbox_id,
              uma.user_id   AS access_user
         FROM threads_index ti
         LEFT JOIN labels l ON l.id = ?2
         LEFT JOIN user_mailbox_access uma
           ON uma.mailbox_id = ti.mailbox_id AND uma.user_id = ?1
        WHERE ti.thread_id = ?3`,
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
