import { getDb } from "./db";
import { seedDefaultReminder } from "./reminders";

// Native calendar — control-DB store of per-user events. Inbound invites
// land in `message_calendar_events` (mail-DB, populated by the email-worker
// at ingest). When the user opens a thread we promote those messages into
// rows here so the calendar grid and RSVP state are per-user.
//
// Promotion is lazy at thread-open: see promoteInvitesForThread. The unique
// partial index on (user_id, ical_uid) keeps it idempotent — if two requests
// race the second INSERT will collide on the index and be ignored via
// `ON CONFLICT DO NOTHING`.

export interface CalendarEventRow {
  id: string;
  user_id: string;
  // Per-mailbox attribution (#78). NULL means "Personal" — either a self
  // event the user didn't bind to a mailbox, or an invite that predates
  // the migration (see 0031_calendar_mailbox.sql for the backfill caveat).
  mailbox_id: string | null;
  ical_uid: string | null;
  source: "invite" | "self" | "imported";
  source_message_id: string | null;
  starts_at: number;
  ends_at: number | null;
  all_day: number;
  summary: string | null;
  location: string | null;
  description: string | null;
  organizer_email: string | null;
  rsvp_status: "NEEDS-ACTION" | "ACCEPTED" | "TENTATIVE" | "DECLINED" | null;
  rsvp_sent_at: number | null;
  cancelled: number;
  raw_ics: string | null;
  // Recurrence (#80). All three are RFC 5545 fragments stored verbatim:
  //   rrule  → the value of an RRULE: line (no prefix), e.g.
  //            "FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260101T000000Z".
  //   rdate  → comma-separated unix seconds; extra one-off instances.
  //   exdate → comma-separated unix seconds; instances to drop from the
  //            expansion. EXDATE wins over both RRULE and RDATE.
  // NULL on any of these is the natural "no recurrence" / "no extras" /
  // "no skips" default.
  rrule: string | null;
  rdate: string | null;
  exdate: string | null;
  // IANA zone (#82). NULL = "floating" / viewer-local. Display-only —
  // starts_at/ends_at remain UTC seconds.
  tz: string | null;
  created_at: number;
  updated_at: number;
}

// "personal" sentinel for the mailbox-filter API. mailbox_id IS NULL in the
// row but URLs / JSON pass the literal string "personal" so callers can
// distinguish "no filter" from "Personal calendar only".
export const PERSONAL_CALENDAR = "personal" as const;
export type CalendarFilter = string | typeof PERSONAL_CALENDAR | null;

