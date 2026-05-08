import { getDb } from "./db";

// Whether the user has any role on the mailbox that owns this thread.
// Used to gate every thread-level mutation we expose.
export async function userCanAccessThread(userId: string, threadId: string): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `SELECT 1
         FROM threads t
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = t.mailbox_id
        WHERE t.id = ? AND uma.user_id = ?
        LIMIT 1`,
    )
    .bind(threadId, userId)
    .first();
  return row !== null;
}

// Mark every unread message in a thread as read and zero the thread's
// unread_count, in a single batch. Idempotent — calling on an already-read
// thread is a no-op.
export async function markThreadRead(userId: string, threadId: string): Promise<void> {
  if (!(await userCanAccessThread(userId, threadId))) return;

  const db = getDb();
  await db.batch([
    db
      .prepare("UPDATE messages SET read = 1 WHERE thread_id = ? AND read = 0")
      .bind(threadId),
    db
      .prepare("UPDATE threads SET unread_count = 0 WHERE id = ?")
      .bind(threadId),
  ]);
}
