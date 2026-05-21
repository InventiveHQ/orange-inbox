import PostalMime, { type Address, type Attachment, type Header } from "postal-mime";
import { isExecutable } from "./attachment-safety";
import { extractAuthservId, parseAuthenticationResults } from "./auth-results";
import { findHeader, parseListUnsubscribe } from "./list-unsubscribe";
import { classify } from "./triage";
import type { AddressInfo, ParsedAttachment, ParsedMessage } from "./types";

export async function parseEmail(
  raw: ReadableStream,
  trustedAuthservId?: string,
): Promise<ParsedMessage> {
  const parsed = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });

  const text = parsed.text;
  const html = parsed.html;
  const from = flattenOne(parsed.from) ?? { addr: "" };

  // SECURITY: an inbound message can embed its own Authentication-Results
  // header(s). We must consider ONLY the header stamped by our trusted MX
  // (Cloudflare prepends it, so it is the first one). selectTrustedAuthResults
  // picks that single header — never merges across headers — and parses it
  // alone so a forged verdict can't slip in for a method Cloudflare omitted.
  const authResultsHeaders = collectHeaders(parsed.headers, "authentication-results");
  const trustedAuthResultsHeader = selectTrustedAuthResultsHeader(
    authResultsHeaders,
    trustedAuthservId,
  );
  const authResults = parseAuthenticationResults(trustedAuthResultsHeader);

  // Reply-To: postal-mime gives us an Address[] (could be a single mailbox
  // or a group). We only care about the first usable address, lowercased.
  // We surface it ONLY if it differs from from.addr — that's the trigger
  // for the safety banner downstream, and storing-only-when-different
  // keeps the column meaningful as an `IS NOT NULL` predicate.
  const replyTo = flattenOne(parsed.replyTo?.[0]);
  const fromAddrLower = from.addr.toLowerCase();
  const replyToLower = replyTo?.addr ? replyTo.addr.toLowerCase() : null;
  const replyToAddr =
    replyToLower && replyToLower !== fromAddrLower ? replyToLower : null;

  // Pull anti-loop signals out of raw headers. postal-mime gives us the
  // header array with lowercased keys; we look up each header inline so we
  // don't need a per-message Map. RFC 3834 says auto-responders MUST NOT
  // reply to mail bearing Auto-Submitted other than "no", and SHOULD NOT
  // reply to anything that looks like a list/bulk delivery — these three
  // booleans + the precedence string + the autoSubmitted string are what
  // the responder needs to make that call without re-walking the headers.
  const headers = parsed.headers ?? [];
  let autoSubmitted: string | null = null;
  let precedence: string | null = null;
  let hasListHeaders = false;
  let hasListId = false;
  for (const h of headers) {
    if (h.key === "auto-submitted") {
      autoSubmitted = h.value.trim().toLowerCase();
    } else if (h.key === "precedence") {
      precedence = h.value.trim().toLowerCase();
    } else if (h.key.startsWith("list-")) {
      hasListHeaders = true;
      // List-Id specifically signals a mailing list / forum (RFC 2919). We
      // track it separately because the auto-categorizer needs to distinguish
      // forum-style mail (List-Id present) from generic List-* traffic
      // (List-Unsubscribe alone, common on marketing blasts).
      if (h.key === "list-id") hasListId = true;
    }
  }

  // RFC 2369 List-Unsubscribe + RFC 8058 one-click. Both headers travel as
  // raw values on the parsed.headers array — postal-mime doesn't promote
  // them to first-class fields the way it does From/To/Subject.
  const unsub = parseListUnsubscribe(
    findHeader(parsed.headers, "list-unsubscribe"),
    findHeader(parsed.headers, "list-unsubscribe-post"),
  );

  const out: ParsedMessage = {
    messageId: parsed.messageId ?? `<${crypto.randomUUID()}@orange-inbox.local>`,
    inReplyTo: parsed.inReplyTo,
    references: splitReferences(parsed.references),
    from,
    to: flattenMany(parsed.to),
    cc: flattenMany(parsed.cc),
    bcc: flattenMany(parsed.bcc),
    subject: parsed.subject ?? "",
    date: parsed.date ? Date.parse(parsed.date) || Date.now() : Date.now(),
    text,
    html,
    snippet: makeSnippet(text, html),
    attachments: (parsed.attachments ?? []).map(toParsedAttachment),
    autoSubmitted,
    precedence,
    hasListHeaders,
    hasListId,
    authResults,
    replyToAddr,
    listUnsubUrl: unsub.url,
    listUnsubMailto: unsub.mailto,
    listUnsubOneClick: unsub.oneClick,
    // Placeholder flags — recomputed via classify() once the headers-only
    // ParsedMessage is assembled. store.ts may re-classify with per-user
    // context (VIP / contacts / mailbox-ownership) before persisting.
    isMarketing: false,
    isActionItem: false,
  };
  const triage = classify(out);
  out.isMarketing = triage.isMarketing;
  out.isActionItem = triage.isActionItem;
  return out;
}

