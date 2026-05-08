import { getDb } from "./db";

// Helpers that return prepared-statement lists for the DELETE handlers to
// batch alongside their parent delete. Keeping the inserts as SELECTs (rather
// than two-step "fetch then loop") means everything happens in one D1 batch
// — DB cascade and tombstone insertion succeed or fail together.

export function tombstoneStatementsForThread(threadId: string): D1PreparedStatement[] {
  const db = getDb();
  return [
    // Raw .eml — every message has one.
    db
      .prepare(
        `INSERT INTO r2_tombstones (bucket, r2_key)
           SELECT 'RAW_MAIL', raw_r2_key FROM messages WHERE thread_id = ?`,
      )
      .bind(threadId),
    // HTML body — only present on messages that had an html part on ingest.
    db
      .prepare(
        `INSERT INTO r2_tombstones (bucket, r2_key)
           SELECT 'RAW_MAIL', html_r2_key
             FROM messages
            WHERE thread_id = ? AND html_r2_key IS NOT NULL`,
      )
      .bind(threadId),
    // Attachment blobs — joined back through messages.
    db
      .prepare(
        `INSERT INTO r2_tombstones (bucket, r2_key)
           SELECT 'ATTACHMENTS', a.r2_key
             FROM attachments a
             INNER JOIN messages m ON m.id = a.message_id
            WHERE m.thread_id = ?`,
      )
      .bind(threadId),
  ];
}

export function tombstoneStatementsForMailbox(mailboxId: string): D1PreparedStatement[] {
  const db = getDb();
  return [
    db
      .prepare(
        `INSERT INTO r2_tombstones (bucket, r2_key)
           SELECT 'RAW_MAIL', raw_r2_key FROM messages WHERE mailbox_id = ?`,
      )
      .bind(mailboxId),
    db
      .prepare(
        `INSERT INTO r2_tombstones (bucket, r2_key)
           SELECT 'RAW_MAIL', html_r2_key
             FROM messages
            WHERE mailbox_id = ? AND html_r2_key IS NOT NULL`,
      )
      .bind(mailboxId),
    db
      .prepare(
        `INSERT INTO r2_tombstones (bucket, r2_key)
           SELECT 'ATTACHMENTS', a.r2_key
             FROM attachments a
             INNER JOIN messages m ON m.id = a.message_id
            WHERE m.mailbox_id = ?`,
      )
      .bind(mailboxId),
  ];
}
