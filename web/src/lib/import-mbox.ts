// Mbox import — pair to the .mbox export endpoint.
//
// Accepts the contents of an mbox file (Gmail Takeout, Apple Mail export,
// Thunderbird, the orange-inbox export itself), splits each message out,
// parses it with postal-mime, and ingests each one into the user's chosen
// mailbox using the same threading + storage flow as inbound mail.
//
// Scope of v1:
// - Single-request: the whole file is buffered in memory. Hard caps below
//   to keep us under Workers' request-body and CPU limits. Users with
//   multi-GB Gmail Takeout files will need to split before importing.
// - Direction is always "inbound". Imported messages are historical mail;
//   we use the original Date header so threading remains chronological.
// - Idempotent on (mailbox_id, message_id_header) — re-running an import
//   skips duplicates rather than creating doubles.
// - Marks each message read=1 so the import doesn't blow up the user's
//   unread count by however many messages they brought in.

import PostalMime, { type Address, type Attachment } from "postal-mime";
import {
  getMailDbForNewThread,
  getMailDbForThread,
  getActiveMailDbs,
  registerThreadLocation,
  upsertThreadIndex,
} from "./mail-db";
import { getDb, getEnv } from "./db";

// Soft limits — both checked at the route boundary. Bytes is the easy one;
// message count caps the per-request work so we don't blow CPU time.
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_MESSAGES = 500;

export interface ImportResult {
  imported: number;
  duplicates: number;
  errors: { index: number; reason: string }[];
}

// Split an mbox blob into RFC822 message bodies. The separator is any line
// starting with `From ` (no colon). mboxrd quoting (`>From ` etc.) is
// reversed before each message is yielded.
//
// Yields nothing for an empty input or one that has no `From ` lines (which
// catches the trivial "I uploaded a single .eml" mistake — we want that to
// fail loudly rather than silently slip through).
export function splitMbox(text: string): string[] {
  const messages: string[] = [];
  const lines = text.split(/\r?\n/);
  let current: string[] | null = null;

  for (const line of lines) {
    if (/^From /.test(line)) {
      if (current !== null) {
        messages.push(unquoteFromLines(current.join("\r\n")));
      }
      current = [];
      continue;
    }
    if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null) {
    messages.push(unquoteFromLines(current.join("\r\n")));
  }
  return messages;
}

// mboxrd un-escape: a body line `>From ` (or `>>From `, etc.) means the
// original had one fewer `>`. We strip exactly one leading `>` from any
// `>+From ` line.
function unquoteFromLines(body: string): string {
  return body.replace(/^>(>*From )/gm, "$1");
}

// ─── ingestion helpers ─────────────────────────────────────────────────────

interface ImportedAttachment {
  filename: string | null;
  contentType: string;
  contentId?: string;
  bytes: ArrayBuffer;
}

interface ParsedImported {
  messageId: string;
  inReplyTo?: string;
  references: string[];
  fromAddr: string;
  fromName: string | null;
  to: { addr: string; name?: string }[];
  cc: { addr: string; name?: string }[];
  subject: string;
  date: number;
  text?: string;
  html?: string;
  snippet: string;
  attachments: ImportedAttachment[];
  rawBytes: ArrayBuffer;
}