// Single event by id, scoped to the caller. Returns null when the row doesn't
// exist or belongs to another user — same shape for "not found" and
// "forbidden" so callers don't leak the difference.
export async function getCalendarEvent(
  userId: string,
  id: string,
): Promise<CalendarEventRow | null> {
  const row = await getDb()
    .prepare(`SELECT * FROM calendar_events WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<CalendarEventRow>();
  return row ?? null;
}

// Lookup by (user_id, ical_uid). Used during promotion to dedupe — the
// caller can avoid an INSERT entirely when the row already exists.
export async function getCalendarEventByUid(
  userId: string,
  icalUid: string,
): Promise<CalendarEventRow | null> {
  const row = await getDb()
    .prepare(
      `SELECT * FROM calendar_events WHERE user_id = ? AND ical_uid = ?`,
    )
    .bind(userId, icalUid)
    .first<CalendarEventRow>();
  return row ?? null;
}

// Events that overlap [from, to). An event overlaps the window when its
// start is before `to` AND (its end is after `from` OR it has no end and
// its start is in-window). Bounded by the index on (user_id, starts_at) for
// the lower edge; we walk forward and let `ends_at` filter the trailing
// overlap. Cancelled rows are included — the UI renders them with
// strikethrough so the user keeps the audit trail.
//
// `filter` selects a single calendar:
//   - undefined         → consolidated view (all calendars the user can
//                         see, MINUS any they've hidden in user_calendar_prefs).
//   - "personal"        → mailbox_id IS NULL only.
//   - "<mailbox-id>"    → that mailbox's calendar only (no hidden filter —
//                         picking a specific calendar is an explicit show).
export async function listCalendarEvents(
  userId: string,
  from: number,
  to: number,
  filter?: CalendarFilter,
): Promise<CalendarEventRow[]> {
  const db = getDb();
  // Recurrence (#80): fetch any row whose master start sits at-or-before
  // the window upper bound AND that either has no recurrence rule (and
  // overlaps the window normally) OR has a rule (which we expand below).
  // Pulling rule rows whose master starts_at predates `from` is the whole
  // reason we don't lean on the simple "starts_at < to AND ends_at > from"
  // bound for the recurring branch — a weekly meeting that started in
  // 2020 still has occurrences this week.
  let rows: CalendarEventRow[];
  if (filter === PERSONAL_CALENDAR) {
    const { results } = await db
      .prepare(
        `SELECT * FROM calendar_events
          WHERE user_id = ?
            AND mailbox_id IS NULL
            AND starts_at < ?
            AND (
              rrule IS NOT NULL
              OR (ends_at IS NULL OR ends_at > ?)
            )
          ORDER BY starts_at ASC`,
      )
      .bind(userId, to, from)
      .all<CalendarEventRow>();
    rows = results ?? [];
  } else if (typeof filter === "string") {
    const { results } = await db
      .prepare(
        `SELECT * FROM calendar_events
          WHERE user_id = ?
            AND mailbox_id = ?
            AND starts_at < ?
            AND (
              rrule IS NOT NULL
              OR (ends_at IS NULL OR ends_at > ?)
            )
          ORDER BY starts_at ASC`,
      )
      .bind(userId, filter, to, from)
      .all<CalendarEventRow>();
    rows = results ?? [];
  } else {
    // Consolidated path: include every row in the window, then strip out
    // rows whose calendar is hidden in user_calendar_prefs. NULL mailbox_id
    // joins via `IS` so the Personal pref row applies cleanly.
    const { results } = await db
      .prepare(
        `SELECT ce.* FROM calendar_events ce
           LEFT JOIN user_calendar_prefs ucp
                  ON ucp.user_id = ce.user_id
                 AND ucp.mailbox_id IS ce.mailbox_id
          WHERE ce.user_id = ?
            AND ce.starts_at < ?
            AND (
              ce.rrule IS NOT NULL
              OR (ce.ends_at IS NULL OR ce.ends_at > ?)
            )
            AND COALESCE(ucp.hidden, 0) = 0
          ORDER BY ce.starts_at ASC`,
      )
      .bind(userId, to, from)
      .all<CalendarEventRow>();
    rows = results ?? [];
  }

  // Expand recurring rows in-window. Single-shot rows pass through
  // untouched so the consolidated/personal branches stay byte-identical
  // to the pre-#80 wire shape for every existing event.
  return expandRecurrenceForRows(rows, from, to);
}

// Expand a list of (possibly-recurring) calendar rows into concrete
// instances overlapping [from, to). A row without rrule passes through as
// itself. A row with rrule is run through the in-process expander, with
// EXDATE/RDATE merged in and per-instance overrides applied.
//
// Override semantics:
//   - cancelled = 1            → drop this instance entirely.
//   - starts_at / ends_at set  → reschedule this one instance only.
//   - summary set              → relabel this one instance only.
// Override matches by `original_starts_at` (unix seconds), the seed-time
// of the unmodified expansion. The override row carries a NULL for any
// field it doesn't change, which the merge below leaves untouched.
async function expandRecurrenceForRows(
  rows: CalendarEventRow[],
  from: number,
  to: number,
): Promise<CalendarEventRow[]> {
  const recurringIds = rows
    .filter(r => r.rrule != null && r.source === "self")
    .map(r => r.id);
  // Pull every override for the recurring rows in one round-trip; for a
  // typical workload this is a small set (a handful per series).
  const overridesByEvent = new Map<string, OverrideRow[]>();
  if (recurringIds.length > 0) {
    const placeholders = recurringIds.map(() => "?").join(",");
    const { results } = await getDb()
      .prepare(
        `SELECT parent_event_id, original_starts_at, starts_at, ends_at,
                summary, cancelled
           FROM calendar_event_overrides
          WHERE parent_event_id IN (${placeholders})`,
      )
      .bind(...recurringIds)
      .all<OverrideRow>();
    for (const o of results ?? []) {
      const list = overridesByEvent.get(o.parent_event_id);
      if (list) list.push(o);
      else overridesByEvent.set(o.parent_event_id, [o]);
    }
  }

  const out: CalendarEventRow[] = [];
  for (const row of rows) {
    if (!row.rrule) {
      out.push(row);
      continue;
    }
    const overrides = overridesByEvent.get(row.id) ?? [];
    const overrideByOriginal = new Map<number, OverrideRow>();
    for (const o of overrides) overrideByOriginal.set(o.original_starts_at, o);

    const duration =
      row.ends_at != null ? row.ends_at - row.starts_at : 0;

    // Bound the expansion. We CLAMP at MAX_OCCURRENCES regardless of
    // RRULE's own COUNT/UNTIL — protects against hostile or malformed
    // rules (FREQ=SECONDLY, COUNT=∞, etc.) without rejecting real ones.
    const startTimes = expandRRule(
      row.rrule,
      row.starts_at,
      row.tz,
      // Pad the upper bound by `duration` so an instance that *starts*
      // before `to` but ends after still surfaces.
      to + Math.max(0, duration),
      from,
      MAX_RECURRENCE_OCCURRENCES,
    );

    // Merge RDATE.
    if (row.rdate) {
      for (const t of parseUnixCsv(row.rdate)) startTimes.add(t);
    }
    // Apply EXDATE last so it can prune anything (RRULE or RDATE).
    if (row.exdate) {
      for (const t of parseUnixCsv(row.exdate)) startTimes.delete(t);
    }

    for (const seed of startTimes) {
      const ov = overrideByOriginal.get(seed);
      if (ov && ov.cancelled === 1) continue;
      const startsAt = ov?.starts_at ?? seed;
      const endsAt =
        ov?.ends_at ?? (row.ends_at != null ? seed + duration : null);
      // In-window check on the resolved instance — the override may have
      // pushed an occurrence outside the requested window.
      if (startsAt >= to) continue;
      if (endsAt != null && endsAt <= from) continue;
      if (endsAt == null && startsAt < from) continue;
      out.push({
        ...row,
        starts_at: startsAt,
        ends_at: endsAt,
        summary: ov?.summary ?? row.summary,
        // Keep the master's id/ical_uid — instance identity downstream
        // (open-in-form, RSVP, etc.) leans on the master row + the
        // original_starts_at to disambiguate.
      });
    }
  }
  // Sort: consumers (grids, tests) expect ascending start.
  out.sort((a, b) => a.starts_at - b.starts_at);
  return out;
}

interface OverrideRow {
  parent_event_id: string;
  original_starts_at: number;
  starts_at: number | null;
  ends_at: number | null;
  summary: string | null;
  cancelled: number;
}

// Hard ceiling on per-row expansion. Even FREQ=DAILY clamped to 4y of
// history would take ~1500 instances; this keeps a runaway rule from
// melting the worker.
const MAX_RECURRENCE_OCCURRENCES = 1500;

function parseUnixCsv(s: string): number[] {
  return s
    .split(",")
    .map(t => Number(t.trim()))
    .filter(t => Number.isFinite(t));
}

// Hand-rolled minimal RRULE expander. Supports the subset our form emits +
// what arrives from inbound invites:
//
//   FREQ      DAILY | WEEKLY | MONTHLY | YEARLY
//   INTERVAL  positive integer
//   COUNT     positive integer (caps at MAX_RECURRENCE_OCCURRENCES anyway)
//   UNTIL     YYYYMMDDTHHMMSSZ (UTC) or YYYYMMDD
//   BYDAY     MO,TU,WE,TH,FR,SA,SU (WEEKLY only)
//   BYMONTHDAY  positive day-of-month (MONTHLY only)
//
// We always CLAMP by the upper window bound and the occurrence cap, so a
// malformed COUNT=∞ rule can never run away.
//
// Returns a Set so callers can inexpensively merge RDATE / strip EXDATE.
//
// `tz` is currently unused for arithmetic — instances are advanced in UTC,
// which is correct for FREQ=DAILY/WEEKLY across DST when the original
// wall-clock encoding lived in UTC. A future pass can do tz-aware advance
// for FREQ=MONTHLY+BYMONTHDAY across DST; v1 leans on the same
// approximation Apple/Outlook use for the simple cases.
export function expandRRule(
  rrule: string,
  seedStart: number,
  _tz: string | null,
  windowEnd: number,
  windowStart: number,
  hardCap: number,
): Set<number> {
  void _tz;
  const out = new Set<number>();
  const parts = parseRRuleString(rrule);
  const freq = parts.FREQ;
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") {
    // Unknown / unsupported FREQ → behave like a single-shot event.
    if (seedStart >= windowStart && seedStart < windowEnd) out.add(seedStart);
    return out;
  }
  const interval = Math.max(1, Number(parts.INTERVAL ?? "1") || 1);
  const count = parts.COUNT != null ? Math.max(0, Number(parts.COUNT) || 0) : null;
  const untilSec = parts.UNTIL ? parseRRuleUntil(parts.UNTIL) : null;
  const byday = parts.BYDAY ? parts.BYDAY.split(",").map(s => s.trim().toUpperCase()) : null;
  const bymonthday = parts.BYMONTHDAY ? Number(parts.BYMONTHDAY) || null : null;

  const seedDate = new Date(seedStart * 1000);
  let emitted = 0;

  // Cursor advances in interval-steps; for WEEKLY+BYDAY we additionally
  // walk every weekday inside each "week step". The DAILY branch is the
  // simplest — the cursor IS the instance.
  if (freq === "DAILY") {
    let t = seedStart;
    while (out.size < hardCap && emitted < hardCap) {
      if (untilSec != null && t > untilSec) break;
      if (count != null && emitted >= count) break;
      if (t >= windowEnd) break;
      if (t >= windowStart) out.add(t);
      emitted += 1;
      t += interval * 86400;
    }
    return out;
  }

  if (freq === "WEEKLY") {
    // Without BYDAY, advance by `interval` weeks from the seed.
    // With BYDAY, the rule fires on each named weekday inside the
    // matching week. We anchor the "week" on Sunday 00:00 UTC so the
    // BYDAY emit times preserve the seed's HH:MM:SS.
    const seedHmsMs =
      seedDate.getUTCHours() * 3600 +
      seedDate.getUTCMinutes() * 60 +
      seedDate.getUTCSeconds();
    const weekStartSec = seedStart - seedDate.getUTCDay() * 86400 - seedHmsMs;
    let weekIdx = 0;
    while (out.size < hardCap && emitted < hardCap) {
      const baseWeek = weekStartSec + weekIdx * interval * 7 * 86400;
      const targets = byday && byday.length > 0
        ? byday
            .map(WEEKDAY_INDEX)
            .filter((d): d is number => d != null)
            .map(d => baseWeek + d * 86400 + seedHmsMs)
        : [baseWeek + seedDate.getUTCDay() * 86400 + seedHmsMs];
      // RFC 5545 says BYDAY emits go in chronological order.
      targets.sort((a, b) => a - b);
      for (const t of targets) {
        if (t < seedStart) continue; // never emit before the seed
        if (untilSec != null && t > untilSec) return out;
        if (count != null && emitted >= count) return out;
        if (t >= windowEnd) return out;
        if (t >= windowStart) out.add(t);
        emitted += 1;
        if (out.size >= hardCap || emitted >= hardCap) return out;
      }
      weekIdx += 1;
      // Defensive — if the calendar somehow yields no progress (no valid
      // BYDAY), bail rather than spin forever.
      if (weekIdx > hardCap) break;
    }
    return out;
  }

  if (freq === "MONTHLY") {
    // Step by `interval` months. BYMONTHDAY pins the day; without it we
    // reuse the seed's day-of-month. If the candidate month doesn't have
    // that day (e.g. Feb 30) we skip — Apple does the same.
    let monthIdx = 0;
    while (out.size < hardCap && emitted < hardCap) {
      const candidate = new Date(seedDate.getTime());
      candidate.setUTCDate(1);
      candidate.setUTCMonth(seedDate.getUTCMonth() + monthIdx * interval);
      const day = bymonthday ?? seedDate.getUTCDate();
      candidate.setUTCDate(day);
      // setUTCDate(31) on a 30-day month rolls over — detect and skip.
      if (candidate.getUTCDate() !== day) {
        monthIdx += 1;
        if (monthIdx > hardCap) break;
        continue;
      }
      const t = Math.floor(candidate.getTime() / 1000);
      if (untilSec != null && t > untilSec) break;
      if (count != null && emitted >= count) break;
      if (t >= windowEnd) break;
      if (t >= windowStart) out.add(t);
      emitted += 1;
      monthIdx += 1;
    }
    return out;
  }

  // YEARLY — step by `interval` years; preserve month/day/HH:MM:SS.
  let yearIdx = 0;
  while (out.size < hardCap && emitted < hardCap) {
    const candidate = new Date(seedDate.getTime());
    candidate.setUTCFullYear(seedDate.getUTCFullYear() + yearIdx * interval);
    // Same Feb-29 caveat as MONTHLY — skip non-existent dates.
    if (candidate.getUTCMonth() !== seedDate.getUTCMonth() ||
        candidate.getUTCDate() !== seedDate.getUTCDate()) {
      yearIdx += 1;
      if (yearIdx > hardCap) break;
      continue;
    }
    const t = Math.floor(candidate.getTime() / 1000);
    if (untilSec != null && t > untilSec) break;
    if (count != null && emitted >= count) break;
    if (t >= windowEnd) break;
    if (t >= windowStart) out.add(t);
    emitted += 1;
    yearIdx += 1;
  }
  return out;
}

function parseRRuleString(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const seg of s.split(";")) {
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    out[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1);
  }
  return out;
}

function parseRRuleUntil(s: string): number | null {
  // YYYYMMDDTHHMMSSZ or YYYYMMDD.
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(s);
  if (dt) {
    return Date.UTC(+dt[1], +dt[2] - 1, +dt[3], +dt[4], +dt[5], +dt[6]) / 1000;
  }
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (date) {
    return Date.UTC(+date[1], +date[2] - 1, +date[3], 23, 59, 59) / 1000;
  }
  return null;
}

const WEEKDAY_INDEX = (d: string): number | null => {
  switch (d) {
    case "SU": return 0;
    case "MO": return 1;
    case "TU": return 2;
    case "WE": return 3;
    case "TH": return 4;
    case "FR": return 5;
    case "SA": return 6;
    default: return null;
  }
};

// Server-side calendar search (#84). Substring match on
// summary/location/description, capped + ordered by recency so the panel
// is bounded and the most-relevant hits sort first.
//
// `from`/`to` are optional — when supplied they bound the search window;
// otherwise we scan the user's full history (capped by `limit`). The
// `filter` arg mirrors listCalendarEvents — undefined = consolidated
// (minus hidden calendars), "personal" = NULL mailbox, mailbox id = that
// calendar only.
//
// "Recency" here means "starts_at closest to now first" — for a user who
// just typed a name into the search bar, the upcoming meeting they're
// thinking about is more useful than something five years ago. We sort
// by absolute distance from now in seconds.
export interface SearchCalendarOpts {
  from?: number;
  to?: number;
  filter?: CalendarFilter;
  limit?: number;
}
export async function searchCalendarEvents(
  userId: string,
  query: string,
  opts: SearchCalendarOpts = {},
): Promise<CalendarEventRow[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  // LIKE-escape the query: any literal %, _, or \ in the user's input
  // would otherwise turn into a wildcard.
  const escaped = trimmed.replace(/[\\%_]/g, m => `\\${m}`);
  const like = `%${escaped}%`;

  // Build the WHERE incrementally so the bind list lines up with the SQL.
  const where: string[] = ["ce.user_id = ?"];
  const binds: unknown[] = [userId];
  where.push(
    "(COALESCE(ce.summary, '') LIKE ? ESCAPE '\\' OR COALESCE(ce.location, '') LIKE ? ESCAPE '\\' OR COALESCE(ce.description, '') LIKE ? ESCAPE '\\')",
  );
  binds.push(like, like, like);
  if (typeof opts.from === "number") {
    where.push("ce.starts_at >= ?");
    binds.push(opts.from);
  }
  if (typeof opts.to === "number") {
    where.push("ce.starts_at < ?");
    binds.push(opts.to);
  }

  if (opts.filter === PERSONAL_CALENDAR) {
    where.push("ce.mailbox_id IS NULL");
  } else if (typeof opts.filter === "string") {
    where.push("ce.mailbox_id = ?");
    binds.push(opts.filter);
  }
  // Hidden filter only applies to the consolidated path — picking a
  // specific calendar means "show me this calendar regardless".
  const useHiddenFilter = opts.filter == null;

  // Order by recency: absolute distance from now in seconds. Cheap arith
  // expression; D1's planner handles the sort fine for a capped result.
  const nowSec = Math.floor(Date.now() / 1000);
  const order = "ABS(ce.starts_at - ?) ASC";
  binds.push(nowSec);

  const sql = useHiddenFilter
    ? `SELECT ce.* FROM calendar_events ce
         LEFT JOIN user_calendar_prefs ucp
                ON ucp.user_id = ce.user_id
               AND ucp.mailbox_id IS ce.mailbox_id
        WHERE ${where.join(" AND ")}
          AND COALESCE(ucp.hidden, 0) = 0
        ORDER BY ${order}
        LIMIT ?`
    : `SELECT ce.* FROM calendar_events ce
        WHERE ${where.join(" AND ")}
        ORDER BY ${order}
        LIMIT ?`;
  binds.push(limit);
  const { results } = await getDb()
    .prepare(sql)
    .bind(...binds)
    .all<CalendarEventRow>();
  return results ?? [];
}

interface UpsertInviteInput {
  userId: string;
  // Mailbox the invite was delivered to (#78). NULL is allowed for
  // backward compatibility but practically every fresh promotion since the
  // 0031 migration carries one — promoteInvitesForThread threads the
  // thread's mailbox_id through.
  mailboxId: string | null;
  icalUid: string;
  sourceMessageId: string;
  startsAt: number;
  endsAt: number | null;
  summary: string | null;
  location: string | null;
  organizerEmail: string | null;
  rawIcs: string | null;
  cancelled: boolean;
  // Recurrence (#80) — pulled from the inbound ICS. Stored verbatim so the
  // expander reads them back without re-parsing. Optional for backward
  // compatibility with callers (and ICS payloads) that have no recurrence.
  rrule?: string | null;
  rdate?: string | null;
  exdate?: string | null;
  // IANA tz (#82). Optional — many invites omit TZID and stamp UTC, in
  // which case the column stays NULL and we fall back to the historical
  // floating-render behaviour.
  tz?: string | null;
}

// Insert an invite row if missing for (user_id, ical_uid). Returns true when
// a new row was created (caller may want to log/notify), false when an
// existing row already covered this UID. ON CONFLICT DO NOTHING leans on the
// partial unique index — concurrent thread-opens are race-safe.
export async function upsertCalendarEvent(
  input: UpsertInviteInput,
): Promise<boolean> {
  const id = crypto.randomUUID();
  const res = await getDb()
    .prepare(
      `INSERT INTO calendar_events
         (id, user_id, mailbox_id, ical_uid, source, source_message_id,
          starts_at, ends_at, all_day, summary, location, description,
          organizer_email, rsvp_status, cancelled, raw_ics,
          rrule, rdate, exdate, tz)
       VALUES (?, ?, ?, ?, 'invite', ?, ?, ?, 0, ?, ?, NULL, ?, 'NEEDS-ACTION', ?, ?,
               ?, ?, ?, ?)
       ON CONFLICT (user_id, ical_uid) WHERE ical_uid IS NOT NULL DO UPDATE
         SET mailbox_id = COALESCE(calendar_events.mailbox_id, excluded.mailbox_id),
             rrule  = COALESCE(excluded.rrule,  calendar_events.rrule),
             rdate  = COALESCE(excluded.rdate,  calendar_events.rdate),
             exdate = COALESCE(excluded.exdate, calendar_events.exdate),
             tz     = COALESCE(excluded.tz,     calendar_events.tz)`,
    )
    .bind(
      id,
      input.userId,
      input.mailboxId,
      input.icalUid,
      input.sourceMessageId,
      input.startsAt,
      input.endsAt,
      input.summary,
      input.location,
      input.organizerEmail,
      input.cancelled ? 1 : 0,
      input.rawIcs,
      input.rrule ?? null,
      input.rdate ?? null,
      input.exdate ?? null,
      input.tz ?? null,
    )
    .run();
  // D1's meta.changes counts the INSERT-or-conflict-UPDATE row. We treat
  // both as "the row exists now"; only callers that care about the precise
  // INSERT case look at this and they're noisy log paths so a false
  // positive is harmless. The mailbox_id COALESCE on conflict means the
  // first promotion that has a mailbox wins — once attribution is set we
  // never overwrite it to NULL on a stale re-promotion.
  return (res.meta?.changes ?? 0) > 0;
}

// Stamp the user's RSVP response on the row matching (user_id, ical_uid).
// Best-effort: if no row exists (e.g. an RSVP fired before the user opened
// the thread that triggers promotion), we insert one so the calendar grid
// reflects the state on next view. Caller passes the originating message id
// + invite metadata so the upsert can land a complete row.
export async function updateRsvpStatus(args: {
  userId: string;
  icalUid: string;
  status: "ACCEPTED" | "TENTATIVE" | "DECLINED";
  fallback: {
    // mailbox_id is optional on the fallback insert — a NULL value just
    // means the RSVP fired before promotion populated it; the next thread
    // open will fill it in via the COALESCE-on-conflict branch above.
    mailboxId?: string | null;
    sourceMessageId: string;
    startsAt: number;
    endsAt: number | null;
    summary: string | null;
    location: string | null;
    organizerEmail: string | null;
  };
}): Promise<void> {
  const db = getDb();
  // Try UPDATE first — common path once the user has opened the thread,
  // which is what triggers promotion in the first place.
  const upd = await db
    .prepare(
      `UPDATE calendar_events
          SET rsvp_status = ?, rsvp_sent_at = unixepoch(), updated_at = unixepoch()
        WHERE user_id = ? AND ical_uid = ?`,
    )
    .bind(args.status, args.userId, args.icalUid)
    .run();
  if ((upd.meta?.changes ?? 0) > 0) return;

  // Race fallback: no row yet (RSVP fired before promotion landed, or the
  // user RSVP'd via a notification/share-target without opening the thread).
  // Insert with the answered status pre-stamped.
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO calendar_events
         (id, user_id, mailbox_id, ical_uid, source, source_message_id,
          starts_at, ends_at, all_day, summary, location, organizer_email,
          rsvp_status, rsvp_sent_at)
       VALUES (?, ?, ?, ?, 'invite', ?, ?, ?, 0, ?, ?, ?, ?, unixepoch())
       ON CONFLICT (user_id, ical_uid) WHERE ical_uid IS NOT NULL DO UPDATE
         SET rsvp_status = excluded.rsvp_status,
             rsvp_sent_at = excluded.rsvp_sent_at,
             updated_at = unixepoch()`,
    )
    .bind(
      id,
      args.userId,
      args.fallback.mailboxId ?? null,
      args.icalUid,
      args.fallback.sourceMessageId,
      args.fallback.startsAt,
      args.fallback.endsAt,
      args.fallback.summary,
      args.fallback.location,
      args.fallback.organizerEmail,
      args.status,
    )
    .run();
}

