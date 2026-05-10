import { getDb } from "./db";
import type { CalendarEventRow } from "./calendar";

// Per-user ICS subscription tokens (#83).
//
// The token is opaque, URL-safe, and the only auth on the token-gated feed at
// `/api/calendar/ics/<token>`. The settings UI surfaces:
//
//   * The current (active) token, lazily minted on first view.
//   * A `Last used` timestamp, updated by the feed handler on each hit.
//   * A "Rotate token" action that revokes the current token and mints a
//     fresh one.
//
// We keep revoked rows around (revoked_at IS NOT NULL) for audit. Lookups go
// through getActiveTokenRow which filters them out.

export interface IcsTokenRow {
  token: string;
  user_id: string;
  scope: string;          // 'all' or a mailbox id (v1 only writes 'all')
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

// Token shape: 32 bytes of randomness encoded as 64-char hex. Hex avoids the
// `+`/`/`/`=` characters that some calendar clients mangle when constructing
// the webcal URL.
function mintTokenString(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// The active token for a user, if any. "Active" = revoked_at IS NULL. There
// SHOULD be at most one (rotation revokes the old before minting), but the
// query orders by created_at DESC defensively in case a race ever produced
// two — we'd prefer the newer one.
export async function getActiveTokenForUser(
  userId: string,
): Promise<IcsTokenRow | null> {
  const row = await getDb()
    .prepare(
      `SELECT * FROM user_ics_tokens
        WHERE user_id = ? AND revoked_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .bind(userId)
    .first<IcsTokenRow>();
  return row ?? null;
}

// Used by the feed handler to authenticate the request. Returns the row only
// when the token is active (not revoked). Doesn't update last_used_at — that
// happens via touchTokenUsed AFTER we've decided to serve the feed.
export async function getActiveTokenRow(
  token: string,
): Promise<IcsTokenRow | null> {
  if (!token || token.length < 16) return null;
  const row = await getDb()
    .prepare(
      `SELECT * FROM user_ics_tokens
        WHERE token = ? AND revoked_at IS NULL`,
    )
    .bind(token)
    .first<IcsTokenRow>();
  return row ?? null;
}

// Bump last_used_at. Best-effort — we don't surface failures to the caller
// because a Google poll shouldn't 500 just because the audit timestamp didn't
// update.
export async function touchTokenUsed(token: string): Promise<void> {
  try {
    await getDb()
      .prepare(
        `UPDATE user_ics_tokens
            SET last_used_at = unixepoch()
          WHERE token = ?`,
      )
      .bind(token)
      .run();
  } catch (e) {
    console.warn("touchTokenUsed failed", e);
  }
}

// Mint a token for the user. Caller decides whether to revoke any existing
// tokens first (the rotate flow does; the lazy-mint-on-first-view flow does
// not — it's a no-op when one already exists).
export async function mintTokenForUser(
  userId: string,
  scope: string = "all",
): Promise<IcsTokenRow> {
  const token = mintTokenString();
  await getDb()
    .prepare(
      `INSERT INTO user_ics_tokens (token, user_id, scope)
       VALUES (?, ?, ?)`,
    )
    .bind(token, userId, scope)
    .run();
  // Read the row back so callers get the server-generated created_at.
  const row = await getDb()
    .prepare(`SELECT * FROM user_ics_tokens WHERE token = ?`)
    .bind(token)
    .first<IcsTokenRow>();
  if (!row) {
    // Should never happen — we just inserted. If it does, surface clearly
    // rather than returning a synthesised row that might confuse the caller.
    throw new Error("ics token disappeared after insert");
  }
  return row;
}

// Lazy-mint variant: returns the active token if there is one, else mints a
// fresh one. Used by the settings UI on first view.
export async function ensureTokenForUser(
  userId: string,
): Promise<IcsTokenRow> {
  const existing = await getActiveTokenForUser(userId);
  if (existing) return existing;
  return mintTokenForUser(userId);
}

// Revoke a single token, scoped to the caller's user_id so a leaked token
// can't be revoked by a malicious third party. Returns true when a row was
// actually flipped (callers can use this to distinguish "already revoked"
// from "wrong user").
export async function revokeToken(
  userId: string,
  token: string,
): Promise<boolean> {
  const res = await getDb()
    .prepare(
      `UPDATE user_ics_tokens
          SET revoked_at = unixepoch()
        WHERE token = ? AND user_id = ? AND revoked_at IS NULL`,
    )
    .bind(token, userId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// Rotate: revoke the user's current active token (if any) and mint a fresh
// one. Two writes rather than a transaction because D1 doesn't expose them
// at the JS layer; the worst case is a brief overlap where both work, which
// is fine — rotation is for "I think the URL leaked", not "the URL is
// compromised right now".
export async function rotateTokenForUser(
  userId: string,
): Promise<IcsTokenRow> {
  const current = await getActiveTokenForUser(userId);
  if (current) {
    await revokeToken(userId, current.token);
  }
  return mintTokenForUser(userId);
}

// Calendar feed reader. Pulls every visible (not user-hidden) event for a
// user, with the most recent updated_at returned alongside so the route
// handler can drive ETag / Last-Modified.
//
// #78 (parallel work) introduces user_calendar_prefs.hidden — a per-user
// per-mailbox visibility flag. We DON'T currently have that table because
// our worktree branched before #78, but we want this query to gracefully
// pick up the filter once #78 lands. The plan:
//
//   * For now, return every event row.
//   * When #78 ships its migration, add a LEFT JOIN against user_calendar_prefs
//     here and filter `hidden = 0` (treat missing rows as visible).
//
// We don't try to detect the table at runtime because (a) D1's PRAGMA path
// is awkward and (b) the migration order is deterministic — once #78 is
// merged this file gets a follow-up commit. Comment is the contract.
export async function listEventsForFeed(
  userId: string,
): Promise<{ rows: CalendarEventRow[]; lastModified: number }> {
  const { results } = await getDb()
    .prepare(
      `SELECT * FROM calendar_events
        WHERE user_id = ?
        ORDER BY starts_at ASC`,
    )
    .bind(userId)
    .all<CalendarEventRow>();
  const rows = results ?? [];
  let lastModified = 0;
  for (const r of rows) {
    if (r.updated_at && r.updated_at > lastModified) lastModified = r.updated_at;
  }
  return { rows, lastModified };
}
