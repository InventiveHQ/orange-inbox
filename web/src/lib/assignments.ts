import { getDb } from "./db";
import { logAudit } from "./audit";

// Shared-mailbox assignment (issue #27). A thread has at most one assignee
// (PK on thread_id in thread_assignments). The "Claim" action is just
// assignThread(threadId, currentUserId, currentUserId); "Assign to X" passes
// a different assigneeId.
//
// Permission model: assigner AND assignee must both be members of the
// thread's mailbox. We enforce both ends — assigner so a random user can't
// poke at someone else's mailbox; assignee so a thread can't be assigned to
// somebody who can't actually see it.

export interface ThreadAssignment {
  thread_id: string;
  assignee_id: string;
  assigned_by: string;
  assigned_at: number;
  // Joined-in for the UI. Both nullable because the user row can have been
  // cascade-deleted (the assignment row also vanishes via FK cascade, but a
  // best-effort query elsewhere might race the cascade).
  assignee_email: string | null;
  assignee_display_name: string | null;
}

// Fetch the current assignment for a thread (NULL when nobody is assigned).
// Resolves assignee email/display_name in the same query so the UI doesn't
// need a second lookup.
export async function getAssignment(
  threadId: string,
): Promise<ThreadAssignment | null> {
  const row = await getDb()
    .prepare(
      `SELECT ta.thread_id, ta.assignee_id, ta.assigned_by, ta.assigned_at,
              u.email        AS assignee_email,
              u.display_name AS assignee_display_name
         FROM thread_assignments ta
         LEFT JOIN users u ON u.id = ta.assignee_id
        WHERE ta.thread_id = ?`,
    )
    .bind(threadId)
    .first<ThreadAssignment>();
  return row ?? null;
}

// Bulk variant for the "Assigned to me" listing — callers pre-filter by
// assignee_id via listAssignedToUser in queries.ts so this isn't strictly
// needed there, but exposed for any future "show assignees on the inbox row"
// rendering.
export async function bulkGetAssignments(
  threadIds: string[],
): Promise<Map<string, ThreadAssignment>> {
  const out = new Map<string, ThreadAssignment>();
  if (threadIds.length === 0) return out;
  const placeholders = threadIds.map(() => "?").join(",");
  const { results } = await getDb()
    .prepare(
      `SELECT ta.thread_id, ta.assignee_id, ta.assigned_by, ta.assigned_at,
              u.email        AS assignee_email,
              u.display_name AS assignee_display_name
         FROM thread_assignments ta
         LEFT JOIN users u ON u.id = ta.assignee_id
        WHERE ta.thread_id IN (${placeholders})`,
    )
    .bind(...threadIds)
    .all<ThreadAssignment>();
  for (const r of results ?? []) out.set(r.thread_id, r);
  return out;
}

export type AssignResult =
  | { ok: true; assignment: ThreadAssignment }
  | { ok: false; code: "forbidden" | "not_found" | "assignee_not_member" };

// Set the assignee on a thread. Replaces any existing assignment (idempotent
// for the same assignee — INSERT OR REPLACE). Records an audit_log entry on
// success.
export async function assignThread(
  threadId: string,
  assigneeId: string,
  byUserId: string,
): Promise<AssignResult> {
  // Resolve the thread's mailbox and confirm assigner has access in one shot.
  const row = await getDb()
    .prepare(
      `SELECT ti.mailbox_id AS mailbox_id,
              uma.user_id   AS by_access
         FROM threads_index ti
         LEFT JOIN user_mailbox_access uma
           ON uma.mailbox_id = ti.mailbox_id AND uma.user_id = ?
        WHERE ti.thread_id = ?`,
    )
    .bind(byUserId, threadId)
    .first<{ mailbox_id: string | null; by_access: string | null }>();
  if (!row || !row.mailbox_id) return { ok: false, code: "not_found" };
  if (!row.by_access) return { ok: false, code: "forbidden" };

  // Assignee must also be a member of the mailbox. Self-claim (byUserId ===
  // assigneeId) short-circuits the check since we already know byUserId is a
  // member.
  if (assigneeId !== byUserId) {
    const member = await getDb()
      .prepare(
        `SELECT 1 FROM user_mailbox_access
          WHERE mailbox_id = ? AND user_id = ? LIMIT 1`,
      )
      .bind(row.mailbox_id, assigneeId)
      .first();
    if (!member) return { ok: false, code: "assignee_not_member" };
  }

  // Upsert: a second assign on the same thread silently replaces the previous
  // one. The `assigned_at` default fires on INSERT only — explicit unixepoch()
  // bind so REPLACE refreshes it too.
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .prepare(
      `INSERT INTO thread_assignments (thread_id, assignee_id, assigned_by, assigned_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (thread_id) DO UPDATE
         SET assignee_id = excluded.assignee_id,
             assigned_by = excluded.assigned_by,
             assigned_at = excluded.assigned_at`,
    )
    .bind(threadId, assigneeId, byUserId, now)
    .run();

  await logAudit({
    userId: byUserId,
    mailboxId: row.mailbox_id,
    threadId,
    action: "assign",
    payload: { assignee_id: assigneeId },
  });

  const assignment = await getAssignment(threadId);
  if (!assignment) return { ok: false, code: "not_found" }; // shouldn't happen
  return { ok: true, assignment };
}

export type UnassignResult =
  | { ok: true }
  | { ok: false; code: "forbidden" | "not_found" };

// Clear the assignment on a thread. Idempotent — calling on an already-
// unassigned thread is a no-op (returns ok). Records an audit entry only if
// there was actually somebody to unassign.
export async function unassignThread(
  threadId: string,
  byUserId: string,
): Promise<UnassignResult> {
  const row = await getDb()
    .prepare(
      `SELECT ti.mailbox_id AS mailbox_id,
              uma.user_id   AS by_access,
              ta.assignee_id AS prior_assignee
         FROM threads_index ti
         LEFT JOIN user_mailbox_access uma
           ON uma.mailbox_id = ti.mailbox_id AND uma.user_id = ?
         LEFT JOIN thread_assignments ta ON ta.thread_id = ti.thread_id
        WHERE ti.thread_id = ?`,
    )
    .bind(byUserId, threadId)
    .first<{
      mailbox_id: string | null;
      by_access: string | null;
      prior_assignee: string | null;
    }>();
  if (!row || !row.mailbox_id) return { ok: false, code: "not_found" };
  if (!row.by_access) return { ok: false, code: "forbidden" };

  await getDb()
    .prepare("DELETE FROM thread_assignments WHERE thread_id = ?")
    .bind(threadId)
    .run();

  if (row.prior_assignee) {
    await logAudit({
      userId: byUserId,
      mailboxId: row.mailbox_id,
      threadId,
      action: "unassign",
      payload: { prior_assignee_id: row.prior_assignee },
    });
  }
  return { ok: true };
}
