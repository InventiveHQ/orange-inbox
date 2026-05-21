// Data layer for the meeting-booking feature (orange-inbox#101). Pure D1
// access plus JSON (de)serialization — no HTTP, no calendar/email side
// effects. Availability computation lives in booking-availability.ts;
// calendar/conferencing writes live in booking-fulfill.ts.

import { getDb } from "./db";
import { randomToken } from "./crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConferencingType =
  | "none"
  | "google_meet"
  | "phone"
  | "in_person"
  | "custom_link";

export type CalendarSourceKind = "orange_native" | "google";

export interface WeeklyRule {
  day: number; // 0 = Sunday .. 6 = Saturday
  start: string; // "HH:MM" 24h, in the event type's timezone
  end: string; // "HH:MM" 24h
}

export interface CustomQuestion {
  id: string;
  label: string;
  type: "text" | "textarea";
  required: boolean;
}

export interface EventType {
  id: string;
  userId: string;
  slug: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  timezone: string;
  availability: WeeklyRule[];
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeMinutes: number;
  bookingWindowDays: number;
  slotIntervalMinutes: number;
  conferencingType: ConferencingType;
  conferencingConfig: { value?: string } | null;
  customQuestions: CustomQuestion[];
  color: string | null;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface EventTypeCalendar {
  id: string;
  eventTypeId: string;
  sourceKind: CalendarSourceKind;
  orangeUserId: string | null;
  orangeMailboxId: string | null;
  calendarConnectionId: string | null;
  checkAvailability: boolean;
  writeBookings: boolean;
}

export interface DateOverride {
  id: string;
  eventTypeId: string;
  date: string; // YYYY-MM-DD
  available: boolean;
  ranges: { start: string; end: string }[];
}

export interface CalendarConnection {
  id: string;
  ownerUserId: string;
  provider: string;
  accountEmail: string;
  calendarId: string;
  displayName: string | null;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  tokenExpiresAt: number | null;
  status: string;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export type BookingStatus = "confirmed" | "cancelled" | "rescheduled";

export interface Booking {
  id: string;
  eventTypeId: string;
  hostUserId: string;
  contactId: string | null;
  inviteeName: string;
  inviteeEmail: string;
  inviteeTimezone: string | null;
  startsAt: number;
  endsAt: number;
  status: BookingStatus;
  answers: Record<string, string>;
  conferenceProvider: string | null;
  conferenceUrl: string | null;
  conferenceJoinInfo: Record<string, unknown> | null;
  rescheduleToken: string;
  cancelToken: string;
  cancellationReason: string | null;
  rescheduledToId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BookingCalendarEvent {
  id: string;
  bookingId: string;
  sourceKind: CalendarSourceKind;
  orangeCalendarEventId: string | null;
  calendarConnectionId: string | null;
  googleEventId: string | null;
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

interface EventTypeRow {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  timezone: string;
  availability_json: string;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  min_notice_minutes: number;
  booking_window_days: number;
  slot_interval_minutes: number;
  conferencing_type: string;
  conferencing_config_json: string | null;
  custom_questions_json: string;
  color: string | null;
  active: number;
  created_at: number;
  updated_at: number;
}

function rowToEventType(r: EventTypeRow): EventType {
  return {
    id: r.id,
    userId: r.user_id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    durationMinutes: r.duration_minutes,
    timezone: r.timezone,
    availability: safeParse<WeeklyRule[]>(r.availability_json, []),
    bufferBeforeMinutes: r.buffer_before_minutes,
    bufferAfterMinutes: r.buffer_after_minutes,
    minNoticeMinutes: r.min_notice_minutes,
    bookingWindowDays: r.booking_window_days,
    slotIntervalMinutes: r.slot_interval_minutes,
    conferencingType: r.conferencing_type as ConferencingType,
    conferencingConfig: safeParse<{ value?: string } | null>(
      r.conferencing_config_json,
      null,
    ),
    customQuestions: safeParse<CustomQuestion[]>(r.custom_questions_json, []),
    color: r.color,
    active: r.active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface EventTypeInput {
  slug: string;
  name: string;
  description?: string | null;
  durationMinutes: number;
  timezone: string;
  availability: WeeklyRule[];
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  minNoticeMinutes?: number;
  bookingWindowDays?: number;
  slotIntervalMinutes?: number;
  conferencingType?: ConferencingType;
  conferencingConfig?: { value?: string } | null;
  customQuestions?: CustomQuestion[];
  color?: string | null;
  active?: boolean;
}

export async function listEventTypes(userId: string): Promise<EventType[]> {
  const { results } = await getDb()
    .prepare("SELECT * FROM booking_event_types WHERE user_id = ? ORDER BY created_at DESC")
    .bind(userId)
    .all<EventTypeRow>();
  return results.map(rowToEventType);
}

export async function getEventType(
  userId: string,
  id: string,
): Promise<EventType | null> {
  const row = await getDb()
    .prepare("SELECT * FROM booking_event_types WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<EventTypeRow>();
  return row ? rowToEventType(row) : null;
}

// Public lookup for the booking page — no user scoping, active only.
export async function getEventTypeBySlug(slug: string): Promise<EventType | null> {
  const row = await getDb()
    .prepare("SELECT * FROM booking_event_types WHERE slug = ? AND active = 1")
    .bind(slug)
    .first<EventTypeRow>();
  return row ? rowToEventType(row) : null;
}

export async function getEventTypeById(id: string): Promise<EventType | null> {
  const row = await getDb()
    .prepare("SELECT * FROM booking_event_types WHERE id = ?")
    .bind(id)
    .first<EventTypeRow>();
  return row ? rowToEventType(row) : null;
}

export async function slugExists(slug: string, exceptId?: string): Promise<boolean> {
  const row = await getDb()
    .prepare("SELECT id FROM booking_event_types WHERE slug = ?")
    .bind(slug)
    .first<{ id: string }>();
  return !!row && row.id !== exceptId;
}

export async function createEventType(
  userId: string,
  input: EventTypeInput,
): Promise<EventType> {
  const id = crypto.randomUUID();
  const ts = now();
  await getDb()
    .prepare(
      `INSERT INTO booking_event_types
       (id, user_id, slug, name, description, duration_minutes, timezone,
        availability_json, buffer_before_minutes, buffer_after_minutes,
        min_notice_minutes, booking_window_days, slot_interval_minutes,
        conferencing_type, conferencing_config_json, custom_questions_json,
        color, active, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id,
      userId,
      input.slug,
      input.name,
      input.description ?? null,
      input.durationMinutes,
      input.timezone,
      JSON.stringify(input.availability ?? []),
      input.bufferBeforeMinutes ?? 0,
      input.bufferAfterMinutes ?? 0,
      input.minNoticeMinutes ?? 0,
      input.bookingWindowDays ?? 60,
      input.slotIntervalMinutes ?? 30,
      input.conferencingType ?? "none",
      input.conferencingConfig ? JSON.stringify(input.conferencingConfig) : null,
      JSON.stringify(input.customQuestions ?? []),
      input.color ?? null,
      input.active === false ? 0 : 1,
      ts,
      ts,
    )
    .run();
  const created = await getEventTypeById(id);
  if (!created) throw new Error("event type insert failed");
  return created;
}

export async function updateEventType(
  userId: string,
  id: string,
  patch: Partial<EventTypeInput>,
): Promise<EventType | null> {
  const cur = await getEventType(userId, id);
  if (!cur) return null;
  const merged: EventTypeInput = {
    slug: patch.slug ?? cur.slug,
    name: patch.name ?? cur.name,
    description: patch.description !== undefined ? patch.description : cur.description,
    durationMinutes: patch.durationMinutes ?? cur.durationMinutes,
    timezone: patch.timezone ?? cur.timezone,
    availability: patch.availability ?? cur.availability,
    bufferBeforeMinutes: patch.bufferBeforeMinutes ?? cur.bufferBeforeMinutes,
    bufferAfterMinutes: patch.bufferAfterMinutes ?? cur.bufferAfterMinutes,
    minNoticeMinutes: patch.minNoticeMinutes ?? cur.minNoticeMinutes,
    bookingWindowDays: patch.bookingWindowDays ?? cur.bookingWindowDays,
    slotIntervalMinutes: patch.slotIntervalMinutes ?? cur.slotIntervalMinutes,
    conferencingType: patch.conferencingType ?? cur.conferencingType,
    conferencingConfig:
      patch.conferencingConfig !== undefined
        ? patch.conferencingConfig
        : cur.conferencingConfig,
    customQuestions: patch.customQuestions ?? cur.customQuestions,
    color: patch.color !== undefined ? patch.color : cur.color,
    active: patch.active !== undefined ? patch.active : cur.active,
  };
  await getDb()
    .prepare(
      `UPDATE booking_event_types SET
        slug=?, name=?, description=?, duration_minutes=?, timezone=?,
        availability_json=?, buffer_before_minutes=?, buffer_after_minutes=?,
        min_notice_minutes=?, booking_window_days=?, slot_interval_minutes=?,
        conferencing_type=?, conferencing_config_json=?, custom_questions_json=?,
        color=?, active=?, updated_at=?
       WHERE id=? AND user_id=?`,
    )
    .bind(
      merged.slug,
      merged.name,
      merged.description ?? null,
      merged.durationMinutes,
      merged.timezone,
      JSON.stringify(merged.availability),
      merged.bufferBeforeMinutes ?? 0,
      merged.bufferAfterMinutes ?? 0,
      merged.minNoticeMinutes ?? 0,
      merged.bookingWindowDays ?? 60,
      merged.slotIntervalMinutes ?? 30,
      merged.conferencingType ?? "none",
      merged.conferencingConfig ? JSON.stringify(merged.conferencingConfig) : null,
      JSON.stringify(merged.customQuestions ?? []),
      merged.color ?? null,
      merged.active === false ? 0 : 1,
      now(),
      id,
      userId,
    )
    .run();
  return getEventType(userId, id);
}

export async function deleteEventType(userId: string, id: string): Promise<boolean> {
  const res = await getDb()
    .prepare("DELETE FROM booking_event_types WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Event-type calendars (which calendars a booking link spans)
// ---------------------------------------------------------------------------

interface EventTypeCalendarRow {
  id: string;
  event_type_id: string;
  source_kind: string;
  orange_user_id: string | null;
  orange_mailbox_id: string | null;
  calendar_connection_id: string | null;
  check_availability: number;
  write_bookings: number;
}

function rowToCal(r: EventTypeCalendarRow): EventTypeCalendar {
  return {
    id: r.id,
    eventTypeId: r.event_type_id,
    sourceKind: r.source_kind as CalendarSourceKind,
    orangeUserId: r.orange_user_id,
    orangeMailboxId: r.orange_mailbox_id,
    calendarConnectionId: r.calendar_connection_id,
    checkAvailability: r.check_availability === 1,
    writeBookings: r.write_bookings === 1,
  };
}

export async function getEventTypeCalendars(
  eventTypeId: string,
): Promise<EventTypeCalendar[]> {
  const { results } = await getDb()
    .prepare("SELECT * FROM booking_event_type_calendars WHERE event_type_id = ?")
    .bind(eventTypeId)
    .all<EventTypeCalendarRow>();
  return results.map(rowToCal);
}

export interface EventTypeCalendarInput {
  sourceKind: CalendarSourceKind;
  orangeUserId?: string | null;
  orangeMailboxId?: string | null;
  calendarConnectionId?: string | null;
  checkAvailability?: boolean;
  writeBookings?: boolean;
}

// Replace the full set of calendars for an event type.
export async function setEventTypeCalendars(
  eventTypeId: string,
  calendars: EventTypeCalendarInput[],
): Promise<void> {
  const db = getDb();
  await db
    .prepare("DELETE FROM booking_event_type_calendars WHERE event_type_id = ?")
    .bind(eventTypeId)
    .run();
  for (const c of calendars) {
    await db
      .prepare(
        `INSERT INTO booking_event_type_calendars
         (id, event_type_id, source_kind, orange_user_id, orange_mailbox_id,
          calendar_connection_id, check_availability, write_bookings, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        crypto.randomUUID(),
        eventTypeId,
        c.sourceKind,
        c.orangeUserId ?? null,
        c.orangeMailboxId ?? null,
        c.calendarConnectionId ?? null,
        c.checkAvailability === false ? 0 : 1,
        c.writeBookings === false ? 0 : 1,
        now(),
      )
      .run();
  }
}

// ---------------------------------------------------------------------------
// Date overrides
// ---------------------------------------------------------------------------

interface OverrideRow {
  id: string;
  event_type_id: string;
  date: string;
  available: number;
  ranges_json: string | null;
}

export async function getOverrides(eventTypeId: string): Promise<DateOverride[]> {
  const { results } = await getDb()
    .prepare("SELECT * FROM booking_availability_overrides WHERE event_type_id = ?")
    .bind(eventTypeId)
    .all<OverrideRow>();
  return results.map((r) => ({
    id: r.id,
    eventTypeId: r.event_type_id,
    date: r.date,
    available: r.available === 1,
    ranges: safeParse<{ start: string; end: string }[]>(r.ranges_json, []),
  }));
}

export async function setOverrides(
  eventTypeId: string,
  overrides: { date: string; available: boolean; ranges: { start: string; end: string }[] }[],
): Promise<void> {
  const db = getDb();
  await db
    .prepare("DELETE FROM booking_availability_overrides WHERE event_type_id = ?")
    .bind(eventTypeId)
    .run();
  for (const o of overrides) {
    await db
      .prepare(
        `INSERT INTO booking_availability_overrides
         (id, event_type_id, date, available, ranges_json) VALUES (?,?,?,?,?)`,
      )
      .bind(
        crypto.randomUUID(),
        eventTypeId,
        o.date,
        o.available ? 1 : 0,
        JSON.stringify(o.ranges ?? []),
      )
      .run();
  }
}

// ---------------------------------------------------------------------------
// Calendar connections (Google)
// ---------------------------------------------------------------------------

interface ConnectionRow {
  id: string;
  owner_user_id: string;
  provider: string;
  account_email: string;
  calendar_id: string;
  display_name: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: number | null;
  status: string;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToConnection(r: ConnectionRow): CalendarConnection {
  return {
    id: r.id,
    ownerUserId: r.owner_user_id,
    provider: r.provider,
    accountEmail: r.account_email,
    calendarId: r.calendar_id,
    displayName: r.display_name,
    accessTokenEnc: r.access_token_enc,
    refreshTokenEnc: r.refresh_token_enc,
    tokenExpiresAt: r.token_expires_at,
    status: r.status,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listCalendarConnections(
  userId: string,
): Promise<CalendarConnection[]> {
  const { results } = await getDb()
    .prepare("SELECT * FROM calendar_connections WHERE owner_user_id = ? ORDER BY created_at")
    .bind(userId)
    .all<ConnectionRow>();
  return results.map(rowToConnection);
}

export async function getCalendarConnection(
  id: string,
): Promise<CalendarConnection | null> {
  const row = await getDb()
    .prepare("SELECT * FROM calendar_connections WHERE id = ?")
    .bind(id)
    .first<ConnectionRow>();
  return row ? rowToConnection(row) : null;
}

export async function upsertCalendarConnection(args: {
  ownerUserId: string;
  accountEmail: string;
  calendarId?: string;
  displayName?: string | null;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenExpiresAt: number | null;
}): Promise<CalendarConnection> {
  const db = getDb();
  const calendarId = args.calendarId ?? "primary";
  const existing = await db
    .prepare(
      `SELECT * FROM calendar_connections
       WHERE owner_user_id = ? AND provider = 'google'
         AND account_email = ? AND calendar_id = ?`,
    )
    .bind(args.ownerUserId, args.accountEmail, calendarId)
    .first<ConnectionRow>();
  if (existing) {
    await db
      .prepare(
        `UPDATE calendar_connections SET
          display_name=?, access_token_enc=?,
          refresh_token_enc=COALESCE(?, refresh_token_enc),
          token_expires_at=?, status='active', last_error=NULL, updated_at=?
         WHERE id=?`,
      )
      .bind(
        args.displayName ?? existing.display_name,
        args.accessTokenEnc,
        args.refreshTokenEnc,
        args.tokenExpiresAt,
        now(),
        existing.id,
      )
      .run();
    const updated = await getCalendarConnection(existing.id);
    return updated!;
  }
  const id = crypto.randomUUID();
  const ts = now();
  await db
    .prepare(
      `INSERT INTO calendar_connections
       (id, owner_user_id, provider, account_email, calendar_id, display_name,
        access_token_enc, refresh_token_enc, token_expires_at, status,
        created_at, updated_at)
       VALUES (?,?,'google',?,?,?,?,?,?,'active',?,?)`,
    )
    .bind(
      id,
      args.ownerUserId,
      args.accountEmail,
      calendarId,
      args.displayName ?? null,
      args.accessTokenEnc,
      args.refreshTokenEnc,
      args.tokenExpiresAt,
      ts,
      ts,
    )
    .run();
  const created = await getCalendarConnection(id);
  return created!;
}

export async function updateConnectionTokens(
  id: string,
  accessTokenEnc: string,
  tokenExpiresAt: number | null,
): Promise<void> {
  await getDb()
    .prepare(
      "UPDATE calendar_connections SET access_token_enc=?, token_expires_at=?, status='active', last_error=NULL, updated_at=? WHERE id=?",
    )
    .bind(accessTokenEnc, tokenExpiresAt, now(), id)
    .run();
}

export async function markConnectionError(id: string, error: string): Promise<void> {
  await getDb()
    .prepare("UPDATE calendar_connections SET status='error', last_error=?, updated_at=? WHERE id=?")
    .bind(error.slice(0, 500), now(), id)
    .run();
}

export async function deleteCalendarConnection(
  userId: string,
  id: string,
): Promise<boolean> {
  const res = await getDb()
    .prepare("DELETE FROM calendar_connections WHERE id = ? AND owner_user_id = ?")
    .bind(id, userId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

interface BookingRow {
  id: string;
  event_type_id: string;
  host_user_id: string;
  contact_id: string | null;
  invitee_name: string;
  invitee_email: string;
  invitee_timezone: string | null;
  starts_at: number;
  ends_at: number;
  status: string;
  answers_json: string | null;
  conference_provider: string | null;
  conference_url: string | null;
  conference_join_info_json: string | null;
  reschedule_token: string;
  cancel_token: string;
  cancellation_reason: string | null;
  rescheduled_to_id: string | null;
  created_at: number;
  updated_at: number;
}

function rowToBooking(r: BookingRow): Booking {
  return {
    id: r.id,
    eventTypeId: r.event_type_id,
    hostUserId: r.host_user_id,
    contactId: r.contact_id,
    inviteeName: r.invitee_name,
    inviteeEmail: r.invitee_email,
    inviteeTimezone: r.invitee_timezone,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    status: r.status as BookingStatus,
    answers: safeParse<Record<string, string>>(r.answers_json, {}),
    conferenceProvider: r.conference_provider,
    conferenceUrl: r.conference_url,
    conferenceJoinInfo: safeParse<Record<string, unknown> | null>(
      r.conference_join_info_json,
      null,
    ),
    rescheduleToken: r.reschedule_token,
    cancelToken: r.cancel_token,
    cancellationReason: r.cancellation_reason,
    rescheduledToId: r.rescheduled_to_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CreateBookingInput {
  eventTypeId: string;
  hostUserId: string;
  contactId?: string | null;
  inviteeName: string;
  inviteeEmail: string;
  inviteeTimezone?: string | null;
  startsAt: number;
  endsAt: number;
  answers?: Record<string, string>;
}

export async function createBooking(input: CreateBookingInput): Promise<Booking> {
  const id = crypto.randomUUID();
  const ts = now();
  await getDb()
    .prepare(
      `INSERT INTO bookings
       (id, event_type_id, host_user_id, contact_id, invitee_name,
        invitee_email, invitee_timezone, starts_at, ends_at, status,
        answers_json, reschedule_token, cancel_token, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,'confirmed',?,?,?,?,?)`,
    )
    .bind(
      id,
      input.eventTypeId,
      input.hostUserId,
      input.contactId ?? null,
      input.inviteeName,
      input.inviteeEmail,
      input.inviteeTimezone ?? null,
      input.startsAt,
      input.endsAt,
      JSON.stringify(input.answers ?? {}),
      randomToken(),
      randomToken(),
      ts,
      ts,
    )
    .run();
  const created = await getBooking(id);
  if (!created) throw new Error("booking insert failed");
  return created;
}

export async function getBooking(id: string): Promise<Booking | null> {
  const row = await getDb()
    .prepare("SELECT * FROM bookings WHERE id = ?")
    .bind(id)
    .first<BookingRow>();
  return row ? rowToBooking(row) : null;
}

export async function getBookingByToken(
  kind: "reschedule" | "cancel",
  token: string,
): Promise<Booking | null> {
  const col = kind === "reschedule" ? "reschedule_token" : "cancel_token";
  const row = await getDb()
    .prepare(`SELECT * FROM bookings WHERE ${col} = ?`)
    .bind(token)
    .first<BookingRow>();
  return row ? rowToBooking(row) : null;
}

export async function listBookingsForUser(
  userId: string,
  opts: { upcoming?: boolean; limit?: number } = {},
): Promise<Booking[]> {
  const limit = Math.min(opts.limit ?? 200, 500);
  let sql = "SELECT * FROM bookings WHERE host_user_id = ?";
  const binds: unknown[] = [userId];
  if (opts.upcoming) {
    sql += " AND ends_at >= ? AND status = 'confirmed'";
    binds.push(now());
  }
  sql += " ORDER BY starts_at DESC LIMIT ?";
  binds.push(limit);
  const { results } = await getDb()
    .prepare(sql)
    .bind(...binds)
    .all<BookingRow>();
  return results.map(rowToBooking);
}

// Confirmed bookings for an event type overlapping [from, to) — used by the
// availability engine to subtract already-taken slots.
export async function listConfirmedBookingsInRange(
  eventTypeId: string,
  from: number,
  to: number,
): Promise<Booking[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT * FROM bookings
       WHERE event_type_id = ? AND status = 'confirmed'
         AND starts_at < ? AND ends_at > ?`,
    )
    .bind(eventTypeId, to, from)
    .all<BookingRow>();
  return results.map(rowToBooking);
}

export async function setBookingConference(
  id: string,
  provider: string | null,
  url: string | null,
  joinInfo: Record<string, unknown> | null,
): Promise<void> {
  await getDb()
    .prepare(
      "UPDATE bookings SET conference_provider=?, conference_url=?, conference_join_info_json=?, updated_at=? WHERE id=?",
    )
    .bind(provider, url, joinInfo ? JSON.stringify(joinInfo) : null, now(), id)
    .run();
}

export async function setBookingContact(id: string, contactId: string): Promise<void> {
  await getDb()
    .prepare("UPDATE bookings SET contact_id=?, updated_at=? WHERE id=?")
    .bind(contactId, now(), id)
    .run();
}

export async function cancelBooking(id: string, reason: string | null): Promise<void> {
  await getDb()
    .prepare(
      "UPDATE bookings SET status='cancelled', cancellation_reason=?, updated_at=? WHERE id=?",
    )
    .bind(reason, now(), id)
    .run();
}

export async function markBookingRescheduled(
  id: string,
  newBookingId: string,
): Promise<void> {
  await getDb()
    .prepare(
      "UPDATE bookings SET status='rescheduled', rescheduled_to_id=?, updated_at=? WHERE id=?",
    )
    .bind(newBookingId, now(), id)
    .run();
}

export async function rescheduleBookingTime(
  id: string,
  startsAt: number,
  endsAt: number,
): Promise<void> {
  await getDb()
    .prepare("UPDATE bookings SET starts_at=?, ends_at=?, updated_at=? WHERE id=?")
    .bind(startsAt, endsAt, now(), id)
    .run();
}

// ---------------------------------------------------------------------------
// Booking calendar events (one row per calendar a booking was written into)
// ---------------------------------------------------------------------------

interface BookingCalEventRow {
  id: string;
  booking_id: string;
  source_kind: string;
  orange_calendar_event_id: string | null;
  calendar_connection_id: string | null;
  google_event_id: string | null;
}

export async function addBookingCalendarEvent(args: {
  bookingId: string;
  sourceKind: CalendarSourceKind;
  orangeCalendarEventId?: string | null;
  calendarConnectionId?: string | null;
  googleEventId?: string | null;
}): Promise<void> {
  await getDb()
    .prepare(
      `INSERT INTO booking_calendar_events
       (id, booking_id, source_kind, orange_calendar_event_id,
        calendar_connection_id, google_event_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      args.bookingId,
      args.sourceKind,
      args.orangeCalendarEventId ?? null,
      args.calendarConnectionId ?? null,
      args.googleEventId ?? null,
      now(),
    )
    .run();
}

export async function getBookingCalendarEvents(
  bookingId: string,
): Promise<BookingCalendarEvent[]> {
  const { results } = await getDb()
    .prepare("SELECT * FROM booking_calendar_events WHERE booking_id = ?")
    .bind(bookingId)
    .all<BookingCalEventRow>();
  return results.map((r) => ({
    id: r.id,
    bookingId: r.booking_id,
    sourceKind: r.source_kind as CalendarSourceKind,
    orangeCalendarEventId: r.orange_calendar_event_id,
    calendarConnectionId: r.calendar_connection_id,
    googleEventId: r.google_event_id,
  }));
}

export async function deleteBookingCalendarEvents(bookingId: string): Promise<void> {
  await getDb()
    .prepare("DELETE FROM booking_calendar_events WHERE booking_id = ?")
    .bind(bookingId)
    .run();
}

// ---------------------------------------------------------------------------
// Booking reminders (due-table for the email-worker cron)
// ---------------------------------------------------------------------------

export async function addBookingReminder(
  bookingId: string,
  remindAt: number,
): Promise<void> {
  await getDb()
    .prepare(
      "INSERT INTO booking_reminders (id, booking_id, remind_at, created_at) VALUES (?,?,?,?)",
    )
    .bind(crypto.randomUUID(), bookingId, remindAt, now())
    .run();
}

export async function clearBookingReminders(bookingId: string): Promise<void> {
  await getDb()
    .prepare("DELETE FROM booking_reminders WHERE booking_id = ? AND sent_at IS NULL")
    .bind(bookingId)
    .run();
}
