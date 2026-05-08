import { createMimeMessage } from "mimetext";
import { getDb, getEnv } from "./db";
import { findIdentity, fullAddress, type Identity } from "./identities";

// `cloudflare:email` is a Workers-runtime built-in. If imported at the top
// level, Next.js tries to load it during build-time page data collection and
// crashes (Node can't resolve it). Concatenating the specifier defeats Turbopack's
// static analysis so the import only runs in the Worker context.
async function getEmailMessageCtor(): Promise<typeof import("cloudflare:email").EmailMessage> {
  const spec = "cloudflare" + ":email";
  const mod = (await import(/* @vite-ignore */ spec)) as typeof import("cloudflare:email");
  return mod.EmailMessage;
}

export interface SendInput {
  fromMailboxId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  replyToMessageId?: string;
}

export interface SendResult {
  messageId: string;
  threadId: string;
}

export async function sendMessage(userId: string, input: SendInput): Promise<SendResult> {
  const identity = await findIdentity(userId, input.fromMailboxId);
  if (!identity) throw new SendError("not_authorised", "You can't send from that mailbox.");
  if (identity.role === "reader") {
    throw new SendError("forbidden", "Your role on this domain is read-only.");
  }
  if (input.to.length === 0) throw new SendError("invalid", "At least one recipient is required.");

  const env = getEnv();
  const db = getDb();

  const { parentMessage, parentReferences } = await loadReplyParent(input.replyToMessageId);
  if (parentMessage && parentMessage.mailbox_id !== identity.mailbox_id) {
    // Reply must come from the mailbox that received the original — otherwise
    // threading would split. Surface this rather than silently moving threads.
    throw new SendError(
      "mailbox_mismatch",
      "Reply must use the mailbox the original was sent to.",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const messageId = crypto.randomUUID();
  const messageIdHeader = `<${messageId}@${identity.domain_name}>`;

  const fromAddr = fullAddress(identity);
  const fromName = identity.display_name?.trim() || undefined;

  const msg = createMimeMessage();
  msg.setSender(fromName ? { name: fromName, addr: fromAddr } : fromAddr);
  msg.setTo(input.to);
  if (input.cc?.length) msg.setCc(input.cc);
  if (input.bcc?.length) msg.setBcc(input.bcc);
  msg.setSubject(input.subject || "(no subject)");
  msg.setHeader("Message-ID", messageIdHeader);
  msg.setHeader("Date", new Date(now * 1000).toUTCString());
  if (parentMessage) {
    msg.setHeader("In-Reply-To", parentMessage.message_id_header);
    const chain = [...parentReferences, parentMessage.message_id_header].join(" ");
    msg.setHeader("References", chain);
  }
  msg.addMessage({ contentType: "text/plain", data: input.body });

  const raw = msg.asRaw();

  // Send to each recipient — Cloudflare's send_email binding is per-recipient.
  const EmailMessage = await getEmailMessageCtor();
  for (const to of [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])]) {
    await env.EMAIL.send(new EmailMessage(fromAddr, to, raw));
  }

  // Persist the sent copy so it shows up in the thread reader.
  const rawKey = `mailbox/${identity.mailbox_id}/${messageId}.eml`;
  await env.RAW_MAIL.put(rawKey, raw, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: { mailbox: identity.mailbox_id, messageId, direction: "outbound" },
  });

  const threadId = parentMessage?.thread_id ?? crypto.randomUUID();
  const isNewThread = !parentMessage;
  const subjectNormalized = normalizeSubject(input.subject);
  const snippet = input.body.replace(/\s+/g, " ").trim().slice(0, 200);

  const stmts = [];
  if (isNewThread) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO threads (id, mailbox_id, subject_normalized, last_message_at, message_count, unread_count)
           VALUES (?, ?, ?, ?, 0, 0)`,
        )
        .bind(threadId, identity.mailbox_id, subjectNormalized, now),
    );
  }

  stmts.push(
    db
      .prepare(
        `INSERT INTO messages
         (id, thread_id, mailbox_id, message_id_header, in_reply_to, references_chain,
          direction, from_addr, from_name, to_json, cc_json, bcc_json,
          subject, date, snippet, raw_r2_key, text_body, read, starred)
         VALUES (?, ?, ?, ?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`,
      )
      .bind(
        messageId,
        threadId,
        identity.mailbox_id,
        messageIdHeader,
        parentMessage?.message_id_header ?? null,
        parentMessage
          ? [...parentReferences, parentMessage.message_id_header].join(" ")
          : null,
        fromAddr,
        fromName ?? null,
        JSON.stringify(input.to.map(addr => ({ addr }))),
        input.cc?.length ? JSON.stringify(input.cc.map(addr => ({ addr }))) : null,
        input.bcc?.length ? JSON.stringify(input.bcc.map(addr => ({ addr }))) : null,
        input.subject || null,
        now,
        snippet,
        rawKey,
        input.body,
      ),
  );

  // Outbound messages count toward message_count but never toward unread_count.
  stmts.push(
    db
      .prepare(
        `UPDATE threads
           SET message_count = message_count + 1,
               last_message_at = MAX(last_message_at, ?)
         WHERE id = ?`,
      )
      .bind(now, threadId),
  );

  await db.batch(stmts);

  return { messageId, threadId };
}

interface ParentInfo {
  parentMessage: {
    id: string;
    thread_id: string;
    mailbox_id: string;
    message_id_header: string;
    references_chain: string | null;
  } | null;
  parentReferences: string[];
}

async function loadReplyParent(parentId: string | undefined): Promise<ParentInfo> {
  if (!parentId) return { parentMessage: null, parentReferences: [] };
  const row = await getDb()
    .prepare(
      `SELECT id, thread_id, mailbox_id, message_id_header, references_chain
         FROM messages WHERE id = ?`,
    )
    .bind(parentId)
    .first<{
      id: string;
      thread_id: string;
      mailbox_id: string;
      message_id_header: string;
      references_chain: string | null;
    }>();
  if (!row) return { parentMessage: null, parentReferences: [] };
  const parentReferences = row.references_chain
    ? row.references_chain.split(/\s+/).filter(Boolean)
    : [];
  return { parentMessage: row, parentReferences };
}

function normalizeSubject(subject: string): string {
  let s = subject.trim();
  while (true) {
    const stripped = s.replace(/^\s*(?:re|fwd|fw|aw|tr|antw)\s*:\s*/i, "");
    if (stripped === s) break;
    s = stripped;
  }
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s || "(no subject)";
}

export class SendError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export type { Identity };
