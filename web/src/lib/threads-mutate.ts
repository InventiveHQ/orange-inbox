import { getDb } from "./db";
import { getMailDbForThread } from "./mail-db";

// Whether the user has any role on the mailbox that owns this thread.
// Used to gate every thread-level mutation we expose. Reads from
// threads_index (control DB) so it works regardless of which mail DB the
// thread's messages live in.
export async function userCanAccessThread(userId: string, threadId: string): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `SELECT 1
         FROM threads_index ti
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = ti.mailbox_id
        WHERE ti.thread_id = ? AND uma.user_id = ?
        LIMIT 1`,
    )
    .bind(threadId, userId)
    .first();
  return row !== null;
}

// Mark every unread message in a thread as read and zero the thread's
// unread_count. Per-message read flags live in the thread's mail DB; the
// thread-level counter is on threads_index in control. Both are updated.
// Idempotent — calling on an already-read thread is a no-op.
export async function markThreadRead(userId: string, threadId: string): Promise<void> {
  if (!(await userCanAccessThread(userId, threadId))) return;

  const controlDb = getDb();
  const mailDb = await getMailDbForThread(threadId);
  await Promise.all([
    mailDb
      .prepare("UPDATE messages SET read = 1 WHERE thread_id = ? AND read = 0")
      .bind(threadId)
      .run(),
    controlDb
      .prepare("UPDATE threads_index SET unread_count = 0 WHERE thread_id = ?")
      .bind(threadId)
      .run(),
  ]);
}
