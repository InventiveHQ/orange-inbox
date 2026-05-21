import { headers } from "next/headers";
import { logAudit } from "./audit";
import { getDb, getEnv } from "./db";
import { htmlToText, looksLikeHtml } from "./html-text";
import {
  findAliasIdentity,
  findIdentity,
  fullAddress,
  type Identity,
} from "./identities";
import { recordSendRecipients } from "./contacts";
import {
  getActiveMailDbs,
  getMailDbForNewThread,
  getMailDbForThread,
  registerThreadLocation,
  upsertThreadIndex,
} from "./mail-db";
import { createShareLink, DEFAULT_SHARE_TTL_SECONDS } from "./share-links";

// Mail Drop threshold (issue #71). Anything strictly larger than this gets
// uploaded as a share link instead of inlined into the MIME body. Picked at
// 10 MB to stay safely under common MX size caps (Gmail/Microsoft accept
// 25 MB total message size, but headers + base64 overhead chew up a chunk
// of that). Single constant so it's trivial to tune later.
const MAIL_DROP_THRESHOLD_BYTES = 10 * 1024 * 1024;

// #66 Confidential mode — server-side ceiling on how far in the future a
// confidential message may be set to expire. `expires_at` is client-supplied,
// so without a cap a caller could mint an effectively-permanent off-server
// store. 30 days matches the longest option the composer offers (1/7/30d).
const CONFIDENTIAL_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

// #66 Confidential passcode alphabet. Uppercase letters + digits with the
// visually ambiguous glyphs removed (no O/0, I/1/L) so a recipient reading
// the code off a phone screen or sticky note can't fat-finger it. 31 symbols.
const CONFIDENTIAL_PASSCODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
// 8 chars from a 31-symbol alphabet ≈ log2(31^8) ≈ 39.6 bits of entropy —
// ~4.3 billion combinations, vs. 10,000 for the old 4-digit PIN.
const CONFIDENTIAL_PASSCODE_LENGTH = 8;

// Cloudflare's send_email binding has a structured-builder overload, so we
// don't need the `cloudflare:email` runtime module or mimetext at all — the
// binding builds MIME for us. Avoiding `cloudflare:email` also dodges a chain
// of bundler issues (esbuild can't resolve the Workers built-in, dynamic
// import gets compiled to require, code-from-strings is forbidden in the
// isolate, etc).

export interface SendInput {
  fromMailboxId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  replyToMessageId?: string;
  // If set, the draft is deleted in the same batch as the message insert.
  // The route validates ownership before passing it in.
  draftId?: string;
  // Outbound attachments staged via /api/uploads. We re-verify ownership and
  // pull bytes from R2 before handing them to env.EMAIL.send().
  attachmentIds?: string[];
  // Optional send-as alias. When set, the alias's local_part/display_name
  // /signature override the parent mailbox's for the From line. The alias
  // must belong to the same mailbox as fromMailboxId; we re-verify here.
  sendAsAliasId?: string;
  // #66 Confidential mode. When set, the recipient receives a synthesized
  // placeholder body ("{sender} sent you a confidential message — view at
  // <url>") rather than `body` itself; the real body lives in the
  // confidential_messages row keyed by the generated token, viewable only
  // via the public /p/c/<token> URL. expiresAt is unix seconds (capped at
  // CONFIDENTIAL_MAX_TTL_SECONDS in the future); passcode is an optional
  // high-entropy alphanumeric string the recipient must enter on the view
  // page. When omitted, the helper here can mint one.
  confidential?: {
    expiresAt: number;
    passcode?: string | null;
  };
  // #69 Opt-in read receipts. When true, mint a tracking_token, store it on
  // the message row, and inject a 1x1 transparent PNG <img> into the HTML
  // body that hits /p/api/track/<token>.png when the recipient opens. Has no
  // effect on the plain-text alternative (no inline image to attach to).
  trackOpens?: boolean;
}

export interface SendResult {
  messageId: string;
  threadId: string;
}

