// One-shot VAPID keypair generator. Outputs base64url-encoded P-256 keys
// suitable for RFC 8292 (Web Push VAPID). Pipe the private key into
// `wrangler secret put VAPID_PRIVATE_KEY`; copy the public key into
// VAPID_PUBLIC_KEY in wrangler.jsonc vars.

import { webcrypto } from "node:crypto";

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const kp = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);

// Public: 65-byte uncompressed P-256 point (0x04 || X || Y).
const pubRaw = new Uint8Array(await webcrypto.subtle.exportKey("raw", kp.publicKey));
// Private: PKCS#8, but we want the raw 32-byte d for portability. JWK gives us d.
const privJwk = await webcrypto.subtle.exportKey("jwk", kp.privateKey);
const privRaw = Buffer.from(privJwk.d, "base64url"); // 32 bytes

console.log("VAPID_PUBLIC_KEY=" + b64url(pubRaw));
console.log("VAPID_PRIVATE_KEY=" + b64url(privRaw));
console.log();
console.log("# Apply:");
console.log("#   1. Put VAPID_PUBLIC_KEY into web/wrangler.jsonc vars");
console.log("#   2. echo -n '<value>' | (cd web && npx wrangler secret put VAPID_PRIVATE_KEY)");
