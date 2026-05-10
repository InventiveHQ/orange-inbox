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

// Toggle the muted flag on a thread. Muted threads are hidden from the
// per-mailbox inbox and stay archived when new replies arrive — handled
// in email-worker/store.ts on inbound by reading threads_index.muted.
export async function muteThread(
  userId: string,
  threadId: string,
  muted: boolean,
): Promise<void> {
  if (!(await userCanAccessThread(userId, threadId))) return;
  await getDb()
    .prepare("UPDATE threads_index SET muted = ? WHERE thread_id = ?")
    .bind(muted ? 1 : 0, threadId)
    .run();
}

// Toggle the pinned flag on a thread. Pinned threads sort to the top of
// the inbox regardless of last_message_at — listThreads orders by
// `pinned DESC, last_message_at DESC`. Pin is purely a UI affordance:
// archive/snooze/mute still apply normally.
export async function pinThread(
  userId: string,
  threadId: string,
  pinned: boolean,
): Promise<void> {
  if (!(await userCanAccessThread(userId, threadId))) return;
  await getDb()
    .prepare("UPDATE threads_index SET pinned = ? WHERE thread_id = ?")
    .bind(pinned ? 1 : 0, threadId)
    .run();
}

// Set or clear the reminder timestamp on a thread (issue #75). Pass a
// future unix-seconds value to set, or null to clear. Different from
// snooze: the thread stays visible in current views while reminded, and
// the reader pops a "Reminder due" banner once `remind_at <= now()`.
export async function remindThread(
  userId: string,
  threadId: string,
  remindAt: number | null,
): Promise<void> {
  if (!(await userCanAccessThread(userId, threadId))) return;
  await getDb()
    .prepare("UPDATE threads_index SET remind_at = ? WHERE thread_id = ?")
    .bind(remindAt, threadId)
    .run();
}