export async function sendMessage(userId: string, input: SendInput): Promise<SendResult> {
  const mailboxIdentity = await findIdentity(userId, input.fromMailboxId);
  if (!mailboxIdentity) {
    throw new SendError("not_authorised", "You can't send from that mailbox.");
  }
  if (mailboxIdentity.role === "reader") {
    throw new SendError("forbidden", "Your role on this domain is read-only.");
  }

  // Resolve the active From identity. If sendAsAliasId is supplied, the alias
  // must belong to the same mailbox the user already proved access on; we
  // load it via findAliasIdentity so the join + role check happens in one
  // place. The mailbox identity remains the authoritative source for thread
  // routing (parent_mailbox_id stays the underlying mailbox).
  let identity: Identity = mailboxIdentity;
  if (input.sendAsAliasId) {
    const alias = await findAliasIdentity(userId, input.sendAsAliasId);
    if (!alias) {
      throw new SendError("alias_not_authorised", "That alias isn't yours to send from.");
    }
    if (alias.mailbox_id !== mailboxIdentity.mailbox_id) {
      throw new SendError(
        "alias_mailbox_mismatch",
        "Alias doesn't belong to the chosen mailbox.",
      );
    }
    identity = alias;
  }

  if (input.to.length === 0) throw new SendError("invalid", "At least one recipient is required.");

  const env = getEnv();
  const controlDb = getDb();

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

  // Cloudflare's send_email binding whitelists headers and rejects anything
  // not on the list. Message-ID and Date are auto-generated by the service
  // and rejected if we try to set them — In-Reply-To and References ARE
  // whitelisted and are what we need anyway for the recipient's client to
  // thread the reply. So we send those when this is a reply, and let
  // Cloudflare own Message-ID/Date.
  const headers: Record<string, string> = {};
  if (parentMessage) {
    headers["In-Reply-To"] = parentMessage.message_id_header;
    headers["References"] = [...parentReferences, parentMessage.message_id_header].join(" ");
  }

  // Resolve attachment uploads: validate ownership, decide inline-vs-Mail-Drop
  // per attachment, pull bytes from R2 for the inline ones, mint share-link
  // tokens for the oversized ones. Done here (not in a helper) so a missing /
  // not-owned id surfaces a precise SendError before we touch the binding.
  // temp_uploads lives in the control DB.
  //
  // Mail Drop policy: any single attachment > MAIL_DROP_THRESHOLD_BYTES is
  // replaced in the body with a presigned R2 URL instead of being inlined.
  // The URL points directly at R2 — no Worker / Access in the request path,
  // so external recipients can actually download it.
  // We deliberately don't sum sizes — common MX caps are per-message
  // but we'd rather always-inline a 9 MB file alongside a 9 MB file (= 18 MB,
  // bouncy) than over-engineer the threshold. Bounce-on-aggregate is a
  // future tweak; v1 favours predictability.
  const attachments: EmailAttachment[] = [];
  const droppedLinks: DroppedAttachmentLink[] = [];
  if (input.attachmentIds?.length) {
    for (const uploadId of input.attachmentIds) {
      const upload = await controlDb
        .prepare(
          "SELECT id, filename, content_type, size, r2_key FROM temp_uploads WHERE id = ? AND user_id = ?",
        )
        .bind(uploadId, userId)
        .first<{ id: string; filename: string | null; content_type: string | null; size: number; r2_key: string }>();
      if (!upload) {
        throw new SendError("attachment_not_found", `Attachment ${uploadId} not found or not owned by you.`);
      }

      if (upload.size > MAIL_DROP_THRESHOLD_BYTES) {
        // Mail-Drop path: don't pull bytes here, don't pass to the binding.
        // The temp_uploads R2 object becomes the share-link's R2 object — we
        // simply mint a token that references the same key. (Skipping the
        // temp_uploads cleanup below for these IDs would also work, but
        // keeping the row deletion symmetrical is simpler — the share link
        // owns the lifecycle of the bytes from this point on.)
        const link = await createShareLink(userId, {
          r2Key: upload.r2_key,
          filename: upload.filename,
          contentType: upload.content_type,
          size: upload.size,
          ttlSeconds: DEFAULT_SHARE_TTL_SECONDS,
          maxDownloads: null,
        });
        droppedLinks.push({
          url: link.url,
          expiresAt: link.expiresAt,
          filename: upload.filename || "attachment",
          size: upload.size,
        });
        continue;
      }

      const obj = await env.ATTACHMENTS.get(upload.r2_key);
      if (!obj) {
        throw new SendError("attachment_missing", `Attachment ${upload.filename ?? uploadId} bytes are missing.`);
      }
      const buf = await obj.arrayBuffer();
      attachments.push({
        disposition: "attachment",
        filename: upload.filename || "attachment",
        type: upload.content_type || "application/octet-stream",
        content: buf,
      });
    }
  }

  // The composer (Lexical) ships HTML; legacy plain-text drafts/templates may
  // still arrive as raw text. We send a multipart/alternative either way:
  //   - HTML body → derive plain text via htmlToText() for the text part,
  //     wrap fragment in a minimal <html><body> shell for client rendering.
  //   - Plain-text body → escape + linkify + paragraph-wrap into HTML.
  // Either way the recipient sees something reasonable in any client.
  //
  // Mail Drop additions: when there are dropped (oversized) attachments, we
  // synthesise an HTML block + plain-text block listing the download links
  // and append it to both renderings. Using the request host so the link
  // matches whatever vanity/host domain the user has configured.
  //
  // #66 Confidential mode: we swap input.body for a synthesised placeholder
  // *before* the multipart/alternative rendering — the actual content is
  // persisted in confidential_messages and never handed to env.EMAIL.send().
  // #69 Read-tracking pixel is injected into the HTML after the rest of the
  // assembly (text body deliberately stays clean — a stripped-out URL in
  // plain text gives the trick away and serves no purpose).
  let bodyForSending = input.body;
  let confidentialToken: string | null = null;
  let confidentialRecord: {
    token: string;
    bodyText: string;
    bodyHtml: string | null;
    expiresAt: number;
    passcode: string | null;
  } | null = null;
  if (input.confidential) {
    const cToken = generateOpaqueToken();
    const cExpires = Math.floor(input.confidential.expiresAt);
    if (!Number.isFinite(cExpires) || cExpires <= now) {
      throw new SendError("invalid", "Confidential expiry must be in the future.");
    }
    if (cExpires > now + CONFIDENTIAL_MAX_TTL_SECONDS) {
      throw new SendError(
        "invalid",
        "Confidential expiry can be at most 30 days in the future.",
      );
    }
    const cPasscode = normaliseConfidentialPasscode(input.confidential.passcode);
    if (cPasscode === "invalid") {
      throw new SendError(
        "invalid",
        `Passcode must be ${CONFIDENTIAL_PASSCODE_LENGTH} characters (letters and digits).`,
      );
    }
    const wasHtml = looksLikeHtml(input.body);
    confidentialRecord = {
      token: cToken,
      bodyText: wasHtml ? htmlToText(input.body) : input.body,
      bodyHtml: wasHtml ? input.body : null,
      expiresAt: cExpires,
      passcode: cPasscode,
    };
    confidentialToken = cToken;
    bodyForSending = buildConfidentialPlaceholderHtml(
      fromName || fromAddr,
      await resolveHost(),
      cToken,
      cExpires,
      cPasscode != null,
    );
  }

  const isHtml = looksLikeHtml(bodyForSending);
  let bodySource = bodyForSending;
  if (droppedLinks.length > 0 && !input.confidential) {
    // Mail Drop blocks land in the wire body. We skip this entirely in
    // confidential mode — attachments would defeat the point (the recipient
    // would see the placeholder + a real download link side by side).
    if (isHtml) {
      bodySource = `${bodyForSending}${renderDroppedLinksHtml(droppedLinks)}`;
    } else {
      bodySource = `${bodyForSending}\n\n${renderDroppedLinksText(droppedLinks)}`;
    }
  }
  const textBody = isHtml ? htmlToText(bodySource) : bodySource;
  let html = isHtml ? wrapHtmlFragment(bodySource) : buildHtmlFromText(bodySource);

  // #69 — inject a 1x1 read-tracking pixel into the HTML body just before
  // </body>. The plain-text alternative is left alone (no way to embed an
  // invisible URL there that wouldn't tip the recipient off, and mail clients
  // that prefer text/plain don't fire the open anyway — which is the right
  // outcome for a strictly opt-in feature).
  let trackingToken: string | null = null;
  if (input.trackOpens && !input.confidential) {
    trackingToken = generateOpaqueToken();
    const host = await resolveHost();
    const pixelUrl = `https://${host}/p/api/track/${trackingToken}.png`;
    const pixelTag = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;outline:none;" />`;
    // wrapHtmlFragment / buildHtmlFromText both close with </body></html>;
    // insert the pixel immediately before </body> so it sits inside the
    // document tree (some clients strip floating <img> tags after </body>).
    if (html.includes("</body>")) {
      html = html.replace("</body>", `${pixelTag}</body>`);
    } else {
      html = `${html}${pixelTag}`;
    }
  }

  const sendBuilder = {
    from: fromName ? { name: fromName, email: fromAddr } : fromAddr,
    to: input.to,
    cc: input.cc?.length ? input.cc : undefined,
    bcc: input.bcc?.length ? input.bcc : undefined,
    subject: input.subject || "(no subject)",
    text: textBody,
    html,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  } as const;
  try {
    await env.EMAIL.send(sendBuilder);
  } catch (e) {
    // Cloudflare's send_email error strings are sometimes generic ("internal
    // server error"). Log the full error object — message, name, cause, plus
    // the request payload that triggered it — so `wrangler tail` shows what
    // we actually need for diagnosis.
    console.error("env.EMAIL.send rejected", {
      error: serializeError(e),
      builder: { ...sendBuilder, text: `<${sendBuilder.text.length} chars>` },
    });
    const detail = e instanceof Error ? e.message : String(e);
    throw new SendError("send_failed", `Cloudflare rejected the send: ${detail}`);
  }

  // Persist a structured archive of what we sent. The send_email binding
  // doesn't return the raw MIME it built, so we save the structured fields
  // as JSON for debuggability — the schema's raw_r2_key column wants a
  // non-null path either way.
  const rawKey = `mailbox/${identity.mailbox_id}/${messageId}.json`;
  const archive = {
    from: fromName ? { name: fromName, email: fromAddr } : fromAddr,
    to: input.to,
    cc: input.cc ?? [],
    bcc: input.bcc ?? [],
    subject: input.subject,
    text: textBody,
    html: isHtml ? input.body : null,
    headers,
    sentAt: now,
  };
  await env.RAW_MAIL.put(rawKey, JSON.stringify(archive), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { mailbox: identity.mailbox_id, messageId, direction: "outbound" },
  });

  const threadId = parentMessage?.thread_id ?? crypto.randomUUID();
  const isNewThread = !parentMessage;
  const subjectNormalized = normalizeSubject(input.subject);
  const snippet = textBody.replace(/\s+/g, " ").trim().slice(0, 200);

  // Pick the mail DB this message lands in:
  //   - reply: same DB as the parent thread (resolved via thread_locations,
  //     defaulting to 'primary' when unset).
  //   - new thread: emptiest active DB under its soft cap (or under hard cap
  //     in degraded mode). Record the location so subsequent replies route
  //     back to the same DB.
  let mailDb: D1Database;
  let mailDbId: string;
  if (parentMessage) {
    mailDb = await getMailDbForThread(threadId);
    // We don't currently know which mail_db_id this maps to without an extra
    // query, but we don't need it for the upsert — threads_index already has
    // the right mail_db_id from when the thread was created.
    mailDbId = ""; // unused below; threads_index upsert will look it up if needed
  } else {
    const picked = await getMailDbForNewThread();
    mailDb = picked.db;
    mailDbId = picked.mailDbId;
  }

  const mailStmts: D1PreparedStatement[] = [];
  if (isNewThread) {
    mailStmts.push(
      mailDb
        .prepare(
          `INSERT INTO threads (id, mailbox_id, subject_normalized, last_message_at, message_count, unread_count)
           VALUES (?, ?, ?, ?, 0, 0)`,
        )
        .bind(threadId, identity.mailbox_id, subjectNormalized, now),
    );
  }

  // tracking_token is NULL when "Track opens" was off at send time. The mail
  // DB column comes from the 0033 bootstrap addition; existing overflow DBs
  // that haven't run the migration yet will reject the column — that's the
  // operator's signal to apply 0033 before flipping the feature on.
  mailStmts.push(
    mailDb
      .prepare(
        `INSERT INTO messages
         (id, thread_id, mailbox_id, message_id_header, in_reply_to, references_chain,
          direction, from_addr, from_name, to_json, cc_json, bcc_json,
          subject, date, snippet, raw_r2_key, text_body, read, starred, sent_by_user_id,
          tracking_token)
         VALUES (?, ?, ?, ?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
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
        textBody,
        userId,
        trackingToken,
      ),
  );

  // Keep the mail-DB threads.message_count / last_message_at in sync. Source
  // of truth for *listing* now lives on threads_index in control, but we
  // still update the mail-DB row so internal joins (e.g. the next reply
  // looking up the parent message) see fresh data.
  mailStmts.push(
    mailDb
      .prepare(
        `UPDATE threads
           SET message_count = message_count + 1,
               last_message_at = MAX(last_message_at, ?)
         WHERE id = ?`,
      )
      .bind(now, threadId),
  );

  await mailDb.batch(mailStmts);

  // Now the control-side bookkeeping. If anything below fails the message is
  // already on its way (sent + persisted + in mail DB); we just log so the
  // sweeper can reconcile.
  if (isNewThread) {
    try {
      await registerThreadLocation(threadId, mailDbId);
    } catch (err) {
      console.error("registerThreadLocation failed", err);
    }
  }

  try {
    await upsertThreadIndex({
      threadId,
      mailboxId: identity.mailbox_id,
      mailDbId: mailDbId || "primary", // unused on UPDATE; new threads get the picked id
      subjectNormalized,
      lastMessageAt: now,
      unreadDelta: 0, // outbound is never unread
      lastMessageId: messageId,
      lastSubject: input.subject || null,
      lastFromAddr: fromAddr,
      lastFromName: fromName ?? null,
      lastSnippet: snippet,
      createdAt: isNewThread ? now : undefined,
    });
  } catch (err) {
    console.error("upsertThreadIndex failed", err);
  }

  const controlStmts: D1PreparedStatement[] = [];
  if (input.draftId) {
    controlStmts.push(
      controlDb
        .prepare("DELETE FROM drafts WHERE id = ? AND user_id = ?")
        .bind(input.draftId, userId),
    );
  }

  // #66 — persist the confidential payload last so a failure here surfaces
  // before we delete the draft and clean up uploads. The recipient at this
  // point already has the placeholder email in their inbox; if the row
  // insert fails the /p/c/<token> URL will 404 and the sender will see it as
  // a failed send (the SendError is raised after the batch). Keeping the
  // row in the same batch as the draft delete means the two ops succeed or
  // fail atomically.
  if (confidentialRecord) {
    controlStmts.push(
      controlDb
        .prepare(
          `INSERT INTO confidential_messages
           (id, source_message_id, body_text, body_html, expires_at, view_passcode, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          confidentialRecord.token,
          messageId,
          confidentialRecord.bodyText,
          confidentialRecord.bodyHtml,
          confidentialRecord.expiresAt,
          confidentialRecord.passcode,
          userId,
        ),
    );
  }
  void confidentialToken;

  // Clean up the temp_uploads rows now that the message is on the wire.
  // The R2 blobs themselves are left for a future sweeper — they're harmless
  // orphans, and removing them in the hot send path would double the work.
  if (input.attachmentIds?.length) {
    const placeholders = input.attachmentIds.map(() => "?").join(",");
    controlStmts.push(
      controlDb
        .prepare(
          `DELETE FROM temp_uploads WHERE user_id = ? AND id IN (${placeholders})`,
        )
        .bind(userId, ...input.attachmentIds),
    );
  }
  if (controlStmts.length > 0) await controlDb.batch(controlStmts);

  // Auto-add recipients to the mailbox's shared contact list. Best-effort —
  // a contact-store hiccup must never make a successful send look failed.
  try {
    const all = [
      ...input.to,
      ...(input.cc ?? []),
      ...(input.bcc ?? []),
    ].map(email => ({ email }));
    await recordSendRecipients(identity.mailbox_id, all);
  } catch (err) {
    console.error("contact auto-add failed", err);
  }

  // Audit hook for outbound reply (issue #28). Records the send under the
  // mailbox the message went out on; never throws.
  try {
    await logAudit({
      userId,
      mailboxId: identity.mailbox_id,
      threadId,
      action: "reply",
      payload: {
        message_id: messageId,
        is_new_thread: isNewThread,
        to_count: input.to.length,
      },
    });
  } catch (err) {
    console.error("audit reply send failed", err);
  }

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
  // Replies can target a message in any mail DB. We don't have a global
  // (message_id → mail_db_id) index — that would be another denormalised
  // table maintained on every write — so we fan out across active mail DBs
  // and take the first hit. For single-DB deploys that's exactly one query
  // against primary; for multi-DB deploys it's at most N queries (and N is
  // typically 1–5 since each DB holds 8 GiB).
  const dbs = await getActiveMailDbs();
  for (const { db } of dbs) {
    const row = await db
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
    if (row) {
      const parentReferences = row.references_chain
        ? row.references_chain.split(/\s+/).filter(Boolean)
        : [];
      return { parentMessage: row, parentReferences };
    }
  }
  return { parentMessage: null, parentReferences: [] };
}

