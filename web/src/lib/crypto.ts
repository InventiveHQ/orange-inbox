// AES-256-GCM encryption for secrets at rest — Google OAuth tokens stored in
// calendar_connections (orange-inbox#108). The key is derived from the
// existing INTERNAL_SECRET worker secret via SHA-256, so no additional secret
// needs provisioning. (The meeting-scheduler prototype used base64 and called
// it "encryption" — this is the real thing.)

import { getEnv } from "./db";

function secret(): string {
  const env = getEnv() as unknown as { INTERNAL_SECRET?: string };
  const s = env.INTERNAL_SECRET;
  if (!s) throw new Error("INTERNAL_SECRET is not configured");
  return s;
}

async function aesKey(): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret()),
  );
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Encrypt → base64( iv[12] || ciphertext+tag ).
export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await aesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const ctBytes = new Uint8Array(ct);
  const packed = new Uint8Array(iv.length + ctBytes.length);
  packed.set(iv, 0);
  packed.set(ctBytes, iv.length);
  return toBase64(packed);
}

export async function decryptSecret(encoded: string): Promise<string> {
  const key = await aesKey();
  const packed = fromBase64(encoded);
  const iv = packed.slice(0, 12);
  const ct = packed.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// URL-safe, unguessable token — reschedule/cancel links and OAuth state.
export function randomToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return toBase64(raw)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
