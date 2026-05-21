import { getDb } from "./db";
import { listMailboxesForUser } from "./queries";
import type { CalendarEventRow } from "./calendar";

// Per-user ICS subscription tokens (#83).
//
// The token is opaque, URL-safe, and the only auth on the token-gated feed at
// `/p/api/calendar/ics/<token>`. Every token carries a `scope`:
//
//   * 'all'        — combined feed: every calendar, honouring the user's
//                    per-calendar show/hide toggles.
//   * 'personal'   — just the Personal calendar (events with no mailbox).
//   * <mailbox_id> — just that mailbox's calendar.
//
// The Settings card runs in one of two modes, derived purely from which
// scopes have an active token: "single" (one 'all' token) or "per_mailbox"
// (one token per calendar). Switching modes revokes the old set and mints
// the new one — see /api/calendar/subscription.
//
// We keep revoked rows around (revoked_at IS NOT NULL) for audit. Lookups go
// through the get*Active* helpers, which filter them out.

// Reserved scope sentinels. A mailbox id is never expected to collide with
// these literals — the same assumption /api/calendar/calendars already makes
// when it uses "personal" as a calendar id.
export const ALL_SCOPE = "all";
export const PERSONAL_SCOPE = "personal";

export interface IcsTokenRow {
  token: string;
  user_id: string;
  scope: string; // 'all' | 'personal' | mailbox id
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

// Every active (non-revoked) token for a user, newest first.
export async function getActiveTokens(
  userId: string,
): Promise<IcsTokenRow[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT * FROM user_ics_tokens
        WHERE user_id = ? AND revoked_at IS NULL
        ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all<IcsTokenRow>();
  return results ?? [];
}

// The active token for one scope, if any. Rotation revokes the old before
// minting, so there SHOULD be at most one per scope — DESC + LIMIT 1 picks
// the newest defensively in case a race ever produced two.
export async function getActiveTokenByScope(
  userId: string,
  scope: string,
): Promise<IcsTokenRow | null> {
  const row = await getDb()
    .prepare(
      `SELECT * FROM user_ics_tokens
        WHERE user_id = ? AND scope = ? AND revoked_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .bind(userId, scope)
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

// Mint a token for the user at a given scope. Caller decides whether to
// revoke any existing token first (rotate does; the lazy-mint flow doesn't).
export async function mintTokenForUser(
  userId: string,
  scope: string,
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

// Lazy-mint variant: returns the active token for a scope if there is one,
// else mints a fresh one. Used by the settings UI on first view and to fill
// in a scope that gained a token-less calendar (e.g. a newly-added mailbox).
export async function ensureTokenForScope(
  userId: string,
  scope: string,
): Promise<IcsTokenRow> {
  const existing = await getActiveTokenByScope(userId, scope);
  if (existing) return existing;
  return mintTokenForUser(userId, scope);
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

// Revoke every active token for a user in one statement. Used when switching
// feed mode — the old subscription URLs must all stop working.
export async function revokeAllTokens(userId: string): Promise<void> {
  await getDb()
    .prepare(
      `UPDATE user_ics_tokens
          SET revoked_at = unixepoch()
        WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .bind(userId)
    .run();
}

// Rotate one scope: revoke its active token (if any) and mint a fresh one.
// Two writes rather than a transaction because D1 doesn't expose them at the
// JS layer; the worst case is a brief overlap where both work, which is fine
// — rotation is for "I think the URL leaked", not "it's compromised now".
export async function rotateTokenForScope(
  userId: string,
  scope: string,
): Promise<IcsTokenRow> {
  const current = await getActiveTokenByScope(userId, scope);
  if (current) {
    await revokeToken(userId, current.token);
  }
  return mintTokenForUser(userId, scope);
}

// The calendar scopes a per-mailbox feed set covers, in display order:
// Personal first, then one entry per mailbox the user can see.
export async function listFeedScopes(
  userId: string,
): Promise<{ scope: string; label: string }[]> {
  const mailboxes = await listMailboxesForUser(userId);
  return [
    { scope: PERSONAL_SCOPE, label: "Personal" },
    ...mailboxes.map((mb) => ({
      scope: mb.id,
      label: `${mb.local_part}@${mb.domain_name}`,
    })),
  ];
}

// Human-readable calendar name for a feed, written into the VCALENDAR so a
// subscriber pulling several per-mailbox feeds can tell them apart in their
// calendar app.
export async function feedCalendarName(
  userId: string,
  scope: string,
): Promise<string> {
  if (scope === ALL_SCOPE) return "Orange Inbox";
  if (scope === PERSONAL_SCOPE) return "Orange Inbox — Personal";
  const row = await getDb()
    .prepare(
      `SELECT mb.local_part, d.name AS domain_name
         FROM mailboxes mb
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = mb.id
         INNER JOIN domains d ON d.id = mb.domain_id
        WHERE mb.id = ? AND uma.user_id = ?`,
    )
    .bind(scope, userId)
    .first<{ local_part: string; domain_name: string }>();
  return row
    ? `Orange Inbox — ${row.local_part}@${row.domain_name}`
    : "Orange Inbox";
}

// Calendar feed reader — scope-aware.
//
//   'all'      → every event, honouring user_calendar_prefs.hidden (#78) so
//                the combined feed mirrors what's visible in the app. The
//                LEFT JOIN treats a missing pref row as visible; the COALESCE
//                handles the Personal calendar where mailbox_id is NULL on
//                both sides (SQL `=` against NULL is always NULL).
//   'personal' → events with mailbox_id IS NULL.
//   <mailbox>  → events for that mailbox. Scoped feeds intentionally ignore
//                the hidden flag — subscribing to one calendar is itself the
//                explicit choice, so the app's declutter toggle shouldn't
//                silently empty the feed.
//
// Returns the most recent updated_at alongside so the route handler can drive
// ETag / Last-Modified.
export async function listEventsForFeed(
  userId: string,
  scope: string,
): Promise<{ rows: CalendarEventRow[]; lastModified: number }> {
  const db = getDb();
  let stmt;
  if (scope === ALL_SCOPE) {
    stmt = db
      .prepare(
        `SELECT e.* FROM calendar_events e
           LEFT JOIN user_calendar_prefs p
             ON p.user_id = e.user_id
            AND COALESCE(p.mailbox_id, '') = COALESCE(e.mailbox_id, '')
          WHERE e.user_id = ?
            AND COALESCE(p.hidden, 0) = 0
          ORDER BY e.starts_at ASC`,
      )
      .bind(userId);
  } else if (scope === PERSONAL_SCOPE) {
    stmt = db
      .prepare(
        `SELECT * FROM calendar_events
          WHERE user_id = ? AND mailbox_id IS NULL
          ORDER BY starts_at ASC`,
      )
      .bind(userId);
  } else {
    stmt = db
      .prepare(
        `SELECT * FROM calendar_events
          WHERE user_id = ? AND mailbox_id = ?
          ORDER BY starts_at ASC`,
      )
      .bind(userId, scope);
  }
  const { results } = await stmt.all<CalendarEventRow>();
  const rows = results ?? [];
  let lastModified = 0;
  for (const r of rows) {
    if (r.updated_at && r.updated_at > lastModified) lastModified = r.updated_at;
  }
  return { rows, lastModified };
}