// Wrap an editor-emitted HTML fragment in a minimal <html><body> shell so
// recipient clients have a self-contained document. Lexical produces a
// fragment of <p>/<ul>/<ol>/<a>/<b>/<i> elements without any document chrome.
function wrapHtmlFragment(fragment: string): string {
  return `<!DOCTYPE html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;line-height:1.45;">
${fragment}
</body></html>`;
}

// Build an HTML alternative from the plain-text body. Steps:
//   1. Escape HTML metacharacters so user input never becomes markup.
//   2. Linkify bare http/https URLs.
//   3. Split on blank lines into <p> blocks; convert single newlines to <br>.
// The result is intentionally simple — recipients with HTML-capable clients
// see something readable, and clients that prefer text/plain still get the
// raw body unchanged.
function buildHtmlFromText(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  // Linkify after escaping so we wrap escaped text but the href stays clean.
  // The URL chars match a conservative set — no trailing punctuation grabs.
  const linkified = escaped.replace(
    /\b(https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?])/g,
    url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  );

  const paragraphs = linkified
    .split(/\n{2,}/)
    .map(p => p.replace(/\n/g, "<br>"))
    .filter(p => p.length > 0)
    .map(p => `<p>${p}</p>`)
    .join("\n");

  return `<!DOCTYPE html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;line-height:1.45;">
${paragraphs}
</body></html>`;
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

