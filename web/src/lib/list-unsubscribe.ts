import { getDb, getEnv } from "./db";
import { fullAddress } from "./identities";
import { getActiveMailDbs, getMailDbForThread } from "./mail-db";

// One-click unsubscribe action, shared between the per-message API
// (`/api/messages/[id]/unsubscribe`) and the bulk Subscriptions flow.
//
// Three branches, in priority order:
//   1. one-click (RFC 8058) — POST `List-Unsubscribe=One-Click` to the https
//      URL and treat 2xx as success.
//   2. https URL (RFC 2369, no one-click) — return { method: "open", url }
//      so the client opens it in a new tab. We don't navigate server-side.
//   3. mailto: — send an empty unsubscribe email from the user's mailbox.
//
// Idempotency: messages already stamped with `unsubscribed_at` short-circuit.
//
// SSRF: branch (1) is the only one that issues an outbound request from the
// Worker. Defensive checks live in `postOneClick`:
//   - https-only (parsed via URL constructor; throws on garbage).
//   - 10s AbortController timeout — sender-controlled URLs can stall.
//   - redirect: "manual" — chasing a redirect into private space would be
//     the classic SSRF foothold.
//   - Any non-https final scheme is rejected.
//
// The Worker runtime already prevents outbound to private IP ranges, so we
// don't try to enforce that ourselves.

export interface UnsubscribeMessageContext {
  messageId: string;
  threadId: string;
  mailboxId: string;
  mailboxLocalPart: string;
  mailboxDomainName: string;
  fromAddr: string;
  listUnsubUrl: string | null;
  listUnsubMailto: string | null;
  listUnsubOneClick: boolean;
  unsubscribedAt: number | null;
}

export type UnsubscribeOutcome =
  | { kind: "already" }
  | { kind: "posted" }       // one-click POST succeeded
  | { kind: "mailto_sent" }  // sent an empty unsubscribe email
  | { kind: "open"; url: string };

export class UnsubscribeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

// Resolve a message id the user is allowed to act on, fanning across active
// mail DBs to find the row. Returns null if not found / not visible.
export async function lookupUnsubscribeContext(
  userId: string,
  messageId: string,
): Promise<UnsubscribeMessageContext | null> {
  // Every mail DB has its own messages table; we ask each in turn until we
  // find a hit, then re-confirm access via the control DB.
  const dbs = await getActiveMailDbs();
  for (const { db } of dbs) {
    const row = await db
      .prepare(
        `SELECT id, thread_id, mailbox_id, from_addr,
                list_unsub_url, list_unsub_mailto, list_unsub_one_click, unsubscribed_at
           FROM messages WHERE id = ?`,
      )
      .bind(messageId)
      .first<{
        id: string;
        thread_id: string;
        mailbox_id: string;
        from_addr: string;
        list_unsub_url: string | null;
        list_unsub_mailto: string | null;
        list_unsub_one_click: number;
        unsubscribed_at: number | null;
      }>();
    if (!row) continue;

    // Access check — re-join control DB for (user, mailbox) authorisation,
    // and pull the local_part / domain so the mailto branch can build a
    // From for env.EMAIL.send.
    const access = await getDb()
      .prepare(
        `SELECT mb.local_part, d.name AS domain_name
           FROM user_mailbox_access uma
           INNER JOIN mailboxes mb ON mb.id = uma.mailbox_id
           INNER JOIN domains d ON d.id = mb.domain_id
          WHERE uma.user_id = ? AND uma.mailbox_id = ?`,
      )
      .bind(userId, row.mailbox_id)
      .first<{ local_part: string; domain_name: string }>();
    if (!access) return null;

    return {
      messageId: row.id,
      threadId: row.thread_id,
      mailboxId: row.mailbox_id,
      mailboxLocalPart: access.local_part,
      mailboxDomainName: access.domain_name,
      fromAddr: row.from_addr,
      listUnsubUrl: row.list_unsub_url,
      listUnsubMailto: row.list_unsub_mailto,
      listUnsubOneClick: row.list_unsub_one_click === 1,
      unsubscribedAt: row.unsubscribed_at,
    };
  }
  return null;
}

// The unsubscribe action proper. Caller decides whether to also archive
// the thread (per-message: no; bulk: yes).
export async function unsubscribeFromMessage(
  ctx: UnsubscribeMessageContext,
): Promise<UnsubscribeOutcome> {
  if (ctx.unsubscribedAt) return { kind: "already" };

  // Branch 1: one-click POST.
  if (ctx.listUnsubOneClick && ctx.listUnsubUrl) {
    await postOneClick(ctx.listUnsubUrl);
    await stampUnsubscribed(ctx);
    return { kind: "posted" };
  }

  // Branch 2: hand the URL back to the client.
  if (ctx.listUnsubUrl) {
    // We DON'T stamp unsubscribed_at here — we have no confirmation the
    // user actually completed the flow on the destination page.
    return { kind: "open", url: ctx.listUnsubUrl };
  }

  // Branch 3: send an empty email to the mailto target.
  if (ctx.listUnsubMailto) {
    await sendMailtoUnsubscribe(ctx, ctx.listUnsubMailto);
    await stampUnsubscribed(ctx);
    return { kind: "mailto_sent" };
  }

  throw new UnsubscribeError(
    "no_target",
    "This message has no advertised unsubscribe mechanism.",
  );
}

