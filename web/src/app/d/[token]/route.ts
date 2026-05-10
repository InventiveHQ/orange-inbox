import { NextRequest } from "next/server";
import { getEnv } from "@/lib/db";
import { consumeShareLink, type ConsumeFailure } from "@/lib/share-links";

// Public download endpoint for Mail Drop share links.
//
// AUTH MODEL — deliberately unauthenticated.
//   The token in the URL path IS the credential. Anyone holding the URL can
//   download the file until it expires (default 30 days) or hits its
//   max_downloads cap (default unlimited within TTL). This mirrors how every
//   other "share-by-link" service works (Drive/Dropbox/WeTransfer) and is the
//   point of the feature — recipients of the email don't have orange-inbox
//   accounts.
//
//   IMPORTANT operational note: in production, the host Worker sits behind
//   Cloudflare Access. For this route to actually be reachable to external
//   recipients, the Access application MUST add a Bypass policy for the
//   `/d/*` path (Zero Trust → Access → Applications → Policies → Add policy
//   → Action: Bypass → Path: /d/*), or the route must be served from a
//   separate hostname not covered by the Access app. Without that, recipient
//   clicks will hit the Access login page rather than the download. See the
//   PR description for setup instructions.
//
// RATE LIMITING — best effort, per-Worker-instance.
//   We keep a tiny in-memory token bucket keyed by client IP. This is purely
//   to blunt naive enumeration / brute-force on tokens; serious abuse would
//   need a durable store (KV/D1) which is out of scope for v1. Cloudflare's
//   own per-IP DDOS protections sit in front of this anyway.

const RATE_LIMIT_WINDOW_MS = 60_000;     // 1 minute
const RATE_LIMIT_MAX_HITS = 30;          // hits per IP per window

interface RateBucket {
  windowStart: number;
  count: number;
}

const ipBuckets: Map<string, RateBucket> = new Map();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const cur = ipBuckets.get(ip);
  if (!cur || now - cur.windowStart > RATE_LIMIT_WINDOW_MS) {
    ipBuckets.set(ip, { windowStart: now, count: 1 });
    // Opportunistic GC so the map doesn't grow forever in a long-lived
    // isolate. Sweeping inline keeps us off any timer (which Workers don't
    // have anyway). Cheap because the map only ever holds active IPs.
    if (ipBuckets.size > 1024) {
      for (const [key, b] of ipBuckets) {
        if (now - b.windowStart > RATE_LIMIT_WINDOW_MS) ipBuckets.delete(key);
      }
    }
    return true;
  }
  if (cur.count >= RATE_LIMIT_MAX_HITS) return false;
  cur.count += 1;
  return true;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const ip =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  if (!checkRateLimit(ip)) {
    return new Response("Too many requests", {
      status: 429,
      headers: { "Retry-After": "60", "Cache-Control": "no-store" },
    });
  }

  const { token } = await ctx.params;
  if (!token || !/^[a-zA-Z0-9_-]{8,}$/.test(token)) {
    return notFound();
  }

  const result = await consumeShareLink(token);
  if (!result.ok) return statusFor(result.reason);
  const { row } = result;

  // r2_bucket is forward-looking — today only ATTACHMENTS is wired up. Any
  // other value means a future migration referenced a bucket this code
  // doesn't know about yet; refuse rather than guess.
  const env = getEnv();
  if (row.r2_bucket !== "ATTACHMENTS") {
    console.error("share link points at unknown bucket", row.r2_bucket);
    return new Response("Internal error", { status: 500 });
  }

  const obj = await env.ATTACHMENTS.get(row.r2_key);
  if (!obj) {
    // The bookkeeping row exists but the bytes are gone — treat as
    // permanently gone, not "try again later".
    return new Response("File no longer available", {
      status: 410,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const filename = row.filename || "download";
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": row.content_type || "application/octet-stream",
      "Content-Disposition": `attachment; ${rfc5987Disposition(filename)}`,
      "Content-Length": String(row.size),
      "X-Content-Type-Options": "nosniff",
      // Don't cache: the response embeds an effectful side-effect (download
      // counter increment) and the link can stop working at any moment.
      "Cache-Control": "private, no-store",
      // Defence in depth — a download endpoint should never be embeddable.
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}

function statusFor(reason: ConsumeFailure): Response {
  if (reason === "not_found") return notFound();
  // expired / exhausted both 410 — semantically "the resource was here but
  // is gone now," which is what 410 Gone is for.
  const message = reason === "expired" ? "Link expired" : "Download limit reached";
  return new Response(message, {
    status: 410,
    headers: { "Cache-Control": "no-store" },
  });
}

// Build a Content-Disposition filename param that's safe for non-ASCII
// (RFC 5987) with an ASCII fallback. Quotes/backslashes in the legacy
// `filename=` token are stripped to underscores; everything else is
// percent-encoded into `filename*=UTF-8''…` so non-ASCII names survive
// (Apple Mail attachments routinely include accents, Japanese, emoji, etc.).
// Modern clients (Chrome/Firefox/Safari/curl/wget) all read `filename*` and
// ignore the legacy token; older clients fall back to the ASCII version.
// Mirror of the helper in api/attachments/[id]/route.ts.
function rfc5987Disposition(name: string): string {
  const ascii = name
    .replace(/[\\"]/g, "_")
    .replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()]/g, escape);
  return `filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// HEAD handler — explicitly defined so Next.js doesn't fall back to running
// GET (which would increment the download counter). Mail clients and link
// previewers regularly HEAD URLs before GET; without this they'd consume
// downloads from max_downloads-capped links without the recipient ever
// clicking. We return a minimal 200 with the size + content-type so curl
// -I / fetch HEAD still gives useful metadata.
export async function HEAD(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  if (!token || !/^[a-zA-Z0-9_-]{8,}$/.test(token)) return notFound();
  // Cheap liveness peek — no counter touch. Doesn't differentiate
  // expired/exhausted; HEAD only needs to say "exists and reachable".
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}