// Shape we promote from. Caller passes the subset of ThreadMessage fields the
// promotion needs — keeps this lib decoupled from web/src/lib/queries' larger
// surface.
//
// #89: rrule + tz round-trip from message_calendar_events (mail-DB) into
// calendar_events (control-DB) so recurring inbound invites surface every
// occurrence in-window via the existing expander, and so the originating
// IANA zone is available for outbound REQUEST/CANCEL emission (#94).
export interface InviteMessage {
  id: string;
  calendar_event: {
    starts_at: number;
    ends_at: number | null;
    summary: string | null;
    location: string | null;
    organizer: string | null;
    uid: string | null;
    method: string | null;
    rrule: string | null;
    tz: string | null;
  } | null;
}

// Promote inbound invites on a thread into per-user calendar rows. Called
// fire-and-forget from the thread-open page; the user's first open of a
// thread that contains an invite is what surfaces it in /inbox/calendar.
//
// Idempotency: we read existing (user_id, ical_uid) rows first and skip
// any UID we already have *unless* its mailbox_id is NULL — in that case
// we fall through to the upsert which will COALESCE the mailbox_id in.
// The INSERT itself also carries an ON CONFLICT branch — belt-and-braces
// against a concurrent open of the same thread by a long-poll or another
// tab.
//
// `mailboxId` is the thread's mailbox; promoted rows are attributed to it
// so they show up in the right calendar in the consolidated view.
//
// Messages without a UID are skipped: without a UID we have no stable
// dedupe key and we'd risk inserting one row per visit. Same goes for
// METHOD=REPLY messages (those are RSVPs *to* the user, not invites).
export async function promoteInvitesForThread(
  userId: string,
  mailboxId: string | null,
  messages: InviteMessage[],
): Promise<void> {
  const invites = messages.filter(
    (m): m is InviteMessage & { calendar_event: NonNullable<InviteMessage["calendar_event"]> } => {
      if (!m.calendar_event) return false;
      const ev = m.calendar_event;
      if (!ev.uid) return false;
      const method = (ev.method ?? "REQUEST").toUpperCase();
      // PUBLISH + REQUEST land on the user's calendar; REPLY and CANCEL
      // don't create new events (CANCEL flips an existing row's cancelled
      // bit at ingest time in the email-worker).
      return method === "REQUEST" || method === "PUBLISH" || method === "";
    },
  );
  if (invites.length === 0) return;

  // Pre-check which UIDs already exist for this user so we issue O(unique)
  // INSERTs at most. The unique partial index still guards us against the
  // race, but cutting wasted round-trips matters under load. We also pull
  // the existing mailbox_id so a row that was promoted *before* the 0031
  // migration (or via a path that didn't have a mailbox) gets its
  // mailbox_id filled in on this open.
  const uniqueUids = Array.from(new Set(invites.map(m => m.calendar_event.uid!)));
  const placeholders = uniqueUids.map(() => "?").join(",");
  const { results: existing } = await getDb()
    .prepare(
      `SELECT ical_uid, mailbox_id FROM calendar_events
        WHERE user_id = ? AND ical_uid IN (${placeholders})`,
    )
    .bind(userId, ...uniqueUids)
    .all<{ ical_uid: string; mailbox_id: string | null }>();
  // UIDs we've already promoted *with* a mailbox attribution — those we
  // can skip entirely. UIDs whose mailbox_id is still NULL fall through
  // so the upsert's COALESCE branch can backfill them.
  const fullySeen = new Set(
    (existing ?? []).filter(r => r.mailbox_id !== null).map(r => r.ical_uid),
  );

  for (const m of invites) {
    const uid = m.calendar_event.uid!;
    if (fullySeen.has(uid)) continue;
    try {
      await upsertCalendarEvent({
        userId,
        mailboxId,
        icalUid: uid,
        sourceMessageId: m.id,
        startsAt: m.calendar_event.starts_at,
        endsAt: m.calendar_event.ends_at,
        summary: m.calendar_event.summary,
        location: m.calendar_event.location,
        organizerEmail: m.calendar_event.organizer,
        rawIcs: null,
        cancelled: false,
        // #89: thread RRULE + IANA tz from the mail-DB row through to
        // calendar_events. The COALESCE-on-conflict branch in
        // upsertCalendarEvent backfills these onto a row that was promoted
        // before this lift landed (NULL won't clobber existing values).
        rrule: m.calendar_event.rrule,
        tz: m.calendar_event.tz,
      });
      // Add to the in-process set so a duplicate UID later in the same
      // thread (rare but legal — repeated forwards) doesn't re-INSERT.
      fullySeen.add(uid);
    } catch (err) {
      // Don't let one malformed row block the rest of the thread's invites.
      // The unique index conflict path is handled by ON CONFLICT in upsert.
      console.warn("promoteInvitesForThread row failed", err);
    }
  }
}