async function postOneClick(rawUrl: string): Promise<void> {
  // Parse first so we reject malformed URLs before any fetch attempt.
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsubscribeError("bad_url", "Unsubscribe URL is not a valid URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new UnsubscribeError(
      "not_https",
      "Refusing to POST to a non-https unsubscribe URL.",
    );
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(parsed.toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
      // Following redirects could land us on http:// or a private host
      // (depending on runtime). Forcing manual lets us refuse anything
      // surprising; the One-Click contract treats the immediate response
      // as authoritative, so 2xx-after-3xx isn't required.
      redirect: "manual",
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new UnsubscribeError(
        "remote_failed",
        `Unsubscribe POST returned ${res.status}.`,
      );
    }
  } catch (e) {
    if (e instanceof UnsubscribeError) throw e;
    if (e instanceof Error && e.name === "AbortError") {
      throw new UnsubscribeError("timeout", "Unsubscribe request timed out.");
    }
    throw new UnsubscribeError(
      "fetch_failed",
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    clearTimeout(timer);
  }
}

async function sendMailtoUnsubscribe(
  ctx: UnsubscribeMessageContext,
  mailtoUrl: string,
): Promise<void> {
  const parsed = parseMailto(mailtoUrl);
  if (!parsed.recipients.length) {
    throw new UnsubscribeError(
      "bad_mailto",
      "mailto: unsubscribe URL has no recipient.",
    );
  }
  const env = getEnv();
  const fromAddr = fullAddress({
    local_part: ctx.mailboxLocalPart,
    domain_name: ctx.mailboxDomainName,
  });
  // Bodies / extra headers from the mailto are ignored — RFC 8058 specifies
  // the body shouldn't matter and most senders just want SOMETHING to land
  // at the unsubscribe address. An empty body is the safest contract.
  const subject = parsed.subject || "unsubscribe";
  try {
    await env.EMAIL.send({
      from: fromAddr,
      to: parsed.recipients[0], // send_email accepts a single string here
      subject,
      text: "",
    });
  } catch (e) {
    throw new UnsubscribeError(
      "send_failed",
      e instanceof Error ? e.message : String(e),
    );
  }
}

interface ParsedMailto {
  recipients: string[];
  subject: string | null;
}

function parseMailto(s: string): ParsedMailto {
  // mailto:<addr>[,<addr>][?subject=...&body=...]
  const match = /^mailto:([^?]*)(?:\?(.*))?$/i.exec(s.trim());
  if (!match) return { recipients: [], subject: null };
  const recipients = (match[1] || "")
    .split(",")
    .map(s => decodeURIComponent(s).trim())
    .filter(Boolean);
  let subject: string | null = null;
  if (match[2]) {
    for (const pair of match[2].split("&")) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const key = pair.slice(0, eq).toLowerCase();
      const val = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
      if (key === "subject") subject = val;
    }
  }
  return { recipients, subject };
}

async function stampUnsubscribed(ctx: UnsubscribeMessageContext): Promise<void> {
  const mailDb = await getMailDbForThread(ctx.threadId);
  await mailDb
    .prepare(
      "UPDATE messages SET unsubscribed_at = unixepoch() WHERE id = ? AND unsubscribed_at IS NULL",
    )
    .bind(ctx.messageId)
    .run();
}

// Bulk action behind the Subscriptions page: unsubscribe from the latest
// actionable message + archive every thread carrying mail from this sender
// in the given mailbox. Used for both http(s) one-click + mailto branches;
// for the "open" branch the client handles the URL, then re-calls with a
// confirm flag (TODO — for now we still archive on the client's behalf).
export async function bulkUnsubscribeAndArchiveSender(
  ctx: UnsubscribeMessageContext,
): Promise<UnsubscribeOutcome> {
  const outcome = await unsubscribeFromMessage(ctx);
  // Stamp unsubscribed_at on every message in this mailbox from the same
  // sender so the Subscriptions page collapses the row to "All
  // unsubscribed" — even messages that lack a target individually.
  const mailDb = await getMailDbForThread(ctx.threadId);
  await mailDb
    .prepare(
      `UPDATE messages
          SET unsubscribed_at = unixepoch()
        WHERE mailbox_id = ?
          AND LOWER(from_addr) = LOWER(?)
          AND unsubscribed_at IS NULL`,
    )
    .bind(ctx.mailboxId, ctx.fromAddr)
    .run();

  // Archive every thread the sender is in. We pull thread_ids from the
  // mail DB and update threads_index in the control DB — same shape as
  // blockSenderAndArchiveThread but scoped to all threads, not just one.
  const { results: threadRows } = await mailDb
    .prepare(
      `SELECT DISTINCT thread_id FROM messages
        WHERE mailbox_id = ? AND LOWER(from_addr) = LOWER(?)`,
    )
    .bind(ctx.mailboxId, ctx.fromAddr)
    .all<{ thread_id: string }>();
  const ids = (threadRows ?? []).map(r => r.thread_id);
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    await getDb()
      .prepare(
        `UPDATE threads_index
            SET archived = 1, unread_count = 0
          WHERE thread_id IN (${placeholders})`,
      )
      .bind(...ids)
      .run();
  }
  return outcome;
}
