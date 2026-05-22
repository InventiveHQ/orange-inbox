import { getDb } from "./db";

// Per-mailbox audit log (issue #28). Every mutation we expose at the API
// boundary calls logAudit() with a (userId, mailboxId, action) tuple plus an
// optional thread_id + action-specific JSON payload.
//
// Hard invariant: logAudit must never throw. Audit-log failures should never
// break a user-visible mutation. Every call site wraps the insert in a
// try/catch already, but we belt-and-suspenders here too so an unhandled
// rejection in the audit path can never surface as a 500.

export type AuditAction =
  | "read"
  | "reply"
  | "archive"
  | "unarchive"
  | "delete"
  | "label_add"
  | "label_remove"
  | "assign"
  | "unassign"
  | "resolve"
  | "reopen"
  | "note_add"
  | "mute"
  | "unmute"
  | "pin"
  | "unpin"
  | "star"
  | "unstar"
  | "mark_unread"
  | "kanban_move";

export interface LogAuditInput {
  userId: string;
  mailboxId: string;
  threadId?: string | null;
  action: AuditAction;
  payload?: Record<string, unknown> | null;
}

export async function logAudit(input: LogAuditInput): Promise<void> {
  try {
    const id = crypto.randomUUID();
    const payloadJson = input.payload ? JSON.stringify(input.payload) : null;
    await getDb()
      .prepare(
        `INSERT INTO audit_log (id, mailbox_id, user_id, thread_id, action, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.mailboxId,
        input.userId,
        input.threadId ?? null,
        input.action,
        payloadJson,
      )
      .run();
  } catch (err) {
    // Best-effort: never throw. The caller already swallowed errors but we
    // double-up here so any future caller that forgets to wrap can't break
    // the parent mutation.
    console.error("logAudit failed", err);
  }
}

// Resolve a thread's mailbox_id from threads_index. Convenience helper for
// audit hooks that have a threadId but not a mailboxId (e.g. label
// apply/remove, delete). Returns null if the thread doesn't exist or has been
// cleaned up — in which case the caller skips the audit insert.
export async function mailboxIdForThread(threadId: string): Promise<string | null> {
  try {
    const row = await getDb()
      .prepare("SELECT mailbox_id FROM threads_index WHERE thread_id = ?")
      .bind(threadId)
      .first<{ mailbox_id: string }>();
    return row?.mailbox_id ?? null;
  } catch (err) {
    console.error("mailboxIdForThread failed", err);
    return null;
  }
}

export interface AuditLogRow {
  id: string;
  mailbox_id: string;
  user_id: string;
  thread_id: string | null;
  action: AuditAction;
  payload: string | null;
  created_at: number;
  // Joined-in for the view: who performed the action (email/display_name) and
  // — when the entry references a thread — its subject for context. Both
  // optional since users can be deleted via cascade and threads can be
  // deleted hard.
  user_email: string | null;
  user_display_name: string | null;
  thread_subject: string | null;
}

// Per-mailbox audit log. Caller must already have verified the user is a
// member of the mailbox (the API route does this before calling us). Newest
// first; we cap at `limit` rows since the table grows fast on busy mailboxes.
export async function listAuditLog(
  mailboxId: string,
  opts: { limit?: number } = {},
): Promise<AuditLogRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const { results } = await getDb()
    .prepare(
      `SELECT al.id, al.mailbox_id, al.user_id, al.thread_id, al.action,
              al.payload, al.created_at,
              u.email          AS user_email,
              u.display_name   AS user_display_name,
              ti.subject_normalized AS thread_subject
         FROM audit_log al
         LEFT JOIN users u            ON u.id = al.user_id
         LEFT JOIN threads_index ti   ON ti.thread_id = al.thread_id
        WHERE al.mailbox_id = ?
        ORDER BY al.created_at DESC
        LIMIT ?`,
    )
    .bind(mailboxId, limit)
    .all<AuditLogRow>();
  return results ?? [];
}

// True if the user has any access role on the mailbox. Audit-log viewing is
// member-or-admin: any member of a shared mailbox can see who did what on
// that mailbox's threads (the whole point of the feature).
export async function userCanReadAuditLog(
  userId: string,
  mailboxId: string,
): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `SELECT 1 FROM user_mailbox_access
        WHERE mailbox_id = ? AND user_id = ?
        LIMIT 1`,
    )
    .bind(mailboxId, userId)
    .first();
  return row !== null;
}
