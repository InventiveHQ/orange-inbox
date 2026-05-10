import {
  getMailDbForNewThread,
  getMailDbForThread,
  isThreadMuted,
  registerThreadLocation,
  upsertThreadIndex,
} from "./mail-db";
import { evaluateRules } from "./rules";
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
  ctx: ExecutionContext,
  recipient: Recipient,
  thread: ThreadMatch,
  parsed: ParsedMessage,
  rawBytes: ArrayBuffer,
): Promise<StoreResult> {
  // Resolve which mail DB this message should land in. New threads pick the
  // emptiest DB under its soft cap (or hard cap in degraded mode); existing
  // threads route to whichever DB the thread is pinned to.
  let mailDb: D1Database;
  let mailDbId: string;
  if (thread.isNew) {
    const picked = await getMailDbForNewThread(env);
    if (!picked) {
      // Every mail DB is over its hard cap and we have nowhere to put this.
      // Reject so Cloudflare retries / requeues the inbound — better than
      // silently dropping it.
      throw new Error(
        "all mail DBs are at hard cap; provision an overflow DB before continuing",
      );
    }
    mailDb = picked.db;
    mailDbId = picked.mailDbId;
  } else {
    mailDb = await getMailDbForThread(env, thread.threadId);
    mailDbId = ""; // not needed for upsertThreadIndex on UPDATE branch
  }

  // If the user has muted this thread, new replies stay archived and
  // don't increment unread_count. New threads can't be muted.
  const muted = thread.isNew ? false : await isThreadMuted(env, thread.threadId);

  // Blocked-sender check (#74). We still store the message — the user can
  // unblock and recover from "All mail" — but force the thread into
  // archived state and skip the unread bump and push fan-out so it never
  // reaches the inbox or the user's device. Lowercased to match the
  // case-insensitive insert at the API site.
  const fromAddrLower = parsed.from.addr.toLowerCase();
  const blockedRow = await env.DB
    .prepare("SELECT 1 AS hit FROM blocked_senders WHERE mailbox_id = ? AND addr = ?")
    .bind(recipient.mailboxId, fromAddrLower)
    .first<{ hit: number }>();
  const blocked = blockedRow !== null;

  // Either signal suppresses the inbox surface; behaviourally identical
  // downstream so we collapse them.
  const suppress = muted || blocked;

  // Idempotency: if this Message-ID is already stored for this mailbox in
  // the target mail DB, bail. (We're past the threading step, so the right
  // mail DB to check is the one we're about to write to — same DB the
  // existing message would live in if it's a true duplicate.)
  const existing = await mailDb
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
      mailDb
        .prepare(
          `INSERT INTO threads (id, mailbox_id, subject_normalized, last_message_at, message_count, unread_count)
           VALUES (?, ?, ?, ?, 0, 0)`,
        )
        .bind(thread.threadId, recipient.mailboxId, thread.subjectNormalized, dateSeconds),
    );
  }

  stmts.push(
    mailDb
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
      mailDb
        .prepare(
          `INSERT INTO attachments (id, message_id, filename, content_type, size, inline_cid, r2_key)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, messageId, a.filename, a.contentType, a.bytes.byteLength, a.contentId ?? null, r2Key),
    );
  }

  // Bump thread counters on the mail-DB threads row. Source of truth for the
  // listing UI is threads_index in control (upserted just below); this keeps
  // the local thread row consistent so internal joins (next reply lookup,
  // etc.) see fresh data.
  stmts.push(
    mailDb
      .prepare(
        `UPDATE threads
           SET message_count = message_count + 1,
               unread_count  = unread_count  + ?,
               last_message_at = MAX(last_message_at, ?)
         WHERE id = ?`,
      )
      .bind(suppress ? 0 : 1, dateSeconds, thread.threadId),
  );

  await mailDb.batch(stmts);

  // Control-side bookkeeping. Independent of the mail batch — failures here
  // mean the message is still on disk and visible via the next read; we just
  // log so a sweeper can reconcile.
  if (thread.isNew) {
    try {
      await registerThreadLocation(env, thread.threadId, mailDbId);
    } catch (err) {
      console.error("registerThreadLocation failed", err);
    }
  }

  try {
    await upsertThreadIndex(env, {
      threadId: thread.threadId,
      mailboxId: recipient.mailboxId,
      mailDbId: mailDbId || "primary",
      subjectNormalized: thread.subjectNormalized,
      lastMessageAt: dateSeconds,
      // Muted threads and mail from blocked senders don't bump unread and
      // stay archived — they shouldn't re-surface in the inbox just because
      // a new message arrived.
      unreadDelta: suppress ? 0 : 1,
      forceArchived: suppress,
      lastMessageId: messageId,
      lastSubject: parsed.subject || null,
      lastFromAddr: parsed.from.addr,
      lastFromName: parsed.from.name ?? null,
      lastSnippet: parsed.snippet,
      createdAt: thread.isNew ? dateSeconds : undefined,
    });
  } catch (err) {
    console.error("upsertThreadIndex failed", err);
  }

  // Run user-defined filter rules. Skipped for muted/blocked-sender mail
  // (already suppressed; rules would only churn flags that don't matter)
  // — actual evaluation is best-effort, so a rule failure can't block
  // ingestion. Done synchronously before push fan-out so an "archive" or
  // "delete" rule has a chance to suppress the notification.
  let ruleApplied = false;
  if (!suppress) {
    try {
      // recipient.mailboxId is the local-part owner; fetch it once for
      // matching against `to_contains` rules. Lowercased so the matcher
      // can do plain substring checks.
      const mb = await env.DB
        .prepare("SELECT local_part FROM mailboxes WHERE id = ?")
        .bind(recipient.mailboxId)
        .first<{ local_part: string }>();
      const localPart = (mb?.local_part ?? "").toLowerCase();
      const subjectLower = (parsed.subject ?? "").toLowerCase();

      // Detect "real" attachments — postal-mime hands us inline images and
      // signature parts in the same array, but for matching purposes the
      // useful definition is "non-inline".
      const hasAttachment = parsed.attachments.some(a => a.disposition !== "inline");

      // Snapshot threads_index BEFORE rules so we can detect a terminal
      // (archive/delete) action and suppress the push fan-out below.
      await evaluateRules(env, {
        mailboxId: recipient.mailboxId,
        threadId: thread.threadId,
        messageId,
        mailDb,
        mailDbId: mailDbId || "primary",
        fromAddrLower,
        subjectLower,
        recipientLocalPartLower: localPart,
        hasAttachment,
      });
      ruleApplied = true;
    } catch (err) {
      console.error("rule evaluation failed", err);
    }
  }

  // If a terminal rule fired (archive/delete), the thread row is either
  // archived or gone — neither case wants a push notification. Detect by
  // re-reading threads_index; missing or archived = suppress.
  let suppressPush = suppress;
  if (ruleApplied && !suppressPush) {
    const post = await env.DB
      .prepare("SELECT archived FROM threads_index WHERE thread_id = ?")
      .bind(thread.threadId)
      .first<{ archived: number }>();
    if (!post || post.archived === 1) suppressPush = true;
  }

  // Fire-and-forget Web Push fan-out via the web worker. Wrapped in
  // ctx.waitUntil so the email handler returns fast; failures here never
  // affect mail ingestion. Muted threads, blocked senders, and rule-archived
  // threads suppress push too — same reason we keep them archived.
  if (!suppressPush) {
    ctx.waitUntil(notifyWebOfNewMessage(env, recipient.mailboxId, thread.threadId, messageId, parsed));
  }

  return { messageId, threadId: thread.threadId, duplicate: false };
}

async function notifyWebOfNewMessage(
  env: Env,
  mailboxId: string,
  threadId: string,
  messageId: string,
  parsed: ParsedMessage,
): Promise<void> {
  if (!env.WEB || !env.INTERNAL_SECRET) return;
  try {
    const res = await env.WEB.fetch(
      new Request("https://internal/api/internal/notify-new-message", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-secret": env.INTERNAL_SECRET,
        },
        body: JSON.stringify({
          mailboxId,
          threadId,
          messageId,
          fromAddr: parsed.from.addr,
          fromName: parsed.from.name ?? null,
          subject: parsed.subject || null,
        }),
      }),
    );
    if (!res.ok) {
      console.warn(`notify-new-message ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  } catch (err) {
    console.warn("notify-new-message threw", err);
  }
}