// Collect every header value matching the (lowercase) name as a separate
// array entry, in received order. postal-mime preserves header order, so
// for a header type the trusted receiver prepends (Authentication-Results)
// the first entry is the one our MX stamped.
function collectHeaders(headers: Header[] | undefined, lowerName: string): string[] {
  if (!headers || headers.length === 0) return [];
  const values: string[] = [];
  for (const h of headers) {
    if (h.key.toLowerCase() === lowerName && h.value) {
      values.push(h.value);
    }
  }
  return values;
}

// SECURITY-CRITICAL: choose the ONE Authentication-Results header we trust.
//
// An attacker controls the raw message and can embed extra
// Authentication-Results headers with forged "pass" verdicts. We must never
// merge headers and must never read verdicts from an attacker-supplied one.
//
//   * If TRUSTED_AUTHSERV_ID is configured: return the first header whose
//     parsed authserv-id (case-insensitive) equals it. If none match,
//     return null — the message has NO trusted auth results (treated as
//     unknown verdicts). We deliberately do NOT fall back to attacker data.
//   * If TRUSTED_AUTHSERV_ID is not configured: return ONLY the first
//     header. Cloudflare prepends its Authentication-Results header, so the
//     first entry is the trusted one. Never merge across headers.
//
// `headers` must be in received order (see collectHeaders).
function selectTrustedAuthResultsHeader(
  headers: string[],
  trustedAuthservId?: string,
): string | null {
  if (headers.length === 0) return null;

  const trusted = trustedAuthservId?.trim().toLowerCase();
  if (trusted) {
    for (const h of headers) {
      if (extractAuthservId(h) === trusted) return h;
    }
    // No header from the trusted receiver — do not trust anything.
    return null;
  }

  // No trusted authserv-id configured: trust only the first (prepended)
  // header. This is the Cloudflare-stamped one for a normal deployment.
  return headers[0];
}

// Returns true when this mailbox has never received a message from the
// given from_addr before. Case-insensitive (we lowercase on insert too).
// `mailDb` is the *target* mail DB for the new message — running the
// lookup against any other DB would miss the previous message. Catches
// both first-ever-message and first-ever-message-in-this-mailbox.
export async function isFirstContact(
  mailDb: D1Database,
  mailboxId: string,
  fromAddrLower: string,
): Promise<boolean> {
  if (!fromAddrLower) return false;
  const row = await mailDb
    .prepare(
      "SELECT 1 AS hit FROM messages WHERE mailbox_id = ? AND LOWER(from_addr) = ? LIMIT 1",
    )
    .bind(mailboxId, fromAddrLower)
    .first<{ hit: number }>();
  return row === null;
}

// Exported so tests can hit the helper directly without going through
// postal-mime's parser.
export function splitReferences(refs: string | undefined): string[] {
  if (!refs) return [];
  return refs.split(/\s+/).map(s => s.trim()).filter(Boolean);
}

function flattenOne(addr: Address | undefined): AddressInfo | undefined {
  if (!addr) return undefined;
  if ("address" in addr && addr.address) return { addr: addr.address, name: addr.name || undefined };
  if ("group" in addr && addr.group) return flattenOne(addr.group[0]);
  return undefined;
}

function flattenMany(addrs: Address[] | undefined): AddressInfo[] {
  if (!addrs) return [];
  const out: AddressInfo[] = [];
  for (const a of addrs) {
    if ("address" in a && a.address) {
      out.push({ addr: a.address, name: a.name || undefined });
    } else if ("group" in a && a.group) {
      for (const m of a.group) {
        out.push({ addr: m.address, name: m.name || undefined });
      }
    }
  }
  return out;
}

export function makeSnippet(text: string | undefined, html: string | undefined): string {
  const source = text || (html ? stripHtml(html) : "");
  return source.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ");
}

function toParsedAttachment(a: Attachment): ParsedAttachment {
  const filename = a.filename ?? null;
  const contentType = a.mimeType;
  return {
    filename,
    contentType,
    disposition: a.disposition,
    contentId: a.contentId?.replace(/^<|>$/g, ""),
    bytes: toArrayBuffer(a.content),
    isExecutable: isExecutable(filename, contentType),
  };
}

function toArrayBuffer(content: ArrayBuffer | Uint8Array | string): ArrayBuffer {
  if (content instanceof ArrayBuffer) return content;
  if (content instanceof Uint8Array) {
    return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
  }
  return new TextEncoder().encode(content).buffer as ArrayBuffer;
}
