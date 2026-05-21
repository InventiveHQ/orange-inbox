import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// Public endpoint backing the /p/c/<token> viewer (#66). NO requireUser —
// the token is the only credential. Both this route and the viewer live
// under /p/*, the single prefix covered by the Cloudflare Access Bypass
// policy; Access must NOT gate /p/*.
//
// Two actions:
//   - { action: "view" }: increment the views counter for the non-passcode
//     path. The body itself came down via SSR, so this is a fire-and-forget
//     counter bump.
//   - { action: "unlock", passcode }: verify the high-entropy alphanumeric
//     code in constant-ish time and return the body. Throttled per-IP with a
//     token bucket.
//
// We intentionally use a per-IP token-bucket throttle rather than a
// per-token attempt cap. A per-token cap would let an attacker
// brick a confidential message by attempting it 10 times — denial-of-message
// against the legitimate recipient. The per-IP throttle slows brute-force
// without enabling that. The passcode is an 8-character code drawn from a
// 31-symbol unambiguous alphabet (~40 bits of entropy), so the per-IP
// throttle plus the keyspace make brute-force infeasible.

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_HITS = 20;       // hits per IP per window
const PASSCODE_ATTEMPT_MAX = 8;       // unlock attempts per IP per window

interface RateBucket {
  windowStart: number;
  hits: number;
  passcodeAttempts: number;
}

const ipBuckets: Map<string, RateBucket> = new Map();

function rateCheck(ip: string, isPasscodeAttempt: boolean): boolean {
  const now = Date.now();
  const cur = ipBuckets.get(ip);
  if (!cur || now - cur.windowStart > RATE_LIMIT_WINDOW_MS) {
    ipBuckets.set(ip, {
      windowStart: now,
      hits: 1,
      passcodeAttempts: isPasscodeAttempt ? 1 : 0,
    });
    if (ipBuckets.size > 1024) {
      for (const [key, b] of ipBuckets) {
        if (now - b.windowStart > RATE_LIMIT_WINDOW_MS) ipBuckets.delete(key);
      }
    }
    return true;
  }
  if (isPasscodeAttempt && cur.passcodeAttempts >= PASSCODE_ATTEMPT_MAX) return false;
  if (cur.hits >= RATE_LIMIT_MAX_HITS) return false;
  cur.hits += 1;
  if (isPasscodeAttempt) cur.passcodeAttempts += 1;
  return true;
}

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

interface PostBody {
  action?: "view" | "unlock";
  passcode?: string;
}

interface Row {
  id: string;
  body_text: string;
  body_html: string | null;
  expires_at: number;
  view_passcode: string | null;
  revoked: number;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  if (!token || !/^[A-Za-z0-9_-]{8,}$/.test(token)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body || (body.action !== "view" && body.action !== "unlock")) {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }
  const ip = clientIp(req);
  const isUnlock = body.action === "unlock";
  if (!rateCheck(ip, isUnlock)) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const db = getDb();
  const row = await db
    .prepare(
      `SELECT id, body_text, body_html, expires_at, view_passcode, revoked
         FROM confidential_messages WHERE id = ?`,
    )
    .bind(token)
    .first<Row>();

  const now = Math.floor(Date.now() / 1000);
  if (!row || row.revoked === 1 || row.expires_at <= now) {
    // Same 410 whether the row is missing, revoked, or expired — don't leak
    // which one. The SSR page caps at the same place.
    return NextResponse.json({ error: "gone" }, { status: 410 });
  }

  if (body.action === "view") {
    if (row.view_passcode) {
      // The non-passcode view ping is only ever issued by the SSR-decided
      // unlocked path. A passcode-protected message arriving here means
      // the caller is trying to skip the gate — refuse without leaking.
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    await db
      .prepare("UPDATE confidential_messages SET views = views + 1 WHERE id = ?")
      .bind(token)
      .run();
    return NextResponse.json({ ok: true });
  }

  // action === "unlock"
  if (!row.view_passcode) {
    // No passcode required, but the caller is trying to unlock — return the
    // body anyway (treats this as the legitimate path; some clients always
    // post unlock from a habit). Still bumps the view counter.
    await db
      .prepare("UPDATE confidential_messages SET views = views + 1 WHERE id = ?")
      .bind(token)
      .run();
    return NextResponse.json({ body_text: row.body_text, body_html: row.body_html });
  }
  // Stored passcodes are canonicalised to uppercase at creation time, so we
  // uppercase the submitted value before comparing — the recipient can type
  // the code in any case. Comparison stays constant-time.
  const supplied = (body.passcode ?? "").toString().trim().toUpperCase();
  if (!constantTimeEquals(supplied, row.view_passcode)) {
    // Don't bump views on a failed attempt. The per-IP throttle is the
    // only thing standing in the way of an offline brute-force here.
    return NextResponse.json({ error: "wrong_passcode" }, { status: 401 });
  }
  await db
    .prepare("UPDATE confidential_messages SET views = views + 1 WHERE id = ?")
    .bind(token)
    .run();
  return NextResponse.json({ body_text: row.body_text, body_html: row.body_html });
}

// Cheap constant-time string compare. Web Crypto doesn't ship a built-in for
// this. Length-agnostic: an early return on a length mismatch leaks only the
// length, which is fixed and public for our passcodes anyway; the per-symbol
// comparison below is constant-time across equal-length inputs. A network
// round-trip dominates the observable timing regardless — we still bother
// since defence-in-depth is essentially free.
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