// Parse one rfc822-ish chunk from the mbox split. Wraps postal-mime so the
// import path doesn't have to know about its types.
async function parseImportedMessage(rfc822: string): Promise<ParsedImported> {
  const bytes = new TextEncoder().encode(rfc822);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
  const parsed = await PostalMime.parse(stream, { attachmentEncoding: "arraybuffer" });

  const text = parsed.text;
  const html = parsed.html;
  const from = flattenOne(parsed.from) ?? { addr: "" };

  return {
    messageId: parsed.messageId ?? `<${crypto.randomUUID()}@orange-inbox.import.local>`,
    inReplyTo: parsed.inReplyTo,
    references: splitReferences(parsed.references),
    fromAddr: from.addr,
    fromName: from.name ?? null,
    to: flattenMany(parsed.to),
    cc: flattenMany(parsed.cc),
    subject: parsed.subject ?? "",
    date: parsed.date ? Date.parse(parsed.date) || Date.now() : Date.now(),
    text,
    html,
    snippet: makeSnippet(text, html),
    attachments: (parsed.attachments ?? []).map(toImportedAttachment),
    rawBytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

function splitReferences(refs: string | undefined): string[] {
  if (!refs) return [];
  return refs.split(/\s+/).map(s => s.trim()).filter(Boolean);
}

function flattenOne(addr: Address | undefined): { addr: string; name?: string } | undefined {
  if (!addr) return undefined;
  if ("address" in addr && addr.address) return { addr: addr.address, name: addr.name || undefined };
  if ("group" in addr && addr.group) return flattenOne(addr.group[0]);
  return undefined;
}

function flattenMany(addrs: Address[] | undefined): { addr: string; name?: string }[] {
  if (!addrs) return [];
  const out: { addr: string; name?: string }[] = [];
  for (const a of addrs) {
    if ("address" in a && a.address) out.push({ addr: a.address, name: a.name || undefined });
    else if ("group" in a && a.group) {
      for (const m of a.group) out.push({ addr: m.address, name: m.name || undefined });
    }
  }
  return out;
}

function makeSnippet(text: string | undefined, html: string | undefined): string {
  const source = text || (html ? stripHtml(html) : "");
  return source.replace(/\s+/g, " ").trim().slice(0, 200);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ");
}

function toImportedAttachment(a: Attachment): ImportedAttachment {
  return {
    filename: a.filename ?? null,
    contentType: a.mimeType,
    contentId: a.contentId?.replace(/^<|>$/g, ""),
    bytes: toArrayBuffer(a.content),
  };
}

function toArrayBuffer(content: ArrayBuffer | Uint8Array | string): ArrayBuffer {
  if (content instanceof ArrayBuffer) return content;
  if (content instanceof Uint8Array) {
    return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
  }
  return new TextEncoder().encode(content).buffer as ArrayBuffer;
}

// ─── threading ─────────────────────────────────────────────────────────────

function normalizeSubject(subject: string): string {
  let s = (subject ?? "").trim();
  while (true) {
    const stripped = s.replace(/^\s*(?:re|fwd|fw|aw|tr|antw)\s*:\s*/i, "");
    if (stripped === s) break;
    s = stripped;
  }
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s || "(no subject)";
}

const SUBJECT_FALLBACK_WINDOW_S = 60 * 60 * 24 * 14;

async function findOrCreateThread(
  mailboxId: string,
  msg: ParsedImported,
): Promise<{ threadId: string; isNew: boolean; subjectNormalized: string }> {
  const subjectNormalized = normalizeSubject(msg.subject);
  const candidates = Array.from(
    new Set([...msg.references, msg.inReplyTo].filter((x): x is string => !!x)),
  );
  const mailDbs = await getActiveMailDbs();

  if (candidates.length > 0) {
    const placeholders = candidates.map(() => "?").join(",");
    for (const { db } of mailDbs) {
      const hit = await db
        .prepare(
          `SELECT thread_id FROM messages
            WHERE mailbox_id = ? AND message_id_header IN (${placeholders})
            LIMIT 1`,
        )
        .bind(mailboxId, ...candidates)
        .first<{ thread_id: string }>();
      if (hit) return { threadId: hit.thread_id, isNew: false, subjectNormalized };
    }
  }

  const cutoff = Math.floor(msg.date / 1000) - SUBJECT_FALLBACK_WINDOW_S;
  for (const { db } of mailDbs) {
    const subjMatch = await db
      .prepare(
        `SELECT id FROM threads
          WHERE mailbox_id = ? AND subject_normalized = ? AND last_message_at >= ?
          ORDER BY last_message_at DESC LIMIT 1`,
      )
      .bind(mailboxId, subjectNormalized, cutoff)
      .first<{ id: string }>();
    if (subjMatch) return { threadId: subjMatch.id, isNew: false, subjectNormalized };
  }

  return { threadId: crypto.randomUUID(), isNew: true, subjectNormalized };
}

// ─── ingestion ─────────────────────────────────────────────────────────────

interface Env {
  RAW_MAIL: R2Bucket;
  ATTACHMENTS: R2Bucket;
}

// Insert one parsed message into D1 + R2, with the same shape as the
// email-worker's storeMessage but adapted to the web side. Returns "ok" on
// insert, "duplicate" if the (mailbox, msgid) is already present.
async function ingestMessage(
  mailboxId: string,
  parsed: ParsedImported,
): Promise<"ok" | "duplicate"> {
  // Resolve thread first so we know which mail DB to write to.
  const thread = await findOrCreateThread(mailboxId, parsed);

  let mailDb: D1Database;
  let mailDbId: string;
  if (thread.isNew) {
    const picked = await getMailDbForNewThread();
    mailDb = picked.db;
    mailDbId = picked.mailDbId;
  } else {
    mailDb = await getMailDbForThread(thread.threadId);
    mailDbId = "";
  }

  // Idempotency check.
  const existing = await mailDb
    .prepare("SELECT 1 FROM messages WHERE mailbox_id = ? AND message_id_header = ?")
    .bind(mailboxId, parsed.messageId)
    .first();
  if (existing) return "duplicate";

  const env = getEnv() as unknown as Env;
  const messageId = crypto.randomUUID();
  const dateSeconds = Math.floor(parsed.date / 1000);
  const rawKey = `mailbox/${mailboxId}/${messageId}.eml`;

  await env.RAW_MAIL.put(rawKey, parsed.rawBytes, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: { mailbox: mailboxId, messageId, imported: "1" },
  });

  let htmlR2Key: string | null = null;
  if (parsed.html) {
    htmlR2Key = `mailbox/${mailboxId}/${messageId}.html`;
    await env.RAW_MAIL.put(htmlR2Key, parsed.html, {
      httpMetadata: { contentType: "text/html" },
      customMetadata: { mailbox: mailboxId, messageId },
    });
  }

  const attachmentInserts: Array<{ id: string; r2Key: string; a: ImportedAttachment }> = [];
  for (const a of parsed.attachments) {
    const id = crypto.randomUUID();
    const r2Key = `mailbox/${mailboxId}/${messageId}/${id}`;
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
        .bind(thread.threadId, mailboxId, thread.subjectNormalized, dateSeconds),
    );
  }

  // Direction = inbound. read = 1 — imported mail is historical, the user
  // shouldn't see a giant unread surge when they import.
  stmts.push(
    mailDb
      .prepare(
        `INSERT INTO messages
          (id, thread_id, mailbox_id, message_id_header, in_reply_to, references_chain,
            direction, from_addr, from_name, to_json, cc_json, bcc_json,
            subject, date, snippet, raw_r2_key, html_r2_key, text_body, read, starred)
          VALUES (?, ?, ?, ?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`,
      )
      .bind(
        messageId,
        thread.threadId,
        mailboxId,
        parsed.messageId,
        parsed.inReplyTo ?? null,
        parsed.references.length ? parsed.references.join(" ") : null,
        parsed.fromAddr,
        parsed.fromName,
        JSON.stringify(parsed.to),
        parsed.cc.length ? JSON.stringify(parsed.cc) : null,
        null, // bcc — historical mail rarely preserves bcc
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

  stmts.push(
    mailDb
      .prepare(
        `UPDATE threads
            SET message_count = message_count + 1,
                last_message_at = MAX(last_message_at, ?)
          WHERE id = ?`,
      )
      .bind(dateSeconds, thread.threadId),
  );

  await mailDb.batch(stmts);

  if (thread.isNew) {
    try {
      await registerThreadLocation(thread.threadId, mailDbId);
    } catch {
      // Non-fatal: a missed location row just means the thread defaults to
      // 'primary' on resolve, which is still correct in single-DB deploys.
    }
  }

  try {
    await upsertThreadIndex({
      threadId: thread.threadId,
      mailboxId,
      mailDbId: mailDbId || "primary",
      subjectNormalized: thread.subjectNormalized,
      lastMessageAt: dateSeconds,
      // Imported = read = 0 unread bump.
      unreadDelta: 0,
      lastMessageId: messageId,
      lastSubject: parsed.subject || null,
      lastFromAddr: parsed.fromAddr || null,
      lastFromName: parsed.fromName,
      lastSnippet: parsed.snippet,
      createdAt: thread.isNew ? dateSeconds : undefined,
    });
  } catch {
    // Non-fatal in a worst case — the message is on disk; a sweeper or the
    // next inbound for this thread will reconcile threads_index.
  }

  return "ok";
}

export async function ingestMboxText(
  mailboxId: string,
  text: string,
): Promise<ImportResult> {
  const messages = splitMbox(text);
  const result: ImportResult = { imported: 0, duplicates: 0, errors: [] };

  for (let i = 0; i < messages.length && i < MAX_IMPORT_MESSAGES; i++) {
    try {
      const parsed = await parseImportedMessage(messages[i]);
      const outcome = await ingestMessage(mailboxId, parsed);
      if (outcome === "ok") result.imported++;
      else result.duplicates++;
    } catch (err) {
      result.errors.push({
        index: i,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

// Mailbox access guard — same shape used elsewhere in the app. Imports
// require owner OR member role; readers can't import.
export async function userCanImportInto(
  userId: string,
  mailboxId: string,
): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `SELECT 1 FROM user_mailbox_access
        WHERE user_id = ? AND mailbox_id = ? AND role IN ('owner','member')
        LIMIT 1`,
    )
    .bind(userId, mailboxId)
    .first();
  return row !== null;
}
