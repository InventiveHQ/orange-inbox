import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// Public read-receipt pixel (#69). The outbound HTML body contains
//   <img src="https://<host>/p/api/track/<token>.png" ... />
// so the {token} param arrives with a ".png" suffix; we strip it before
// looking up the message. No requireUser — recipients are by definition
// unauthenticated against our control plane. The token is per-message and
// minted at send time; possession of it is harmless beyond pinging the
// counter.
//
// Side-effect on GET:
//   1. Find the message that owns this tracking_token by fanning across
//      active mail DBs (the column lives on the messages table, which is
//      sharded across mail DBs).
//   2. Insert a row into message_read_events in the control DB. We hash
//      the UA + IP with SHA-256 + a per-message salt (the token itself) so
//      we can dedupe back-to-back opens from the same client without
//      retaining raw PII on disk.
//   3. Return a 43-byte 1x1 transparent PNG with Cache-Control: no-store so
//      every open re-fires (mail clients aggressively cache image bodies).
//
// We never 404 on an unknown token — bots scraping the URL shouldn't get a
// hint that "this token was real and got deleted". A miss returns the same
// PNG and silently swallows the event.

// 43-byte 1x1 transparent PNG. Hand-rolled from the canonical bytes:
//   header (8) + IHDR (25) + IDAT (16) + IEND (12) — wait the real minimum
// is actually 67. Use the well-known 67-byte form. Pre-computed once at
// module load so we don't allocate per-request.
const PIXEL: Uint8Array = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR length + type
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, // bit depth 8, color RGBA, CRC
  0x89,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, // IDAT length + type
  0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, // zlib-deflated 1px RGBA(0,0,0,0)
  0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, // IEND
  0xae, 0x42, 0x60, 0x82,
]);

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    ""
  );
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

async function findMessageByToken(token: string): Promise<{ messageId: string } | null> {
  // Token lookup fans across mail DBs — same shape as loadReplyParent in
  // send.ts. Each query is a single-row index miss in the no-token case,
  // so this is cheap.
  const { getActiveMailDbs } = await import("@/lib/mail-db");
  const dbs = await getActiveMailDbs();
  for (const { db } of dbs) {
    const row = await db
      .prepare(`SELECT id FROM messages WHERE tracking_token = ? LIMIT 1`)
      .bind(token)
      .first<{ id: string }>();
    if (row) return { messageId: row.id };
  }
  return null;
}

const PIXEL_HEADERS = {
  "Content-Type": "image/png",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  // Don't leak a referer header to next-hop — mail clients usually omit
  // anyway but be explicit.
  "Referrer-Policy": "no-referrer",
} as const;

function pixelResponse(): Response {
  // Always return 200 with the PNG body, even on miss. Some mail clients
  // treat 4xx as "image failed to load" and surface a broken-image icon to
  // the recipient — which would tip them off that this is a tracker.
  // Use the underlying ArrayBuffer so BodyInit gets a value its TS overload
  // accepts in the Workers / Next 16 typings.
  return new Response(PIXEL.buffer.slice(PIXEL.byteOffset, PIXEL.byteOffset + PIXEL.byteLength) as ArrayBuffer, {
    status: 200,
    headers: PIXEL_HEADERS,
  });
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token: rawToken } = await ctx.params;
  // The URL we inject ends in ".png" so clients (and image proxies) treat it
  // as an image. Strip the suffix before the DB lookup. Accept bare tokens
  // too for hand-testing.
  const token = rawToken.endsWith(".png") ? rawToken.slice(0, -4) : rawToken;
  if (!token || !/^[A-Za-z0-9_-]{8,}$/.test(token)) {
    return pixelResponse();
  }

  // Resolve message + record the open. Wrapped in a try because nothing
  // about the recipient's reading experience should depend on the DB write
  // succeeding — they get the pixel either way.
  try {
    const hit = await findMessageByToken(token);
    if (hit) {
      const ip = clientIp(req);
      const ua = req.headers.get("user-agent") ?? "";
      const ipHash = ip ? (await sha256Hex(`${token}:ip:${ip}`)).slice(0, 32) : "";
      const uaHash = ua ? (await sha256Hex(`${token}:ua:${ua}`)).slice(0, 32) : null;
      const openedAt = Math.floor(Date.now() / 1000);
      // PK is (message_id, opened_at, ip_hash). A burst of opens with the
      // same hash inside one second is treated as one event (which is what
      // we want — image proxies often fan out parallel fetches).
      await getDb()
        .prepare(
          `INSERT OR IGNORE INTO message_read_events (message_id, opened_at, ua_hash, ip_hash)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(hit.messageId, openedAt, uaHash, ipHash || `anon-${openedAt}`)
        .run();
    }
  } catch (err) {
    console.error("read-track ingest failed", err);
  }

  return pixelResponse();
}
