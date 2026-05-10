import { getDb } from "./db";
import { logAudit } from "./audit";

// Internal-only notes on a thread (issue #27). Notes are visible to every
// member of the thread's mailbox; only the author can delete their own.
// Notes never leave the inbox — they're not part of the outbound reply chain.

export interface ThreadNote {
  id: string;
  thread_id: string;
  user_id: string;
  body: string;
  created_at: number;
  // Joined-in for rendering. Both nullable because users can be cascade-
  // deleted (the FK takes the note with them, but a stale read can still
  // race the cascade).
  user_email: string | null;
  user_display_name: string | null;
}

// List the notes on a thread. Caller must have already verified the user has
// access to the thread (via threads_index + user_mailbox_access); the API
// route enforces this before calling.
export async function listNotes(threadId: string): Promise<ThreadNote[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT n.id, n.thread_id, n.user_id, n.body, n.created_at,
              u.email        AS user_email,
              u.display_name AS user_display_name
         FROM thread_notes n
         LEFT JOIN users u ON u.id = n.user_id
        WHERE n.thread_id = ?
        ORDER BY n.created_at ASC`,
    )
    .bind(threadId)
    .all<ThreadNote>();
  return results ?? [];
}

export type AddNoteResult =
  | { ok: true; note: ThreadNote }
  | { ok: false; code: "forbidden" | "not_found" | "empty" };

// Add an internal note to a thread. Caller must be a member of the thread's
// mailbox. Empty bodies (after trim) are rejected — there's no use case for
// a blank note and surfacing the empty-trim policy here keeps the API route
// thin.
export async function addNote(
  threadId: string,
  userId: string,
  body: string,
): Promise<AddNoteResult> {
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, code: "empty" };

  // Access check: thread must exist + user must have any role on its mailbox.
  const row = await getDb()
    .prepare(
      `SELECT ti.mailbox_id AS mailbox_id,
              uma.user_id   AS access_user
         FROM threads_index ti
         LEFT JOIN user_mailbox_access uma
           ON uma.mailbox_id = ti.mailbox_id AND uma.user_id = ?
        WHERE ti.thread_id = ?`,
    )
    .bind(userId, threadId)
    .first<{ mailbox_id: string | null; access_user: string | null }>();
  if (!row || !row.mailbox_id) return { ok: false, code: "not_found" };
  if (!row.access_user) return { ok: false, code: "forbidden" };

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .prepare(
      `INSERT INTO thread_notes (id, thread_id, user_id, body, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, threadId, userId, trimmed, now)
    .run();

  await logAudit({
    userId,
    mailboxId: row.mailbox_id,
    threadId,
    action: "note_add",
    payload: { note_id: id },
  });

  // Re-fetch via listNotes-style join so the returned shape matches the API.
  const inserted = await getDb()
    .prepare(
      `SELECT n.id, n.thread_id, n.user_id, n.body, n.created_at,
              u.email        AS user_email,
              u.display_name AS user_display_name
         FROM thread_notes n
         LEFT JOIN users u ON u.id = n.user_id
        WHERE n.id = ?`,
    )
    .bind(id)
    .first<ThreadNote>();
  if (!inserted) return { ok: false, code: "not_found" };
  return { ok: true, note: inserted };
}

export type DeleteNoteResult =
  | { ok: true }
  | { ok: false; code: "forbidden" | "not_found" };

// Delete a note. Only the author can delete — not the mailbox owner, not the
// admin. Notes are personal entries: surfacing "Sean deleted Jamie's note"
// would erode trust in the audit trail more than it'd help.
export async function deleteNote(
  noteId: string,
  userId: string,
): Promise<DeleteNoteResult> {
  const note = await getDb()
    .prepare(
      `SELECT id, thread_id, user_id FROM thread_notes WHERE id = ?`,
    )
    .bind(noteId)
    .first<{ id: string; thread_id: string; user_id: string }>();
  if (!note) return { ok: false, code: "not_found" };
  if (note.user_id !== userId) return { ok: false, code: "forbidden" };

  await getDb().prepare("DELETE FROM thread_notes WHERE id = ?").bind(noteId).run();
  return { ok: true };
}
