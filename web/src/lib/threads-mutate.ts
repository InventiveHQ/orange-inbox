import { getDb } from "./db";
import { getMailDbForThread } from "./mail-db";
import { logAudit, mailboxIdForThread } from "./audit";

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

  // Audit: never throw. mailboxIdForThread already swallows errors.
  try {
    const mailboxId = await mailboxIdForThread(threadId);
    if (mailboxId) {
      await logAudit({ userId, mailboxId, threadId, action: "read" });
    }
  } catch (err) {
    console.error("audit markThreadRead failed", err);
  }
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
  try {
    const mailboxId = await mailboxIdForThread(threadId);
    if (mailboxId) {
      await logAudit({
        userId,
        mailboxId,
        threadId,
        action: muted ? "mute" : "unmute",
      });
    }
  } catch (err) {
    console.error("audit muteThread failed", err);
  }
}

// Toggle the pinned flag on a thread. Pinned threads sort to the top of
// the inbox regardless of last_message_at — listThreads orders by
// `pinned DESC, last_message_at DESC`. Pin is purely a UI affordance:
// archive/mute still apply normally.
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
  try {
    const mailboxId = await mailboxIdForThread(threadId);
    if (mailboxId) {
      await logAudit({
        userId,
        mailboxId,
        threadId,
        action: pinned ? "pin" : "unpin",
      });
    }
  } catch (err) {
    console.error("audit pinThread failed", err);
  }
}

// Toggle follow-up on a thread (issue #26 + sub-day cadences via
// migration 0051). When enabled, the thread becomes a candidate for
// the Follow-ups view: it surfaces once `last_message_at` is older
// than `minutes` (or the global default) AND the most-recent message
// is outbound. Passing `minutes = null` clears the per-thread override
// so the global default kicks back in. Disabling follow-up
// (enabled = false) leaves `follow_up_minutes` alone so re-enabling
// preserves the user's previously chosen cadence.
export async function setFollowUp(
  userId: string,
  threadId: string,
  enabled: boolean,
  minutes?: number | null,
): Promise<void> {
  if (!(await userCanAccessThread(userId, threadId))) return;
  if (minutes === undefined) {
    await getDb()
      .prepare(
        "UPDATE threads_index SET follow_up_enabled = ? WHERE thread_id = ?",
      )
      .bind(enabled ? 1 : 0, threadId)
      .run();
    return;
  }
  // Setting minutes also clears the legacy days override so reads
  // aren't ambiguous between the two columns.
  await getDb()
    .prepare(
      "UPDATE threads_index SET follow_up_enabled = ?, follow_up_minutes = ?, follow_up_days = NULL WHERE thread_id = ?",
    )
    .bind(enabled ? 1 : 0, minutes, threadId)
    .run();
}
