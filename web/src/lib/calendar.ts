import { getDb } from "./db";

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
  if (filter === PERSONAL_CALENDAR) {
    const { results } = await db
      .prepare(
        `SELECT * FROM calendar_events
          WHERE user_id = ?
            AND mailbox_id IS NULL
            AND starts_at < ?
            AND (ends_at IS NULL OR ends_at > ?)
          ORDER BY starts_at ASC`,
      )
      .bind(userId, to, from)
      .all<CalendarEventRow>();
    return results ?? [];
  }
  if (typeof filter === "string") {
    const { results } = await db
      .prepare(
        `SELECT * FROM calendar_events
          WHERE user_id = ?
            AND mailbox_id = ?
            AND starts_at < ?
            AND (ends_at IS NULL OR ends_at > ?)
          ORDER BY starts_at ASC`,
      )
      .bind(userId, filter, to, from)
      .all<CalendarEventRow>();
    return results ?? [];
  }
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
          AND (ce.ends_at IS NULL OR ce.ends_at > ?)
          AND COALESCE(ucp.hidden, 0) = 0
        ORDER BY ce.starts_at ASC`,
    )
    .bind(userId, to, from)
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
          organizer_email, rsvp_status, cancelled, raw_ics)
       VALUES (?, ?, ?, ?, 'invite', ?, ?, ?, 0, ?, ?, NULL, ?, 'NEEDS-ACTION', ?, ?)
       ON CONFLICT (user_id, ical_uid) WHERE ical_uid IS NOT NULL DO UPDATE
         SET mailbox_id = COALESCE(calendar_events.mailbox_id, excluded.mailbox_id)`,
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

// Mark every row for a given ical_uid as cancelled. Called from the
// email-worker when a METHOD=CANCEL invite arrives. Cross-user by design:
// a shared mailbox's cancellation cascades to everyone who'd promoted it.
export async function markCancelledByUid(
  db: D1Database,
  icalUid: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE calendar_events
          SET cancelled = 1, updated_at = unixepoch()
        WHERE ical_uid = ?`,
    )
    .bind(icalUid)
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
}

export async function createSelfEvent(
  input: CreateSelfEventInput,
): Promise<string> {
  const id = crypto.randomUUID();
  await getDb()
    .prepare(
      `INSERT INTO calendar_events
         (id, user_id, mailbox_id, ical_uid, source, source_message_id,
          starts_at, ends_at, all_day, summary, location, description)
       VALUES (?, ?, ?, NULL, 'self', NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.userId,
      input.mailboxId,
      input.startsAt,
      input.endsAt,
      input.allDay ? 1 : 0,
      input.summary,
      input.location,
      input.description,
    )
    .run();
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