// Mark every row for a given ical_uid as cancelled. Called when a
// METHOD=CANCEL invite arrives. Cross-user by design: a shared mailbox's
// cancellation cascades to everyone who'd promoted it.
//
// Security: scoped by organizer_email as well as ical_uid. `calendar_events`
// is one shared table and the same ical_uid exists as a separate row per
// user who promoted the invite. A UID-only UPDATE would let anyone who
// knows a UID (co-recipients of a real invite do) cancel everyone's copy by
// forging a CANCEL. The caller MUST pass the organizer parsed from the
// inbound CANCEL .ics; it is matched case-insensitively against the stored
// (lowercased) organizer_email. An empty/absent organizer cannot be
// authenticated against the stored event — the function no-ops in that case.
export async function markCancelledByUid(
  db: D1Database,
  icalUid: string,
  organizerEmail: string,
): Promise<void> {
  const organizer = organizerEmail.trim().toLowerCase();
  if (!organizer) return; // unauthenticatable CANCEL — never run a UID-only update
  await db
    .prepare(
      `UPDATE calendar_events
          SET cancelled = 1, updated_at = unixepoch()
        WHERE ical_uid = ? AND organizer_email = ?`,
    )
    .bind(icalUid, organizer)
    .run();
}

// Create a self-authored event. ical_uid stays NULL for v1 self events —
// we never serve them out as invites, so there's no correlation key to
// preserve. Caller has already validated that `userId` is a real user.
//
// `mailboxId` selects which calendar the event goes on (#78). NULL =
// Personal. The API route validates the user has access to the mailbox
// before calling in.
export interface CreateSelfEventInput {
  userId: string;
  mailboxId: string | null;
  startsAt: number;
  endsAt: number | null;
  allDay: boolean;
  summary: string | null;
  location: string | null;
  description: string | null;
  // Recurrence (#80). When set, the row carries the RRULE verbatim and
  // listCalendarEvents expands it on read.
  rrule?: string | null;
  rdate?: string | null;
  exdate?: string | null;
  // IANA tz (#82). When omitted, the row stores NULL and the existing
  // floating-tz render path (viewer-local) applies.
  tz?: string | null;
  // Stable UID (#81). Set when the event has attendees so the outbound
  // REQUEST and any subsequent UPDATE share a UID — that's how external
  // calendars dedupe. Self events without attendees keep ical_uid NULL.
  icalUid?: string | null;
}

