import { NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  UnsubscribeError,
  bulkUnsubscribeAndArchiveSender,
  lookupUnsubscribeContext,
  unsubscribeFromMessage,
} from "@/lib/list-unsubscribe";

// One-click unsubscribe (issue #18) + bulk-from-sender (issue #76).
//
// Three response shapes (200 unless otherwise noted):
//   { ok: true, status: "already" }      — already unsubscribed; idempotent.
//   { ok: true, status: "posted" }       — RFC 8058 one-click POST succeeded.
//   { ok: true, status: "mailto_sent" }  — sent the empty unsubscribe email.
//   { ok: true, status: "open", url }    — no one-click; client opens URL.
//
// Errors:
//   400 — bad URL / no advertised mechanism / mailto without a recipient.
//   401 — unauthenticated.
//   404 — message not visible to this user.
//   502 — remote failure (timeout, non-2xx).
//
// SSRF mitigations live in `unsubscribeFromMessage` → `postOneClick`:
//   https-only, 10s AbortController timeout, redirect: "manual", explicit
//   2xx check. The Worker runtime additionally blocks outbound traffic to
//   private IP ranges, so the surface here is the request the SENDER
//   advertised — not arbitrary user-supplied URLs.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;

    // Optional `bulk=1` flag — used by the Subscriptions page to roll
    // the unsubscribe + archive-all-from-this-sender bulk action up
    // through the same code path.
    const url = new URL(req.url);
    const isBulk = url.searchParams.get("bulk") === "1";

    const msg = await lookupUnsubscribeContext(user.id, id);
    if (!msg) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const outcome = isBulk
      ? await bulkUnsubscribeAndArchiveSender(msg)
      : await unsubscribeFromMessage(msg);

    if (outcome.kind === "open") {
      return NextResponse.json({ ok: true, status: "open", url: outcome.url });
    }
    return NextResponse.json({ ok: true, status: outcome.kind });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (e instanceof UnsubscribeError) {
      // 4xx for caller-side problems (bad data on the message);
      // 502 for remote-side failures (timeout, non-2xx, send rejected).
      const remote = ["remote_failed", "fetch_failed", "timeout", "send_failed"].includes(
        e.code,
      );
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: remote ? 502 : 400 },
      );
    }
    console.error("unsubscribe", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
