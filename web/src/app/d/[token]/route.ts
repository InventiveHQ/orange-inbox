import { NextRequest } from "next/server";

// Legacy /d/<token> download endpoint for Mail Drop. Mail Drop migrated to
// presigned R2 URLs (recipients hit R2 directly with no Worker in the loop),
// so this route's lookup table is gone and the route exists only to:
//   1. Return a clean 410 Gone for any old token URLs still circulating in
//      previously-sent email bodies.
//   2. Keep the path bound so 404 handlers don't try to interpret it as
//      something else.
// Tokens issued before the migration are unrecoverable — recipients who
// click them get a "Link expired" page.
//
// RATE LIMITING — best effort, per-Worker-instance. Same per-IP token bucket
// as the original route to blunt drive-by enumeration.

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

  // Mail Drop now signs R2 URLs at send time; the lookup table this route
  // used to consult is gone. Any token landing here is from a pre-migration
  // send and unrecoverable.
  return new Response("Link expired — this attachment was sent under an older system and is no longer available.", {
    status: 410,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
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
