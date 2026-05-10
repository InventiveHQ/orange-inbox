import type { Env, ParsedMessage } from "./types";

// Vacation / out-of-office auto-responder. Called from store.ts after a
// message is fully persisted and rules have run. Honours RFC 3834 anti-loop
// rules so we never reply to:
//   - automated mail (Auto-Submitted: auto-generated/auto-replied)
//   - bulk/list/junk traffic (Precedence + List-* headers)
//   - bouncers and noreply senders (MAILER-DAEMON, noreply, no-reply)
//   - someone we already auto-replied to within the cooldown window
//
// The actual send round-trips through the web worker via the existing service
// binding (env.WEB / env.INTERNAL_SECRET) — same pattern as the new-message
// notify and the scheduled-send dispatcher. The web side owns env.EMAIL.send,
// the mailbox identity lookup, and the cooldown-log write.

interface AutoresponderRow {
  enabled: number;
  starts_at: number | null;
  ends_at: number | null;
  subject: string;
  body_text: string;
  body_html: string | null;
  cooldown_hours: number;
}

export async function maybeAutoReply(
  env: Env,
  mailboxId: string,
  parsed: ParsedMessage,
): Promise<void> {
  // Cheap upfront checks before we hit the DB. If the inbound looks
  // automated, bail without even reading the responder row — saves a query
  // on every list-broadcast / bounce / Mailgun receipt that lands.
  if (looksAutomated(parsed)) return;

  const row = await env.DB
    .prepare(
      `SELECT enabled, starts_at, ends_at, subject, body_text, body_html, cooldown_hours
         FROM mailbox_autoresponders WHERE mailbox_id = ?`,
    )
    .bind(mailboxId)
    .first<AutoresponderRow>();
  if (!row || row.enabled !== 1) return;

  const now = Math.floor(Date.now() / 1000);
  if (row.starts_at != null && now < row.starts_at) return;
  if (row.ends_at != null && now > row.ends_at) return;

  const toAddr = parsed.from.addr.trim().toLowerCase();
  if (!toAddr) return;
  // The mailbox shouldn't auto-reply to itself if a copy somehow loops
  // back through the MX. Cheap belt-and-braces check; the mailbox lookup
  // happens server-side so we don't have the address handy here, but
  // self-addressed inbound is rare enough that the cooldown gate catches
  // any pathological case anyway.

  // Cooldown ledger: skip if we already replied to this address from this
  // mailbox within `cooldown_hours`. Stops repeated auto-replies during the
  // window when the same correspondent sends multiple messages.
  const cooldownSeconds = Math.max(1, Math.floor(row.cooldown_hours * 3600));
  const cutoff = now - cooldownSeconds;
  const recent = await env.DB
    .prepare(
      `SELECT 1 AS hit FROM mailbox_autoresponder_log
        WHERE mailbox_id = ? AND to_addr = ? AND sent_at >= ?
        LIMIT 1`,
    )
    .bind(mailboxId, toAddr, cutoff)
    .first<{ hit: number }>();
  if (recent) return;

  if (!env.WEB || !env.INTERNAL_SECRET) {
    // Without the service binding we can't send. Stay quiet in dev.
    return;
  }

  try {
    const res = await env.WEB.fetch(
      new Request("https://internal/api/internal/send-autoreply", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-secret": env.INTERNAL_SECRET,
        },
        body: JSON.stringify({
          mailboxId,
          toAddr,
          subject: row.subject,
          bodyText: row.body_text,
          bodyHtml: row.body_html ?? null,
        }),
      }),
    );
    if (!res.ok) {
      console.warn(
        `send-autoreply ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.warn("send-autoreply threw", err);
  }
}

// Inline anti-loop classifier. Centralised so store.ts and any future caller
// can short-circuit before touching the responder table. RFC 3834 defines
// most of these signals; the noreply heuristic is industry convention.
function looksAutomated(parsed: ParsedMessage): boolean {
  const submitted = parsed.autoSubmitted;
  if (submitted && submitted !== "no") return true;

  const precedence = parsed.precedence;
  if (
    precedence === "bulk" ||
    precedence === "list" ||
    precedence === "junk"
  ) {
    return true;
  }

  if (parsed.hasListHeaders) return true;

  const fromAddr = parsed.from.addr.toLowerCase();
  if (!fromAddr) return true;
  if (fromAddr.startsWith("mailer-daemon@")) return true;
  // Match common no-reply local-parts. Catches both `noreply@…` and
  // `no-reply@…` plus prefixed variants like `no-reply-marketing@…`.
  const localPart = fromAddr.split("@", 1)[0] ?? "";
  if (localPart.includes("noreply") || localPart.includes("no-reply")) {
    return true;
  }

  return false;
}