interface DroppedAttachmentLink {
  // Presigned R2 URL — recipients hit R2 directly, no Worker / Access in the
  // loop. Capped at 7 days by R2's S3-compatible signing.
  url: string;
  expiresAt: number;
  filename: string;
  size: number;
}

// Resolve the host the request came in on so the share-link URL matches the
// hostname the user actually uses (vanity domain vs *.workers.dev). We use
// `Host` (set by Cloudflare on every request) as the source of truth — both
// sendMessage call sites (the public /api/messages route and the internal
// dispatch-scheduled route) live inside an HTTP handler so headers() works.
// On the off chance it doesn't (no incoming request, or proxied without a
// host), fall back to the literal string "localhost" — sends still go out,
// the link is just less polished.
async function resolveHost(): Promise<string> {
  try {
    const h = await headers();
    const host =
      h.get("x-forwarded-host") ??
      h.get("host") ??
      null;
    if (host && host.length > 0) return host;
  } catch {
    // Outside a request scope — fall through.
  }
  return "localhost";
}

function formatBytesShort(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Render the "📎 file (size) — Download (expires date)" block for HTML
// recipients. Wrapped in a styled box so it visually reads as an attachment
// region rather than an arbitrary link list. Deliberately inline-styled
// (most mail clients strip <style> blocks).
function renderDroppedLinksHtml(links: DroppedAttachmentLink[]): string {
  const items = links
    .map(l => {
      const url = l.url;
      const expires = new Date(l.expiresAt * 1000).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
      const safeName = escapeHtml(l.filename);
      const safeUrl = escapeHtml(url);
      const safeExpires = escapeHtml(expires);
      const sizeLabel = escapeHtml(formatBytesShort(l.size));
      return `<div style="margin:0 0 6px 0;">📎 <strong>${safeName}</strong> (${sizeLabel}) — <a href="${safeUrl}" style="color:#2563eb;">Download</a> <span style="color:#666;">(expires ${safeExpires})</span></div>`;
    })
    .join("\n");
  return `\n<div style="margin-top:18px;padding:12px 14px;border:1px solid #e5e7eb;border-radius:6px;background:#fafafa;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:13px;">
<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#666;margin-bottom:8px;">Attachments via download link</div>
${items}
</div>`;
}

function renderDroppedLinksText(links: DroppedAttachmentLink[]): string {
  const lines = links.map(l => {
    const url = l.url;
    const expires = new Date(l.expiresAt * 1000).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    return `📎 ${l.filename} (${formatBytesShort(l.size)}) — ${url} (expires ${expires})`;
  });
  return `--\nAttachments via download link:\n${lines.join("\n")}`;
}

function serializeError(e: unknown): Record<string, unknown> {
  if (!(e instanceof Error)) return { value: String(e) };
  const out: Record<string, unknown> = {
    name: e.name,
    message: e.message,
    stack: e.stack,
  };
  // Include enumerable own properties (Cloudflare attaches `cause`, `code`,
  // sometimes a `response`-like shape).
  for (const key of Object.keys(e)) {
    out[key] = (e as unknown as Record<string, unknown>)[key];
  }
  if (e.cause !== undefined) out.cause = serializeError(e.cause);
  return out;
}

// Cryptographically-random URL-safe token. Used for confidential view URLs
// and read-tracking pixels. 22 base64url chars ≈ 132 bits of entropy — plenty
// for the "the token IS the auth" use case, and short enough to keep the
// emitted URL on a single line in the recipient's preview pane.
function generateOpaqueToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Generate a confidential-message passcode with a CSPRNG. Draws
// CONFIDENTIAL_PASSCODE_LENGTH characters uniformly from
// CONFIDENTIAL_PASSCODE_ALPHABET (uppercase, unambiguous). We over-sample
// random bytes and reject any byte >= the largest multiple of the alphabet
// size so every symbol is equally likely (no modulo bias).
export function generateConfidentialPasscode(): string {
  const alphabet = CONFIDENTIAL_PASSCODE_ALPHABET;
  const n = alphabet.length;
  const limit = 256 - (256 % n); // largest multiple of n that fits in a byte
  let out = "";
  while (out.length < CONFIDENTIAL_PASSCODE_LENGTH) {
    const buf = new Uint8Array(CONFIDENTIAL_PASSCODE_LENGTH);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= limit) continue; // reject to avoid modulo bias
      out += alphabet[b % n];
      if (out.length === CONFIDENTIAL_PASSCODE_LENGTH) break;
    }
  }
  return out;
}