export async function createSelfEvent(
  input: CreateSelfEventInput,
): Promise<string> {
  const id = crypto.randomUUID();
  await getDb()
    .prepare(
      `INSERT INTO calendar_events
         (id, user_id, mailbox_id, ical_uid, source, source_message_id,
          starts_at, ends_at, all_day, summary, location, description,
          rrule, rdate, exdate, tz)
       VALUES (?, ?, ?, ?, 'self', NULL, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.userId,
      input.mailboxId,
      input.icalUid ?? null,
      input.startsAt,
      input.endsAt,
      input.allDay ? 1 : 0,
      input.summary,
      input.location,
      input.description,
      input.rrule ?? null,
      input.rdate ?? null,
      input.exdate ?? null,
      input.tz ?? null,
    )
    .run();
  // #85: every new self event gets a 10-minute reminder by default. Failure
  // here doesn't fail the event creation — the user can edit reminders later
  // and the cron is idempotent on (event_id, minutes_before).
  try {
    await seedDefaultReminder(id);
  } catch (err) {
    console.warn("seedDefaultReminder failed for", id, err);
  }
  return id;
}

// Patch a self event. Invites are read-only — callers should check
// `source === 'self'` before letting the user edit, but we belt-and-braces
// here with the WHERE clause.
export interface PatchSelfEventInput {
  // Move an event between calendars (#78). Pass null to move to Personal.
  // Caller validates the user has access to the mailbox.
  mailboxId?: string | null;
  startsAt?: number;
  endsAt?: number | null;
  allDay?: boolean;
  summary?: string | null;
  location?: string | null;
  description?: string | null;
  // Recurrence (#80). Patching to NULL clears the rule (event becomes
  // single-shot); a non-NULL value replaces the existing RRULE wholesale.
  rrule?: string | null;
  rdate?: string | null;
  exdate?: string | null;
  // IANA tz (#82). NULL clears it (back to floating); a string sets it.
  tz?: string | null;
  // Stable UID (#81). PATCH allows promoting a no-attendee event to one
  // *with* attendees by stamping a UID on the same row.
  icalUid?: string | null;
}

export async function updateSelfEvent(
  userId: string,
  id: string,
  patch: PatchSelfEventInput,
): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.mailboxId !== undefined) {
    sets.push("mailbox_id = ?");
    binds.push(patch.mailboxId);
  }
  if (patch.startsAt !== undefined) {
    sets.push("starts_at = ?");
    binds.push(patch.startsAt);
  }
  if (patch.endsAt !== undefined) {
    sets.push("ends_at = ?");
    binds.push(patch.endsAt);
  }
  if (patch.allDay !== undefined) {
    sets.push("all_day = ?");
    binds.push(patch.allDay ? 1 : 0);
  }
  if (patch.summary !== undefined) {
    sets.push("summary = ?");
    binds.push(patch.summary);
  }
  if (patch.location !== undefined) {
    sets.push("location = ?");
    binds.push(patch.location);
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    binds.push(patch.description);
  }
  if (patch.rrule !== undefined) {
    sets.push("rrule = ?");
    binds.push(patch.rrule);
  }
  if (patch.rdate !== undefined) {
    sets.push("rdate = ?");
    binds.push(patch.rdate);
  }
  if (patch.exdate !== undefined) {
    sets.push("exdate = ?");
    binds.push(patch.exdate);
  }
  if (patch.tz !== undefined) {
    sets.push("tz = ?");
    binds.push(patch.tz);
  }
  if (patch.icalUid !== undefined) {
    sets.push("ical_uid = ?");
    binds.push(patch.icalUid);
  }
  if (sets.length === 0) return true; // no-op patch is a success
  sets.push("updated_at = unixepoch()");
  binds.push(id, userId);
  const res = await getDb()
    .prepare(
      `UPDATE calendar_events SET ${sets.join(", ")}
        WHERE id = ? AND user_id = ? AND source = 'self'`,
    )
    .bind(...binds)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// Hard-delete a self event. Invites stay around (the user shouldn't be
// able to delete a row that the calendar service is going to re-promote
// on the next thread-open anyway); the API route returns 403 for those.
export async function deleteSelfEvent(
  userId: string,
  id: string,
): Promise<boolean> {
  const res = await getDb()
    .prepare(
      `DELETE FROM calendar_events
        WHERE id = ? AND user_id = ? AND source = 'self'`,
    )
    .bind(id, userId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// ─── Per-user calendar prefs (#78) ───────────────────────────────────────
//
// One pref row per (user_id, mailbox_id) the user has touched; absence is
// the default (`#3b82f6`, hidden=0). The "Personal" calendar uses
// mailbox_id IS NULL on the row — JSON / URLs use the literal string
// "personal" via PERSONAL_CALENDAR.
//
// The list view in CalendarManager combines (a) every mailbox the user
// can access + Personal with (b) any prefs rows that exist, so a user
// who's never customised anything still sees every accessible calendar
// rendered with the default color.

export interface UserCalendarPrefRow {
  // NULL means Personal; otherwise the mailbox_id this pref applies to.
  mailbox_id: string | null;
  color: string;
  hidden: number;
}

const DEFAULT_CALENDAR_COLOR = "#3b82f6";

export async function listCalendarPrefs(
  userId: string,
): Promise<UserCalendarPrefRow[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT mailbox_id, color, hidden
         FROM user_calendar_prefs
        WHERE user_id = ?`,
    )
    .bind(userId)
    .all<UserCalendarPrefRow>();
  return results ?? [];
}

export interface CalendarPrefPatch {
  // null targets the Personal pref row.
  mailboxId: string | null;
  color?: string;
  hidden?: boolean;
}

// Upsert a calendar pref. The PRIMARY KEY is (user_id, mailbox_id) so the
// ON CONFLICT branch picks up regardless of NULL-vs-mailbox. Only the
// supplied fields are written; defaults fill in for the other column on
// first INSERT.
export async function upsertCalendarPref(
  userId: string,
  patch: CalendarPrefPatch,
): Promise<void> {
  const color = patch.color ?? DEFAULT_CALENDAR_COLOR;
  const hidden = patch.hidden ? 1 : 0;
  const sets: string[] = [];
  if (patch.color !== undefined) sets.push("color = excluded.color");
  if (patch.hidden !== undefined) sets.push("hidden = excluded.hidden");
  // Empty-patch is a no-op write — still useful to materialise a default
  // row for a calendar so future reads see explicit data.
  const updateClause =
    sets.length === 0 ? "color = user_calendar_prefs.color" : sets.join(", ");
  await getDb()
    .prepare(
      `INSERT INTO user_calendar_prefs (user_id, mailbox_id, color, hidden)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, mailbox_id) DO UPDATE
         SET ${updateClause}`,
    )
    .bind(userId, patch.mailboxId, color, hidden)
    .run();
}

// Validate that the caller actually has access to a mailbox before letting
// them write events / prefs to it. Returns the mailbox_id when access is
// confirmed, throws on miss. Used by the API routes; calendar.ts itself
// stays storage-only.
export async function userHasMailboxAccess(
  userId: string,
  mailboxId: string,
): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `SELECT 1 FROM user_mailbox_access
        WHERE user_id = ? AND mailbox_id = ?`,
    )
    .bind(userId, mailboxId)
    .first<{ "1": number }>();
  return !!row;
}

// ─── User profile tz (#82) ───────────────────────────────────────────────
// New events default to the user's tz when the form's tz picker isn't
// explicitly set. Read here so the API routes don't have to import auth.
export async function getUserDefaultTz(userId: string): Promise<string | null> {
  const row = await getDb()
    .prepare(`SELECT default_tz FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ default_tz: string | null }>();
  return row?.default_tz ?? null;
}

