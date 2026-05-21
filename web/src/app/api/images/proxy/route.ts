import { NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";

// Caps for hardening the proxy:
//  - 5 MB max image (most legitimate inline images are well under this; the
//    cap avoids an attacker turning the proxy into bandwidth amplification).
//  - 10s upstream timeout — emails sometimes reference images on slow CDNs,
//    but anything past this is more likely to be a tarpit than a real asset.
const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
// Tracking pixels are typically a 1x1 transparent GIF/PNG; we also flag any
// response under this threshold as a likely tracker (real images carry
// more metadata than this even when heavily compressed).
const TRACKER_BYTE_THRESHOLD = 200;

// Strict allowlist of raster image MIME types we are willing to relay.
// Deliberately excludes image/svg+xml: an SVG is an XML document that can
// embed <script>, and since the proxy serves bytes from the app's own
// origin, a top-level-loaded malicious SVG would execute script as us.
const ALLOWED_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

// GET /api/images/proxy?url=<encoded http(s) url>
//
// Authenticated image relay used to render <img src="http://..."> in email
// HTML without leaking the user's IP/Referer/cookies to the original host.
// Stripped tracker pixels short-circuit to a 204 with X-Tracker-Blocked: 1
// so the iframe gets a transparent no-op instead of a broken image icon.
//
// Hardening:
//  - SSRF: the URL must be http/https and resolve to a non-private hostname.
//    We reject hostnames in private/loopback/link-local IP space, .localhost,
//    and IPv6 ULA / link-local ranges. (Cloudflare's runtime fetch also
//    blocks Worker→localhost out of the box, but defence in depth.)
//  - Body cap: pre-check Content-Length, then a streaming byte counter so a
//    server lying about Content-Length still gets cut off at MAX_BYTES.
//  - No cookies / Referer / Origin forwarded; we set our own UA.
//  - Response is image/* only, with COEP-friendly cross-origin headers so the
//    sandboxed email iframe can render it.
export async function GET(req: Request) {
  try {
    await requireUser();
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  const reqUrl = new URL(req.url);
  const target = reqUrl.searchParams.get("url");
  if (!target) {
    return NextResponse.json({ error: "missing_url" }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return NextResponse.json({ error: "unsupported_scheme" }, { status: 400 });
  }
  if (isBlockedHost(parsed.hostname)) {
    return NextResponse.json({ error: "blocked_host" }, { status: 400 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(parsed.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      // Strip identifying headers so the upstream tracker can't fingerprint
      // the recipient. We pass a generic UA so misconfigured CDNs that 403
      // empty UAs still serve us.
      headers: {
        "User-Agent": "orange-inbox image proxy",
        Accept: "image/*",
      },
      // Cloudflare-only hint: cache the upstream response at the edge so
      // repeated views of the same email don't refetch.
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return NextResponse.json(
      { error: aborted ? "upstream_timeout" : "upstream_failed" },
      { status: 502 },
    );
  }
  clearTimeout(timer);

  if (!upstream.ok) {
    return NextResponse.json(
      { error: "upstream_status", status: upstream.status },
      { status: 502 },
    );
  }

  // Normalise the upstream content type: lowercase, strip any `;`-parameter
  // suffix (e.g. "image/jpeg; charset=..."), and trim whitespace before
  // checking it against the raster allowlist.
  const contentType = (upstream.headers.get("content-type") || "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return NextResponse.json({ error: "not_an_image" }, { status: 415 });
  }

  // Pre-check Content-Length before we start streaming so we can fail fast
  // on obvious oversize responses.
  const declaredLen = upstream.headers.get("content-length");
  if (declaredLen) {
    const n = Number(declaredLen);
    if (Number.isFinite(n) && n > MAX_BYTES) {
      return NextResponse.json({ error: "too_large" }, { status: 413 });
    }
  }

  // We need the bytes to (a) enforce the byte cap regardless of any header
  // lies and (b) sniff for tracker pixels. Buffering is fine here because
  // we already capped at 5 MB.
  const bytes = await readCappedBody(upstream, MAX_BYTES);
  if (bytes === null) {
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  }

  if (isTrackingPixel(bytes, contentType)) {
    return new Response(null, {
      status: 204,
      headers: {
        "X-Tracker-Blocked": "1",
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  }

  // Workers/DOM lib disagreement: Uint8Array<ArrayBufferLike> isn't accepted
  // as BodyInit, but a Blob is. Wrap the bytes in a Blob so the Response
  // constructor is happy under either set of types.
  const body = new Blob([bytes as BlobPart], { type: contentType });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "public, max-age=86400, immutable",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      // Defence in depth: even though the allowlist already excludes SVG,
      // neuter any script/active content if a proxied byte stream is ever
      // loaded as a top-level document, and force the browser to render
      // (not download) the asset.
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
    },
  });
}

// Streams the response body into a single Uint8Array, aborting if it grows
// past `cap` bytes. Returns null on overrun. Used in lieu of arrayBuffer()
// because arrayBuffer() will happily allocate a multi-GB body.
async function readCappedBody(res: Response, cap: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// Reject hostnames pointing at internal infrastructure. We don't do DNS
// resolution here (Workers doesn't expose a resolver anyway) — but we block
// the textual forms an attacker would actually use to point at private
// space, plus literal IPv4/IPv6 in those ranges.
function isBlockedHost(rawHost: string): boolean {
  // Trim trailing dot, brackets on IPv6 literals.
  let host = rawHost.trim().toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) return true;

  if (host === "localhost" || host.endsWith(".localhost")) return true;

  // IPv4 literal?
  const v4 = parseIPv4(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return true;            // 127.0.0.0/8 loopback
    if (a === 10) return true;             // 10.0.0.0/8 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a >= 224) return true;             // 224.0.0.0/4 multicast + reserved
    if (a === 0) return true;              // 0.0.0.0/8 "this network"
    return false;
  }

  // IPv6 literal? Block loopback, ULA (fc00::/7), link-local (fe80::/10),
  // unspecified, and IPv4-mapped forms that point at private space.
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true;
    // fc00::/7 — first byte 0xFC or 0xFD
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
    // fe80::/10 — first 10 bits are 1111 1110 10
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
    // IPv4-mapped: ::ffff:a.b.c.d — recurse on the embedded v4.
    const mapped = host.match(/^::ffff:([0-9.]+)$/);
    if (mapped) return isBlockedHost(mapped[1]);
    return false;
  }

  return false;
}

function parseIPv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (!Number.isFinite(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return [nums[0], nums[1], nums[2], nums[3]];
}

// Heuristic: tiny payloads or 1x1 GIF/PNG → tracking pixel. Reading magic
// bytes saves us from depending on a decoder while still catching the
// formats trackers actually use in practice.
function isTrackingPixel(bytes: Uint8Array, contentType: string): boolean {
  if (bytes.byteLength < TRACKER_BYTE_THRESHOLD) return true;
  const dim = readImageDimensions(bytes, contentType);
  if (dim && dim.width <= 1 && dim.height <= 1) return true;
  return false;
}

// Pull dimensions out of GIF / PNG headers without a decoder. Other formats
// are conservatively assumed to be real images (a 1x1 JPEG is rare in the
// wild and the byte-count fallback already catches them).
function readImageDimensions(
  bytes: Uint8Array,
  contentType: string,
): { width: number; height: number } | null {
  // GIF: "GIF87a" or "GIF89a", then little-endian width/height at offsets 6/8.
  if (
    contentType.includes("gif") &&
    bytes.byteLength >= 10 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
  ) {
    const w = bytes[6] | (bytes[7] << 8);
    const h = bytes[8] | (bytes[9] << 8);
    return { width: w, height: h };
  }
  // PNG: 8-byte signature, then a 4-byte length, "IHDR", then big-endian
  // width/height at offsets 16/20.
  if (
    contentType.includes("png") &&
    bytes.byteLength >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    const w =
      (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
    const h =
      (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
    return { width: w >>> 0, height: h >>> 0 };
  }
  return null;
}
