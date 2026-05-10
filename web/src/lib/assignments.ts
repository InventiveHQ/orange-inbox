import { getDb } from "./db";
import { logAudit } from "./audit";
import type { ThreadListItem } from "./queries";

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
  // Resolve lifecycle (0048). NULL = active (still in the assignee's queue);
  // non-null = resolved, dropped from /inbox/assigned but the row persists
  // for audit/history. `resolved_by` is the user who hit Resolve — not
  // necessarily the assignee (anyone with mailbox access can resolve).
  resolved_at: number | null;
  resolved_by: string | null;
  // Joined-in for the UI. Both nullable because the user row can have been
  // cascade-deleted (the assignment row also vanishes via FK cascade, but a
  // best-effort query elsewhere might race the cascade).
  assignee_email: string | null;
  assignee_display_name: string | null;
  resolved_by_email: string | null;
  resolved_by_display_name: string | null;
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
              ta.resolved_at, ta.resolved_by,
              u.email         AS assignee_email,
              u.display_name  AS assignee_display_name,
              ru.email        AS resolved_by_email,
              ru.display_name AS resolved_by_display_name
         FROM thread_assignments ta
         LEFT JOIN users u  ON u.id  = ta.assignee_id
         LEFT JOIN users ru ON ru.id = ta.resolved_by
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
              ta.resolved_at, ta.resolved_by,
              u.email         AS assignee_email,
              u.display_name  AS assignee_display_name,
              ru.email        AS resolved_by_email,
              ru.display_name AS resolved_by_display_name
         FROM thread_assignments ta
         LEFT JOIN users u  ON u.id  = ta.assignee_id
         LEFT JOIN users ru ON ru.id = ta.resolved_by
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
  // one. Re-assigning a resolved thread clears the resolved state so the
  // lifecycle restarts cleanly under the new assignee. The `assigned_at`
  // default fires on INSERT only — explicit unixepoch() bind so REPLACE
  // refreshes it too.
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .prepare(
      `INSERT INTO thread_assignments (thread_id, assignee_id, assigned_by, assigned_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (thread_id) DO UPDATE
         SET assignee_id = excluded.assignee_id,
             assigned_by = excluded.assigned_by,
             assigned_at = excluded.assigned_at,
             resolved_at = NULL,
             resolved_by = NULL`,
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

// Resolve / reopen lifecycle (#99). Resolving an assignment marks it as
// closed-out — `resolved_at` is set and `resolved_by` records who clicked
// Resolve (not always the assignee). The row stays in `thread_assignments`
// so the resolved-history view can list it; `listAssignedToUser` filters
// `resolved_at IS NULL` to keep the active list focused. Reopen flips both
// columns back to NULL.
//
// Permission: caller must be a member of the thread's mailbox. We don't
// require caller == assignee — a teammate often closes out somebody else's
// claim once the customer reply lands and the assignee is offline.

export type ResolveResult =
  | { ok: true; assignment: ThreadAssignment }
  | { ok: false; code: "forbidden" | "not_found" | "not_assigned" | "already_resolved" };

export async function resolveAssignment(
  threadId: string,
  byUserId: string,
): Promise<ResolveResult> {
  const row = await getDb()
    .prepare(
      `SELECT ti.mailbox_id  AS mailbox_id,
              uma.user_id    AS by_access,
              ta.assignee_id AS assignee_id,
              ta.resolved_at AS resolved_at
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
      assignee_id: string | null;
      resolved_at: number | null;
    }>();
  if (!row || !row.mailbox_id) return { ok: false, code: "not_found" };
  if (!row.by_access) return { ok: false, code: "forbidden" };
  if (!row.assignee_id) return { ok: false, code: "not_assigned" };
  if (row.resolved_at !== null) return { ok: false, code: "already_resolved" };

  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .prepare(
      `UPDATE thread_assignments
          SET resolved_at = ?, resolved_by = ?
        WHERE thread_id = ?`,
    )
    .bind(now, byUserId, threadId)
    .run();

  await logAudit({
    userId: byUserId,
    mailboxId: row.mailbox_id,
    threadId,
    action: "resolve",
    payload: { assignee_id: row.assignee_id },
  });

  const assignment = await getAssignment(threadId);
  if (!assignment) return { ok: false, code: "not_found" };
  return { ok: true, assignment };
}

// Reopen — flip a previously-resolved assignment back to active. Mirrors
// the resolve-permission shape (must be mailbox member; doesn't require
// caller to be the assignee or the original resolver). Idempotent on
// already-active rows so a stale tab calling DELETE doesn't 400.
export async function reopenAssignment(
  threadId: string,
  byUserId: string,
): Promise<ResolveResult> {
  const row = await getDb()
    .prepare(
      `SELECT ti.mailbox_id  AS mailbox_id,
              uma.user_id    AS by_access,
              ta.assignee_id AS assignee_id,
              ta.resolved_at AS resolved_at
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
      assignee_id: string | null;
      resolved_at: number | null;
    }>();
  if (!row || !row.mailbox_id) return { ok: false, code: "not_found" };
  if (!row.by_access) return { ok: false, code: "forbidden" };
  if (!row.assignee_id) return { ok: false, code: "not_assigned" };
  if (row.resolved_at !== null) {
    await getDb()
      .prepare(
        `UPDATE thread_assignments
            SET resolved_at = NULL, resolved_by = NULL
          WHERE thread_id = ?`,
      )
      .bind(threadId)
      .run();

    await logAudit({
      userId: byUserId,
      mailboxId: row.mailbox_id,
      threadId,
      action: "reopen",
      payload: { assignee_id: row.assignee_id },
    });
  }

  const assignment = await getAssignment(threadId);
  if (!assignment) return { ok: false, code: "not_found" };
  return { ok: true, assignment };
}

// Resolved-history row for the /inbox/assigned ?status=resolved tab (#99).
// Same shape as ThreadListItem (so the list renderer can share most of the
// markup) plus the resolution metadata the row needs to surface.
export interface ResolvedAssignmentItem extends ThreadListItem {
  resolved_at: number;
  resolved_by_id: string | null;
  resolved_by_email: string | null;
  resolved_by_display_name: string | null;
}

interface ResolvedAssignmentRow {
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
  resolved_at: number;
  resolved_by_id: string | null;
  resolved_by_email: string | null;
  resolved_by_display_name: string | null;
}

// Resolved assignments belonging to `userId` (assignee). Cross-mailbox by
// design — same scoping as the active list. Caller still has read access at
// query time (user_mailbox_access join) so a user removed from a mailbox
// after resolving a thread there won't see ghosts in the resolved tab.
//
// Lives in assignments.ts (not queries.ts) because it's tightly coupled to
// the resolve/reopen lifecycle — the SQL is the active query with the
// resolved_at filter inverted plus a LEFT JOIN on users for the
// "Resolved by …" pill.
export async function listAssignedToUserResolved(
  userId: string,
  opts: { limit?: number } = {},
): Promise<ResolvedAssignmentItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
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
      ) AS labels_json,
      ta.resolved_at AS resolved_at,
      ta.resolved_by AS resolved_by_id,
      ru.email        AS resolved_by_email,
      ru.display_name AS resolved_by_display_name
    FROM thread_assignments ta
    INNER JOIN threads_index ti ON ti.thread_id = ta.thread_id
    INNER JOIN mailboxes mb     ON mb.id = ti.mailbox_id
    INNER JOIN domains d        ON d.id = mb.domain_id
    INNER JOIN user_mailbox_access uma
            ON uma.mailbox_id = ti.mailbox_id AND uma.user_id = ?1
    LEFT JOIN users ru          ON ru.id = ta.resolved_by
    WHERE ta.assignee_id = ?1
      AND ta.resolved_at IS NOT NULL
    ORDER BY ta.resolved_at DESC
    LIMIT ?
  `;
  const { results } = await getDb()
    .prepare(sql)
    .bind(userId, limit)
    .all<ResolvedAssignmentRow>();
  return (results ?? []).map(parseResolvedRow);
}

function parseResolvedRow(row: ResolvedAssignmentRow): ResolvedAssignmentItem {
  let labels: ThreadListItem["labels"] = [];
  if (row.labels_json) {
    try {
      const parsed = JSON.parse(row.labels_json) as ThreadListItem["labels"];
      labels = Array.isArray(parsed) ? parsed.filter(l => l && typeof l.id === "string") : [];
    } catch {
      labels = [];
    }
  }
  return {
    id: row.id,
    subject_normalized: row.subject_normalized,
    last_message_at: row.last_message_at,
    message_count: row.message_count,
    unread_count: row.unread_count,
    starred: row.starred,
    archived: row.archived,
    muted: row.muted,
    pinned: row.pinned,
    follow_up_enabled: row.follow_up_enabled,
    follow_up_days: row.follow_up_days,
    follow_up_minutes: row.follow_up_minutes,
    domain_id: row.domain_id,
    domain_name: row.domain_name,
    mailbox_id: row.mailbox_id,
    mailbox_local_part: row.mailbox_local_part,
    last_subject: row.last_subject,
    last_from_addr: row.last_from_addr,
    last_from_name: row.last_from_name,
    last_snippet: row.last_snippet,
    labels,
    resolved_at: row.resolved_at,
    resolved_by_id: row.resolved_by_id,
    resolved_by_email: row.resolved_by_email,
    resolved_by_display_name: row.resolved_by_display_name,
  };
}