export async function setUserDefaultTz(userId: string, tz: string | null): Promise<void> {
  await getDb()
    .prepare(`UPDATE users SET default_tz = ? WHERE id = ?`)
    .bind(tz, userId)
    .run();
}

// ─── Attendees (#81) ─────────────────────────────────────────────────────
// CRUD + REPLY routing. Self events without attendees never touch this
// table — the form's "no attendees → no send" path skips it entirely.
//
// Email is stored lowercased. Inbound REPLY mail comes through the
// email-worker with whatever case the original ATTENDEE line had; we
// lowercase on store so updateAttendeeRsvp's WHERE clause is a plain
// equality (no LOWER() in the index path).

export interface CalendarAttendeeRow {
  event_id: string;
  email: string;
  role: string | null;
  rsvp_status: "NEEDS-ACTION" | "ACCEPTED" | "TENTATIVE" | "DECLINED" | null;
  responded_at: number | null;
}

export async function listAttendees(eventId: string): Promise<CalendarAttendeeRow[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT event_id, email, role, rsvp_status, responded_at
         FROM calendar_event_attendees
        WHERE event_id = ?
        ORDER BY email ASC`,
    )
    .bind(eventId)
    .all<CalendarAttendeeRow>();
  return results ?? [];
}

export interface AttendeeInput {
  email: string;
  role?: string | null;
}

// Replace the entire attendee set for an event in a single batch. Caller
// has already authorised access via getCalendarEvent + source === 'self'.
// New rows default to NEEDS-ACTION; we DELETE+INSERT so the result is the
// caller's set verbatim — no merging headaches when the form de-attendees.
export async function setAttendees(
  eventId: string,
  attendees: AttendeeInput[],
): Promise<void> {
  const db = getDb();
  const norm = attendees
    .map(a => ({
      email: a.email.trim().toLowerCase(),
      role: a.role ?? null,
    }))
    .filter(a => a.email.length > 0);
  // Dedupe by email — the form may double-submit on chip churn.
  const seen = new Set<string>();
  const unique: typeof norm = [];
  for (const a of norm) {
    if (seen.has(a.email)) continue;
    seen.add(a.email);
    unique.push(a);
  }
  const stmts: D1PreparedStatement[] = [];
  stmts.push(
    db.prepare(`DELETE FROM calendar_event_attendees WHERE event_id = ?`).bind(eventId),
  );
  for (const a of unique) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO calendar_event_attendees
             (event_id, email, role, rsvp_status, responded_at)
           VALUES (?, ?, ?, 'NEEDS-ACTION', NULL)`,
        )
        .bind(eventId, a.email, a.role),
    );
  }
  if (stmts.length > 0) await db.batch(stmts);
}

