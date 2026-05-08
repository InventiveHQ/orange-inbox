import type { Env, ParsedMessage } from "./types";
import type { Recipient } from "./route";
import type { ThreadMatch } from "./thread";

export interface StoreResult {
  messageId: string;
  threadId: string;
  duplicate: boolean;
}

export async function storeMessage(
  env: Env,
  recipient: Recipient,
  thread: ThreadMatch,
  parsed: ParsedMessage,
  rawBytes: ArrayBuffer,
): Promise<StoreResult> {
  // Idempotency: if this Message-ID is already stored for this mailbox, bail.
  const existing = await env.DB
    .prepare("SELECT id, thread_id FROM messages WHERE mailbox_id = ? AND message_id_header = ?")
    .bind(recipient.mailboxId, parsed.messageId)
    .first<{ id: string; thread_id: string }>();
  if (existing) {
    return { messageId: existing.id, threadId: existing.thread_id, duplicate: true };
  }

  const messageId = crypto.randomUUID();
  const dateSeconds = Math.floor(parsed.date / 1000);
  const rawKey = `mailbox/${recipient.mailboxId}/${messageId}.eml`;

  await env.RAW_MAIL.put(rawKey, rawBytes, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: { mailbox: recipient.mailboxId, messageId },
  });

  // If the message has an HTML body, store it alongside the raw .eml in R2.
  // The DB row keeps the key; the body itself can be huge, so it lives in R2.
  let htmlR2Key: string | null = null;
  if (parsed.html) {
    htmlR2Key = `mailbox/${recipient.mailboxId}/${messageId}.html`;
    await env.RAW_MAIL.put(htmlR2Key, parsed.html, {
      httpMetadata: { contentType: "text/html" },
      customMetadata: { mailbox: recipient.mailboxId, messageId },
    });
  }

  const attachmentInserts: Array<{ id: string; r2Key: string; a: ParsedMessage["attachments"][number] }> = [];
  for (const a of parsed.attachments) {
    const id = crypto.randomUUID();
    const r2Key = `mailbox/${recipient.mailboxId}/${messageId}/${id}`;
    await env.ATTACHMENTS.put(r2Key, a.bytes, {
      httpMetadata: { contentType: a.contentType },
      customMetadata: a.filename ? { filename: a.filename } : undefined,
    });
    attachmentInserts.push({ id, r2Key, a });
  }

  const stmts: D1PreparedStatement[] = [];

  if (thread.isNew) {
    stmts.push(
      env.DB
        .prepare(
          `INSERT INTO threads (id, mailbox_id, subject_normalized, last_message_at, message_count, unread_count)
           VALUES (?, ?, ?, ?, 0, 0)`,
        )
        .bind(thread.threadId, recipient.mailboxId, thread.subjectNormalized, dateSeconds),
    );
  }

  stmts.push(
    env.DB
      .prepare(
        `INSERT INTO messages
         (id, thread_id, mailbox_id, message_id_header, in_reply_to, references_chain,
          direction, from_addr, from_name, to_json, cc_json, bcc_json,
          subject, date, snippet, raw_r2_key, html_r2_key, text_body, read, starred)
         VALUES (?, ?, ?, ?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      )
      .bind(
        messageId,
        thread.threadId,
        recipient.mailboxId,
        parsed.messageId,
        parsed.inReplyTo ?? null,
        parsed.references.length ? parsed.references.join(" ") : null,
        parsed.from.addr,
        parsed.from.name ?? null,
        JSON.stringify(parsed.to),
        parsed.cc.length ? JSON.stringify(parsed.cc) : null,
        parsed.bcc.length ? JSON.stringify(parsed.bcc) : null,
        parsed.subject || null,
        dateSeconds,
        parsed.snippet,
        rawKey,
        htmlR2Key,
        parsed.text ?? null,
      ),
  );

  for (const { id, r2Key, a } of attachmentInserts) {
    stmts.push(
      env.DB
        .prepare(
          `INSERT INTO attachments (id, message_id, filename, content_type, size, inline_cid, r2_key)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, messageId, a.filename, a.contentType, a.bytes.byteLength, a.contentId ?? null, r2Key),
    );
  }

  // Bump thread counters and last_message_at. Always +1; the new-thread INSERT
  // above seeds counters at 0 so a newly created thread ends up at 1/1.
  stmts.push(
    env.DB
      .prepare(
        `UPDATE threads
           SET message_count = message_count + 1,
               unread_count  = unread_count  + 1,
               last_message_at = MAX(last_message_at, ?)
         WHERE id = ?`,
      )
      .bind(dateSeconds, thread.threadId),
  );

  await env.DB.batch(stmts);

  return { messageId, threadId: thread.threadId, duplicate: false };
}
