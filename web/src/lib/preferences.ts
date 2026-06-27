import { getDb } from "./db";

// Theme override the user has explicitly chosen. "system" defers to the OS
// preference (the default), "light" / "dark" pin the UI regardless.
export type Theme = "light" | "dark" | "system";

// Row spacing preset for the thread list (issue #35). "comfortable" matches the
// pre-existing layout, "cozy" tightens vertical rhythm, "compact" is denser
// still for power users / large inboxes.
export type Density = "comfortable" | "cozy" | "compact";

export interface UserPreferences {
  theme: Theme;
  accent_hex: string;
  density: Density;
  // 0033: default state for the composer's "Track opens" toggle. When 1, new
  // compose modals start with the toggle on. The toggle itself still lives
  // per-message — the user can override either way before hitting Send.
  default_track_opens: boolean;
  // 0055: opt-in auto-archive of the marketing/no-action lane. When true, new
  // inbound threads classified (marketing & !action) for mailboxes this user
  // owns are filed straight to archived on ingest (email-worker reads this).
  auto_archive_marketing: boolean;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: "system",
  accent_hex: "#f97316",
  density: "comfortable",
  default_track_opens: false,
  auto_archive_marketing: false,
};

interface PreferencesRow {
  theme: string;
  accent_hex: string;
  density: string | null;
  default_track_opens: number | null;
  auto_archive_marketing: number | null;
}

// Returns defaults if no row exists for the user yet — the table is sparsely
// populated (only users who've changed defaults get a row).
export async function getUserPreferences(userId: string): Promise<UserPreferences> {
  const row = await getDb()
    .prepare(
      "SELECT theme, accent_hex, density, default_track_opens, auto_archive_marketing FROM user_preferences WHERE user_id = ?",
    )
    .bind(userId)
    .first<PreferencesRow>();
  if (!row) return DEFAULT_PREFERENCES;
  return {
    theme: normaliseTheme(row.theme),
    accent_hex: normaliseHex(row.accent_hex) ?? DEFAULT_PREFERENCES.accent_hex,
    density: normaliseDensity(row.density),
    default_track_opens: row.default_track_opens === 1,
    auto_archive_marketing: row.auto_archive_marketing === 1,
  };
}

export interface PreferencesPatch {
  theme?: Theme;
  accent_hex?: string;
  density?: Density;
  default_track_opens?: boolean;
  auto_archive_marketing?: boolean;
}

// Upsert-shaped: merge the patch over current values, then INSERT or UPDATE.
// Validation lives here too — callers can hand us untrusted input as long as
// they care about the boolean return for "rejected".
export async function updateUserPreferences(
  userId: string,
  patch: PreferencesPatch,
): Promise<UserPreferences | null> {
  const next: UserPreferences = { ...(await getUserPreferences(userId)) };
  if (patch.theme !== undefined) {
    if (!isTheme(patch.theme)) return null;
    next.theme = patch.theme;
  }
  if (patch.accent_hex !== undefined) {
    const hex = normaliseHex(patch.accent_hex);
    if (!hex) return null;
    next.accent_hex = hex;
  }
  if (patch.density !== undefined) {
    if (!isDensity(patch.density)) return null;
    next.density = patch.density;
  }
  if (patch.default_track_opens !== undefined) {
    if (typeof patch.default_track_opens !== "boolean") return null;
    next.default_track_opens = patch.default_track_opens;
  }
  if (patch.auto_archive_marketing !== undefined) {
    if (typeof patch.auto_archive_marketing !== "boolean") return null;
    next.auto_archive_marketing = patch.auto_archive_marketing;
  }

  await getDb()
    .prepare(
      `INSERT INTO user_preferences (user_id, theme, accent_hex, density, default_track_opens, auto_archive_marketing, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(user_id) DO UPDATE SET
         theme = excluded.theme,
         accent_hex = excluded.accent_hex,
         density = excluded.density,
         default_track_opens = excluded.default_track_opens,
         auto_archive_marketing = excluded.auto_archive_marketing,
         updated_at = excluded.updated_at`,
    )
    .bind(
      userId,
      next.theme,
      next.accent_hex,
      next.density,
      next.default_track_opens ? 1 : 0,
      next.auto_archive_marketing ? 1 : 0,
    )
    .run();
  return next;
}

function isTheme(v: unknown): v is Theme {
  return v === "light" || v === "dark" || v === "system";
}

function normaliseTheme(v: string): Theme {
  return isTheme(v) ? v : "system";
}

function isDensity(v: unknown): v is Density {
  return v === "comfortable" || v === "cozy" || v === "compact";
}

function normaliseDensity(v: string | null | undefined): Density {
  return isDensity(v) ? v : "comfortable";
}

// Update the week-start preference (#87). Lives on `users` rather than
// `user_preferences` because the migration that added it (0046) is on the
// users table — that keeps the column queryable alongside the identity row
// in `getCurrentUser`, which the calendar grids already get on first paint.
//
// Only 0 (Sunday) and 1 (Monday) are accepted today; other ints are
// reserved for Saturday-first locales but unused.
export async function updateWeekStartDay(
  userId: string,
  value: number,
): Promise<boolean> {
  if (value !== 0 && value !== 1) return false;
  await getDb()
    .prepare("UPDATE users SET week_start_day = ? WHERE id = ?")
    .bind(value, userId)
    .run();
  return true;
}

// Accept #rgb or #rrggbb (case-insensitive); always store the lowercase
// 6-digit form so cookies and inline styles compare cleanly.
function normaliseHex(v: string): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim().toLowerCase();
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(trimmed);
  if (m3) {
    return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
  }
  if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;
  return null;
}

// Cookie consumed by the root layout for SSR no-flash. Stored as JSON so we
// can extend the prefs payload (e.g. density) without revving the cookie name.
export const PREFS_COOKIE = "orange-prefs";

export function encodePreferencesCookie(p: UserPreferences): string {
  return JSON.stringify({ theme: p.theme, accent_hex: p.accent_hex, density: p.density });
}

export function decodePreferencesCookie(raw: string | undefined): UserPreferences | null {
  if (!raw) return null;
  try {
    // The client writes the cookie URL-encoded so JSON quotes survive
    // round-tripping through `Set-Cookie`. Tolerate both forms — Next's
    // `cookies().get()` may or may not have decoded depending on the runtime.
    let decoded = raw;
    if (raw.includes("%")) {
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        decoded = raw;
      }
    }
    const j = JSON.parse(decoded) as Partial<UserPreferences>;
    const theme = isTheme(j.theme) ? j.theme : null;
    const accent = typeof j.accent_hex === "string" ? normaliseHex(j.accent_hex) : null;
    if (!theme || !accent) return null;
    // Density was introduced after theme/accent — tolerate cookies written by
    // older clients by falling back to the comfortable default instead of
    // discarding the whole cookie (which would force a flash to system theme).
    const density = isDensity(j.density) ? j.density : DEFAULT_PREFERENCES.density;
    return {
      theme,
      accent_hex: accent,
      density,
      // Cookie only carries theme + accent + density (SSR no-flash chrome);
      // track-opens and auto-archive defaults aren't needed for first paint —
      // the composer / settings fetch them from /api/me/preferences.
      default_track_opens: DEFAULT_PREFERENCES.default_track_opens,
      auto_archive_marketing: DEFAULT_PREFERENCES.auto_archive_marketing,
    };
  } catch {
    return null;
  }
}