// Inbound REPLY routing (#81). Called from the email-worker when a
// METHOD=REPLY arrives with the matching UID + attendee mailto. We update
// every event row that owns this UID — for shared mailboxes one UID maps
// to multiple per-user calendar_events rows, so the attendee status syncs
// across them in one shot. Best-effort: a missing event row falls through
// silently (the user simply hasn't promoted the invite yet, which can't
// happen for a self event anyway).
export async function updateAttendeeRsvp(
  db: D1Database,
  icalUid: string,
  attendeeEmail: string,
  status: "ACCEPTED" | "TENTATIVE" | "DECLINED" | "NEEDS-ACTION",
): Promise<number> {
  const email = attendeeEmail.trim().toLowerCase();
  if (!email) return 0;
  const res = await db
    .prepare(
      `UPDATE calendar_event_attendees
          SET rsvp_status = ?, responded_at = unixepoch()
        WHERE email = ?
          AND event_id IN (
            SELECT id FROM calendar_events WHERE ical_uid = ? AND source = 'self'
          )`,
    )
    .bind(status, email, icalUid)
    .run();
  return res.meta?.changes ?? 0;
}

// ─── Free/busy + conflict detection (#86) ────────────────────────────────
// Returns busy windows only — no titles, no attendees, no descriptions.
// Both the in-form conflict banner AND the cross-mailbox aggregation lean
// on this; freebusy never leaks event content even by accident.

export interface BusyWindow {
  start: number;
  end: number;
}

// Caller's own busy windows. Includes recurring expansions. Used by the
// form's inline conflict banner — same-calendar collision is the most
// common UX win. Skips the event being edited so re-saving doesn't
// "conflict with itself".
export async function getBusyWindowsForUser(
  userId: string,
  from: number,
  to: number,
  excludeEventId?: string | null,
): Promise<BusyWindow[]> {
  const events = await listCalendarEvents(userId, from, to);
  const out: BusyWindow[] = [];
  for (const e of events) {
    if (e.cancelled === 1) continue;
    if (excludeEventId && e.id === excludeEventId) continue;
    if (e.all_day === 1) continue; // all-day events don't block specific slots
    const end = e.ends_at ?? e.starts_at + 3600;
    out.push({ start: e.starts_at, end });
  }
  return out;
}

// Aggregated busy windows across users with access to the given mailbox.
// Used by /api/calendar/freebusy. We join calendar_events to
// user_mailbox_access on the event row's user_id so a user's events are
// only surfaced when they themselves can read the mailbox — preserves the
// per-user permission semantics established in #78.
//
// Authorisation: the *caller* must already have access to the mailbox
// (validated in the route). We additionally honour user_calendar_prefs:
// users who've hidden this mailbox calendar don't contribute their busy
// windows to the rollup. Two reasons: (a) it matches the visibility the
// caller would have via listCalendarEvents themselves, and (b) it gives
// individual users an opt-out without a separate setting.
export async function getMailboxBusyWindows(
  mailboxId: string,
  from: number,
  to: number,
): Promise<BusyWindow[]> {
  const db = getDb();
  // Pull every (user, event) row attached to the mailbox in-window. We
  // re-run recurrence expansion per-user via the same expander so the
  // result is identical to what each contributor would see in their own
  // grid — minus the title/location, which we drop in the projection.
  const { results } = await db
    .prepare(
      `SELECT ce.* FROM calendar_events ce
         INNER JOIN user_mailbox_access uma
                 ON uma.user_id = ce.user_id
                AND uma.mailbox_id = ce.mailbox_id
         LEFT JOIN user_calendar_prefs ucp
                ON ucp.user_id = ce.user_id
               AND ucp.mailbox_id IS ce.mailbox_id
        WHERE ce.mailbox_id = ?
          AND ce.starts_at < ?
          AND (
            ce.rrule IS NOT NULL
            OR (ce.ends_at IS NULL OR ce.ends_at > ?)
          )
          AND ce.cancelled = 0
          AND ce.all_day = 0
          AND COALESCE(ucp.hidden, 0) = 0`,
    )
    .bind(mailboxId, to, from)
    .all<CalendarEventRow>();
  const expanded = await expandRecurrenceForRows(results ?? [], from, to);
  return expanded.map(e => ({
    start: e.starts_at,
    end: e.ends_at ?? e.starts_at + 3600,
  }));
}

// ─── Per-instance overrides (#80) ────────────────────────────────────────
// Edit-this-only / cancel-this-only writes a row keyed on
// (parent_event_id, original_starts_at). Edit-all is a regular PATCH
// against the master event — we don't model "Edit this and following" in
// v1 (issue calls it out as future scope).

export interface OverrideInput {
  startsAt?: number | null;
  endsAt?: number | null;
  summary?: string | null;
  cancelled?: boolean;
}

export async function upsertEventOverride(
  userId: string,
  parentEventId: string,
  originalStartsAt: number,
  patch: OverrideInput,
): Promise<boolean> {
  const db = getDb();
  // Authorise: the parent must belong to the caller. Skipping here would
  // let any logged-in user write overrides against any event id.
  const parent = await db
    .prepare(`SELECT id FROM calendar_events WHERE id = ? AND user_id = ? AND source = 'self'`)
    .bind(parentEventId, userId)
    .first<{ id: string }>();
  if (!parent) return false;

  await db
    .prepare(
      `INSERT INTO calendar_event_overrides
         (parent_event_id, original_starts_at, starts_at, ends_at, summary, cancelled)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(parent_event_id, original_starts_at) DO UPDATE
         SET starts_at = excluded.starts_at,
             ends_at   = excluded.ends_at,
             summary   = excluded.summary,
             cancelled = excluded.cancelled`,
    )
    .bind(
      parentEventId,
      originalStartsAt,
      patch.startsAt ?? null,
      patch.endsAt ?? null,
      patch.summary ?? null,
      patch.cancelled ? 1 : 0,
    )
    .run();
  return true;
}

// ─── Split recurrence (#92) ───────────────────────────────────────────────
//
// "Edit this and following" UX. Splits a recurring series at `instanceStart`:
//   1. The original master's RRULE gets an UNTIL appended (set to one
//      second before midnight UTC of the day before `instanceStart`), so
//      every instance from the split point onward stops expanding from
//      the master.
//   2. A fresh self event is INSERTed with the patched fields + the
//      master's FREQ/INTERVAL/BYDAY (UNTIL/COUNT stripped — the new
//      series runs forever from here unless the patch overrides). The
//      new event gets its own UUID **and** a fresh ical_uid — external
//      calendars need to see this as a separate entity, not an update
//      to the original UID.
//   3. Attendees + reminders rows from the master are mirrored onto
//      the new event so the post-split behaviour matches expectation
//      (the user's notification cadence carries over).
//   4. Override rows on the original master that fall AT or AFTER the
//      split point are deleted — they belong to the new series now,
//      and leaving them on the master would be dead state (the master's
//      UNTIL has already pruned those instances).
//
// Atomicity: every write goes through a single `db.batch()` call, which
// D1 executes as one transaction; a failure rolls every step back so we
// never end up with a half-split series.
//
// Authorisation: parent must belong to the caller AND be source='self'.
// We mirror the same WHERE pattern updateSelfEvent uses.
//
// Returns the new event's id on success, or null when the parent doesn't
// exist / isn't owned by the caller / isn't recurring (no rrule).
export interface SplitRecurrencePatch {
  // Patch fields to apply to the NEW event. All optional — a "no edits,
  // just split" call is valid (the form's "Edit this and following"
  // option is the same call shape regardless of which fields the user
  // touched). Anything omitted carries over from the master.
  startsAt?: number;
  endsAt?: number | null;
  allDay?: boolean;
  summary?: string | null;
  location?: string | null;
  description?: string | null;
  tz?: string | null;
}