// Returns the validated, canonicalised (uppercased) passcode string, null
// when the caller didn't pass one, or the literal string "invalid" so the
// caller can distinguish "not set" from "set but malformed". Trims so a
// trailing newline from a copy-paste doesn't reject the input, and uppercases
// so lowercase entry is accepted while storage stays canonical. The accepted
// shape is CONFIDENTIAL_PASSCODE_LENGTH characters drawn from the unambiguous
// alphabet (A–Z minus I/O/L, 2–9).
function normaliseConfidentialPasscode(
  raw: string | null | undefined,
): string | null | "invalid" {
  if (raw == null) return null;
  const trimmed = String(raw).trim().toUpperCase();
  if (trimmed === "") return null;
  const re = new RegExp(
    `^[${CONFIDENTIAL_PASSCODE_ALPHABET}]{${CONFIDENTIAL_PASSCODE_LENGTH}}$`,
  );
  if (!re.test(trimmed)) return "invalid";
  return trimmed;
}

// HTML body shown to the recipient when confidential mode is on. The visible
// content is intentionally short and contains the view URL + a human-readable
// expiry; the real message lives behind the /p/c/<token> route.
function buildConfidentialPlaceholderHtml(
  senderLabel: string,
  host: string,
  token: string,
  expiresAt: number,
  hasPasscode: boolean,
): string {
  const url = `https://${host}/p/c/${token}`;
  const expires = new Date(expiresAt * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const passLine = hasPasscode
    ? `<p style="margin:0 0 8px 0;color:#374151;font-size:13px;">The sender will share a passcode out-of-band — you'll be prompted for it.</p>`
    : "";
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;line-height:1.5;max-width:520px;">
  <p style="margin:0 0 12px 0;"><strong>${escapeHtml(senderLabel)}</strong> sent you a confidential message.</p>
  <p style="margin:0 0 16px 0;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:8px 14px;border-radius:6px;font-weight:500;">View the message</a></p>
  ${passLine}
  <p style="margin:0;color:#6b7280;font-size:12px;">Link expires ${escapeHtml(expires)}. The message content is not delivered to your mail server — clicking the link is the only way to read it.</p>
</div>`;
}

export type { Identity };

// ─── Calendar invite send (#81) ─────────────────────────────────────────
// Lightweight outbound for `text/calendar; method=REQUEST` (and CANCEL).
// We deliberately don't reuse `sendMessage` here — calendar invites don't
// thread, don't go through Mail Drop, and don't need the confidential /
// read-tracking machinery. The send_email binding builds MIME; we just
// hand it the body, the alternative HTML, and the attachments list.
//
// DKIM: relies on the existing send_email pipeline to sign — no special
// handling here. The "From" address is a real mailbox the user has access
// to, so its domain has a DKIM key configured by the existing setup flow.

export interface CalendarInviteSendInput {
  // Mailbox the invite is sent FROM. Caller has already verified access.
  fromMailboxId: string;
  // Recipient list — typically the event's attendee emails.
  to: string[];
  // Subject line (typically "Invite: {summary}" or "Cancelled: {summary}").
  subject: string;
  // Plain-text human description for clients that don't render the .ics.
  text: string;
  // Optional HTML alt body. When omitted the binding sends text-only.
  html?: string;
  // RFC 5545 source — must already be METHOD=REQUEST (or CANCEL).
  ics: string;
  // Match the .ics METHOD: REQUEST | CANCEL. Drives the calendar part's
  // Content-Type parameter so the recipient client treats it correctly
  // (a REQUEST renders as a meeting invite; CANCEL deletes it).
  method: "REQUEST" | "CANCEL";
}

export async function sendCalendarInvite(
  userId: string,
  input: CalendarInviteSendInput,
): Promise<void> {
  const identity = await findIdentity(userId, input.fromMailboxId);
  if (!identity) {
    throw new SendError("not_authorised", "You can't send from that mailbox.");
  }
  if (identity.role === "reader") {
    throw new SendError("forbidden", "Your role on this domain is read-only.");
  }
  if (input.to.length === 0) {
    throw new SendError("invalid", "At least one attendee is required.");
  }

  const env = getEnv();
  const fromAddr = fullAddress(identity);
  const fromName = identity.display_name?.trim() || undefined;
  const filename = input.method === "CANCEL" ? "cancel.ics" : "invite.ics";
  const contentType = `text/calendar; method=${input.method}; charset="utf-8"`;

  try {
    await env.EMAIL.send({
      from: fromName ? { name: fromName, email: fromAddr } : fromAddr,
      to: input.to,
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
      attachments: [
        {
          disposition: "attachment",
          filename,
          type: contentType,
          content: input.ics,
        },
      ],
    });
  } catch (e) {
    console.error("env.EMAIL.send (invite) rejected", {
      error: serializeError(e),
      to: input.to,
      method: input.method,
    });
    const detail = e instanceof Error ? e.message : String(e);
    throw new SendError("send_failed", `Cloudflare rejected the invite: ${detail}`);
  }
}
