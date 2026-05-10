import { getDb } from "./db";
import { getMailDbForThread } from "./mail-db";

// Helpers for the block-sender / report-spam flows (issue #74). Block-sender
// adds a row to blocked_senders so the email-worker can suppress future
// inbound from that (mailbox, addr) pair; report-spam additionally stamps
// `spam_reported_by_user_id` on the offending message so a future classifier
// can treat the corpus as labelled training data.

export interface MessageContext {
  messageId: string;
  threadId: string;
  mailboxId: string;
  fromAddr: string;
}

// Resolves a message id the user is allowed to act on. Returns null if the
// message doesn't exist or the user has no access to its mailbox.
//
// Joins messages (mail-plane) with user_mailbox_access (control-plane) in a
// single SELECT — works for the common single-DB deploy. Overflow-DB
// deploys are an existing limitation across the messages/* routes (see
// web/src/app/api/messages/[id]/raw/route.ts).
export async function lookupMessageForUser(
  userId: string,
  messageId: string,
): Promise<MessageContext | null> {
  const row = await getDb()
    .prepare(
      `SELECT m.id AS message_id, m.thread_id, m.mailbox_id, m.from_addr
         FROM messages m
         INNER JOIN user_mailbox_access uma
                 ON uma.mailbox_id = m.mailbox_id AND uma.user_id = ?
        WHERE m.id = ?
        LIMIT 1`,
    )
    .bind(userId, messageId)
    .first<{
      message_id: string;
      thread_id: string;
      mailbox_id: string;
      from_addr: string;
    }>();
  if (!row) return null;
  return {
    messageId: row.message_id,
    threadId: row.thread_id,
    mailboxId: row.mailbox_id,
    fromAddr: row.from_addr,
  };
}

// Insert a (mailbox, addr) into blocked_senders and archive the thread that
// raised the action. Lowercases addr so the email-worker's case-insensitive
// match works as expected. Idempotent — re-blocking is a no-op.
export async function blockSenderAndArchiveThread(
  ctx: MessageContext,
): Promise<void> {
  const addr = ctx.fromAddr.trim().toLowerCase();
  await getDb().batch([
    getDb()
      .prepare(
        `INSERT INTO blocked_senders (mailbox_id, addr)
         VALUES (?, ?)
         ON CONFLICT (mailbox_id, addr) DO NOTHING`,
      )
      .bind(ctx.mailboxId, addr),
    getDb()
      .prepare("UPDATE threads_index SET archived = 1, unread_count = 0 WHERE thread_id = ?")
      .bind(ctx.threadId),
  ]);
}

// Set `messages.spam_reported_by_user_id` on a single message. Lives in the
// mail DB the message's thread is pinned to.
export async function flagMessageAsSpamReported(
  ctx: MessageContext,
  userId: string,
): Promise<void> {
  const mailDb = await getMailDbForThread(ctx.threadId);
  await mailDb
    .prepare("UPDATE messages SET spam_reported_by_user_id = ? WHERE id = ?")
    .bind(userId, ctx.messageId)
    .run();
}
