// Cloudflare Turnstile verification for the public booking form (#109).
//
// Optional: if TURNSTILE_SECRET_KEY is not configured, verifyTurnstile()
// returns true so the booking flow works before Turnstile is provisioned.
// Once TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY are set, the public form
// renders the widget and the create-booking route enforces it.

import { getEnv } from "./db";

const VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function turnstileSiteKey(): string | null {
  const env = getEnv() as unknown as { TURNSTILE_SITE_KEY?: string };
  return env.TURNSTILE_SITE_KEY ?? null;
}

export async function verifyTurnstile(
  token: string | undefined | null,
  ip: string | null,
): Promise<boolean> {
  const env = getEnv() as unknown as { TURNSTILE_SECRET_KEY?: string };
  if (!env.TURNSTILE_SECRET_KEY) return true; // not configured — skip
  if (!token) return false;
  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        ...(ip ? { remoteip: ip } : {}),
      }),
    });
    if (!res.ok) return false;
    const j = (await res.json()) as { success?: boolean };
    return j.success === true;
  } catch {
    return false;
  }
}
