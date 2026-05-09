// Self-contained Web Push implementation that runs on Cloudflare Workers
// (no Node 'crypto' module — only crypto.subtle). Implements:
//
//   • RFC 8291 — Message encryption for Web Push (aes128gcm content encoding)
//   • RFC 8292 — VAPID (single-header form: `Authorization: vapid t=<jwt>, k=<pub>`)
//   • RFC 8188 — aes128gcm framing (header = salt | rs | idlen | keyid | ct)
//
// Used by /api/internal/notify-new-message to deliver a push payload to a
// subscription endpoint.

export interface PushSubscription {
  endpoint: string;
  p256dh: string; // base64url, 65-byte uncompressed P-256 point (0x04 || X || Y)
  auth_secret: string; // base64url, 16 bytes
}

export interface VapidConfig {
  publicKey: string; // base64url, 65 bytes
  privateKey: string; // base64url, 32 bytes (raw scalar d)
  subject: string; // mailto: or https: URL
}

const RECORD_SIZE = 4096;
const TEXT = new TextEncoder();

// ─── base64url ──────────────────────────────────────────────────────────────

export function b64uEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ─── HKDF ───────────────────────────────────────────────────────────────────

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

// ─── Payload encryption (RFC 8291) ──────────────────────────────────────────

export async function encryptPayload(
  payload: Uint8Array,
  uaPublicKey: string,
  authSecret: string,
): Promise<Uint8Array> {
  const uaPub = b64uDecode(uaPublicKey);
  const auth = b64uDecode(authSecret);
  if (uaPub.length !== 65 || uaPub[0] !== 0x04) throw new Error("invalid p256dh");

  // Ephemeral ECDH keypair for this message.
  const asKp = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", asKp.publicKey));

  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPub as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKp.privateKey, 256),
  );

  // PRK + IKM (RFC 8291 §3.3)
  const keyInfo = concat(TEXT.encode("WebPush: info\0"), uaPub, asPub);
  const ikm = await hkdf(auth, ecdhSecret, keyInfo, 32);

  // Per-message random salt → CEK + NONCE
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, TEXT.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, TEXT.encode("Content-Encoding: nonce\0"), 12);

  // Plaintext = payload || 0x02 (last-record delimiter)
  const plaintext = new Uint8Array(payload.length + 1);
  plaintext.set(payload);
  plaintext[payload.length] = 0x02;

  const aesKey = await crypto.subtle.importKey(
    "raw",
    cek as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      aesKey,
      plaintext as BufferSource,
    ),
  );

  // Header (RFC 8188 aes128gcm)
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  // rs (4-byte big-endian)
  header[16] = (RECORD_SIZE >>> 24) & 0xff;
  header[17] = (RECORD_SIZE >>> 16) & 0xff;
  header[18] = (RECORD_SIZE >>> 8) & 0xff;
  header[19] = RECORD_SIZE & 0xff;
  header[20] = 65; // idlen
  header.set(asPub, 21);

  return concat(header, ciphertext);
}

// ─── VAPID JWT (RFC 8292) ───────────────────────────────────────────────────

export async function signVapid(
  endpoint: string,
  config: VapidConfig,
  expirySeconds = 12 * 60 * 60,
): Promise<{ Authorization: string }> {
  const url = new URL(endpoint);
  const aud = `${url.protocol}//${url.host}`;
  const exp = Math.floor(Date.now() / 1000) + expirySeconds;

  const headerJson = JSON.stringify({ typ: "JWT", alg: "ES256" });
  const claimsJson = JSON.stringify({ aud, exp, sub: config.subject });
  const signingInput = `${b64uEncode(TEXT.encode(headerJson))}.${b64uEncode(TEXT.encode(claimsJson))}`;

  const jwk = vapidJwk(config.privateKey, config.publicKey);
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      TEXT.encode(signingInput) as BufferSource,
    ),
  );

  const jwt = `${signingInput}.${b64uEncode(sig)}`;
  return { Authorization: `vapid t=${jwt}, k=${config.publicKey}` };
}

function vapidJwk(privateKey: string, publicKey: string): JsonWebKey {
  const pub = b64uDecode(publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error("invalid VAPID public key");
  return {
    kty: "EC",
    crv: "P-256",
    x: b64uEncode(pub.slice(1, 33)),
    y: b64uEncode(pub.slice(33, 65)),
    d: privateKey,
    ext: true,
  };
}

// ─── one-shot send ──────────────────────────────────────────────────────────

export async function sendPush(
  sub: PushSubscription,
  payload: object | Uint8Array,
  vapid: VapidConfig,
  ttlSeconds = 60 * 60 * 24,
): Promise<Response> {
  const body =
    payload instanceof Uint8Array ? payload : TEXT.encode(JSON.stringify(payload));
  const ciphertext = await encryptPayload(body, sub.p256dh, sub.auth_secret);
  const auth = await signVapid(sub.endpoint, vapid);
  return fetch(sub.endpoint, {
    method: "POST",
    headers: {
      ...auth,
      "content-type": "application/octet-stream",
      "content-encoding": "aes128gcm",
      ttl: String(ttlSeconds),
    },
    body: ciphertext as BodyInit,
  });
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
