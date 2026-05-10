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
export async function listCalendarEvents(
  userId: string,
  from: number,
  to: number,
): Promise<CalendarEventRow[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT * FROM calendar_events
        WHERE user_id = ?
          AND starts_at < ?
          AND (ends_at IS NULL OR ends_at > ?)
        ORDER BY starts_at ASC`,
    )
    .bind(userId, to, from)
    .all<CalendarEventRow>();
  return results ?? [];
}

interface UpsertInviteInput {
  userId: string;
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
         (id, user_id, ical_uid, source, source_message_id,
          starts_at, ends_at, all_day, summary, location, description,
          organizer_email, rsvp_status, cancelled, raw_ics)
       VALUES (?, ?, ?, 'invite', ?, ?, ?, 0, ?, ?, NULL, ?, 'NEEDS-ACTION', ?, ?)
       ON CONFLICT (user_id, ical_uid) WHERE ical_uid IS NOT NULL DO NOTHING`,
    )
    .bind(
      id,
      input.userId,
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
  // D1's meta.changes is the canonical "did the INSERT actually write" signal
  // — ON CONFLICT DO NOTHING leaves it at 0 when there was already a row.
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
         (id, user_id, ical_uid, source, source_message_id,
          starts_at, ends_at, all_day, summary, location, organizer_email,
          rsvp_status, rsvp_sent_at)
       VALUES (?, ?, ?, 'invite', ?, ?, ?, 0, ?, ?, ?, ?, unixepoch())
       ON CONFLICT (user_id, ical_uid) WHERE ical_uid IS NOT NULL DO UPDATE
         SET rsvp_status = excluded.rsvp_status,
             rsvp_sent_at = excluded.rsvp_sent_at,
             updated_at = unixepoch()`,
    )
    .bind(
      id,
      args.userId,
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
// any UID we already have. The INSERT itself also carries ON CONFLICT
// DO NOTHING — belt-and-braces against a concurrent open of the same
// thread by a long-poll or another tab.
//
// Messages without a UID are skipped: without a UID we have no stable
// dedupe key and we'd risk inserting one row per visit. Same goes for
// METHOD=REPLY messages (those are RSVPs *to* the user, not invites).
export async function promoteInvitesForThread(
  userId: string,
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
  // race, but cutting wasted round-trips matters under load.
  const uniqueUids = Array.from(new Set(invites.map(m => m.calendar_event.uid!)));
  const placeholders = uniqueUids.map(() => "?").join(",");
  const { results: existing } = await getDb()
    .prepare(
      `SELECT ical_uid FROM calendar_events
        WHERE user_id = ? AND ical_uid IN (${placeholders})`,
    )
    .bind(userId, ...uniqueUids)
    .all<{ ical_uid: string }>();
  const seen = new Set((existing ?? []).map(r => r.ical_uid));

  for (const m of invites) {
    const uid = m.calendar_event.uid!;
    if (seen.has(uid)) continue;
    try {
      await upsertCalendarEvent({
        userId,
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
      seen.add(uid);
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
export interface CreateSelfEventInput {
  userId: string;
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
         (id, user_id, ical_uid, source, source_message_id,
          starts_at, ends_at, all_day, summary, location, description)
       VALUES (?, ?, NULL, 'self', NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.userId,
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