export async function splitRecurrenceAt(
  userId: string,
  eventId: string,
  instanceStart: number,
  patch: SplitRecurrencePatch,
): Promise<string | null> {
  const db = getDb();

  // Pull the master row first — we need its rrule and the carry-over
  // fields. Authorisation rides on the WHERE.
  const master = await db
    .prepare(
      `SELECT * FROM calendar_events
        WHERE id = ? AND user_id = ? AND source = 'self'`,
    )
    .bind(eventId, userId)
    .first<CalendarEventRow>();
  if (!master) return null;
  if (!master.rrule) return null; // not a recurring series — nothing to split

  // UNTIL for the master: midnight UTC of the day BEFORE the instance.
  // RFC 5545 says UNTIL is inclusive, so we want the last second of the
  // day before so the chosen instance and everything after is excluded.
  const dayBefore = new Date((instanceStart - 86400) * 1000);
  // Clamp to UTC midnight — UNTIL is "the last instance allowed". Using
  // 23:59:59 of the day-before keeps any same-day-earlier instance
  // (rare with WEEKLY but possible with HOURLY-style rules we don't
  // support yet) safe.
  const untilDate = new Date(
    Date.UTC(
      dayBefore.getUTCFullYear(),
      dayBefore.getUTCMonth(),
      dayBefore.getUTCDate(),
      23,
      59,
      59,
    ),
  );
  const untilStr = formatRRuleUntil(untilDate);
  const cappedRrule = appendOrReplaceUntil(master.rrule, untilStr);

  // Pattern carried to the new series — strip COUNT (was relative to
  // the master's start) and any pre-existing UNTIL (the new series
  // continues indefinitely from the split point unless the user
  // explicitly sets one later). FREQ/INTERVAL/BYDAY/BYMONTHDAY all
  // carry over verbatim.
  const carryRrule = stripTerminators(master.rrule);

  // Resolve the new event's fields by overlaying `patch` on top of the
  // master's values. starts_at defaults to the instance start (the
  // user's "from this date forward" semantics); ends_at preserves the
  // master's duration unless explicitly overridden.
  const newStartsAt = patch.startsAt ?? instanceStart;
  const masterDuration =
    master.ends_at != null ? master.ends_at - master.starts_at : null;
  const newEndsAt =
    patch.endsAt !== undefined
      ? patch.endsAt
      : masterDuration != null
        ? newStartsAt + masterDuration
        : null;

  const newId = crypto.randomUUID();
  const newIcalUid = `${crypto.randomUUID()}@orange-inbox.local`;

  // Pull attendees + reminders to mirror onto the new event. These
  // run BEFORE the batch so the INSERT statements can be composed
  // into the same transaction.
  const [attendees, reminderRows] = await Promise.all([
    db
      .prepare(
        `SELECT email, role FROM calendar_event_attendees WHERE event_id = ?`,
      )
      .bind(eventId)
      .all<{ email: string; role: string | null }>()
      .then((r) => r.results ?? []),
    db
      .prepare(
        `SELECT minutes_before FROM calendar_event_reminders WHERE event_id = ?`,
      )
      .bind(eventId)
      .all<{ minutes_before: number }>()
      .then((r) => r.results ?? []),
  ]);

  const stmts: D1PreparedStatement[] = [];

  // 1. Cap the master with UNTIL.
  stmts.push(
    db
      .prepare(
        `UPDATE calendar_events
            SET rrule = ?, updated_at = unixepoch()
          WHERE id = ? AND user_id = ? AND source = 'self'`,
      )
      .bind(cappedRrule, eventId, userId),
  );

  // 2. Insert the new event with the patched content + carry-over rrule.
  stmts.push(
    db
      .prepare(
        `INSERT INTO calendar_events
           (id, user_id, mailbox_id, ical_uid, source, source_message_id,
            starts_at, ends_at, all_day, summary, location, description,
            rrule, rdate, exdate, tz)
         VALUES (?, ?, ?, ?, 'self', NULL, ?, ?, ?, ?, ?, ?,
                 ?, NULL, NULL, ?)`,
      )
      .bind(
        newId,
        userId,
        master.mailbox_id,
        newIcalUid,
        newStartsAt,
        newEndsAt,
        patch.allDay !== undefined ? (patch.allDay ? 1 : 0) : master.all_day,
        patch.summary !== undefined ? patch.summary : master.summary,
        patch.location !== undefined ? patch.location : master.location,
        patch.description !== undefined ? patch.description : master.description,
        carryRrule,
        patch.tz !== undefined ? patch.tz : master.tz,
      ),
  );

  // 3. Mirror attendees onto the new event.
  for (const a of attendees) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO calendar_event_attendees
             (event_id, email, role, rsvp_status, responded_at)
           VALUES (?, ?, ?, 'NEEDS-ACTION', NULL)`,
        )
        .bind(newId, a.email, a.role),
    );
  }

  // 4. Mirror reminders onto the new event.
  for (const r of reminderRows) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO calendar_event_reminders (event_id, minutes_before)
             VALUES (?, ?)
           ON CONFLICT (event_id, minutes_before) DO NOTHING`,
        )
        .bind(newId, r.minutes_before),
    );
  }

  // 5. Drop overrides on the master that target instances at-or-after
  //    the split point. Those instances belong to the new series now.
  stmts.push(
    db
      .prepare(
        `DELETE FROM calendar_event_overrides
          WHERE parent_event_id = ?
            AND original_starts_at >= ?`,
      )
      .bind(eventId, instanceStart),
  );

  // Single batch — D1 wraps it in one transaction so any failure
  // rolls every step back. We never end up with a half-split series.
  await db.batch(stmts);

  return newId;
}

// Format a Date as RFC 5545 UTC UNTIL — YYYYMMDDTHHMMSSZ.
function formatRRuleUntil(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mm = d.getUTCMinutes().toString().padStart(2, "0");
  const ss = d.getUTCSeconds().toString().padStart(2, "0");
  return `${y}${m}${day}T${hh}${mm}${ss}Z`;
}

// Append `UNTIL=…` to an RRULE, replacing any existing UNTIL or COUNT
// (UNTIL and COUNT are mutually exclusive per RFC 5545). Other parts
// pass through verbatim so the master's BYDAY/BYMONTHDAY/INTERVAL etc.
// keep their behaviour up to the cap point.
function appendOrReplaceUntil(rrule: string, untilStr: string): string {
  const segs = rrule.split(";").filter((s) => {
    const k = s.split("=")[0]?.toUpperCase();
    return k !== "UNTIL" && k !== "COUNT";
  });
  segs.push(`UNTIL=${untilStr}`);
  return segs.join(";");
}

// Strip COUNT and UNTIL from an RRULE — the new series's continuation
// rule shouldn't inherit the master's termination.
function stripTerminators(rrule: string): string {
  return rrule
    .split(";")
    .filter((s) => {
      const k = s.split("=")[0]?.toUpperCase();
      return k !== "UNTIL" && k !== "COUNT";
    })
    .join(";");
}
