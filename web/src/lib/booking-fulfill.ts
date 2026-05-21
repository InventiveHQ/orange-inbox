// Booking fulfillment (orange-inbox#105, #106, #112).
//
// Given a confirmed booking this writes the meeting into every write_bookings
// calendar (Orange-native + Google), mints one conference link, links/creates
// the invitee contact, emails a calendar invite, and schedules reminders.
// cancelBookingFulfillment + rescheduleBookingFulfillment fan the change out
// to every calendar a booking touched.
//
// Resilience: the booking row is already persisted before this runs. Calendar
// writes that fail are logged but do not throw past the per-calendar try —
// a confirmed booking must not be lost because one calendar was unreachable.

import { getDb } from "./db";
import {
  createSelfEvent,
  deleteSelfEvent,
  updateSelfEvent,
} from "./calendar";
import {
  addBookingCalendarEvent,
  addBookingReminder,
  clearBookingReminders,
  getBookingCalendarEvents,
  getCalendarConnection,
  setBookingConference,
  setBookingContact,
  type Booking,
  type EventType,
  type EventTypeCalendar,
} from "./booking";
import {
  deleteGoogleEvent,
  insertGoogleEvent,
  patchGoogleEvent,
} from "./google-calendar";
import { sendCalendarInvite } from "./send";
import { buildCancelIcs, buildRequestIcs } from "./ical-build";

const nowSec = () => Math.floor(Date.now() / 1000);

interface HostMailbox {
  mailboxId: string;
  address: string;
}

// Resolve the mailbox a booking is sent FROM and whose address book the
// invitee contact lands in. Preference: a write_bookings Orange-native
// calendar's mailbox (e.g. the website's mailbox), else the host's first
// owned mailbox. Returns null when the host has no Orange mailbox at all.
async function resolveHostMailbox(
  hostUserId: string,
  calendars: EventTypeCalendar[],
): Promise<HostMailbox | null> {
  const db = getDb();
  const tryMailbox = async (mailboxId: string): Promise<HostMailbox | null> => {
    const row = await db
      .prepare(
        `SELECT m.id AS id, m.local_part AS local_part, d.name AS domain
           FROM mailboxes m JOIN domains d ON d.id = m.domain_id
          WHERE m.id = ?`,
      )
      .bind(mailboxId)
      .first<{ id: string; local_part: string; domain: string }>();
    if (!row) return null;
    return { mailboxId: row.id, address: `${row.local_part}@${row.domain}` };
  };

  for (const c of calendars) {
    if (c.sourceKind === "orange_native" && c.writeBookings && c.orangeMailboxId) {
      const mb = await tryMailbox(c.orangeMailboxId);
      if (mb) return mb;
    }
  }
  const row = await db
    .prepare(
      `SELECT m.id AS id, m.local_part AS local_part, d.name AS domain
         FROM user_mailbox_access uma
         JOIN mailboxes m ON m.id = uma.mailbox_id
         JOIN domains d ON d.id = m.domain_id
        WHERE uma.user_id = ? AND uma.role IN ('owner','member')
        ORDER BY uma.sort_order LIMIT 1`,
    )
    .bind(hostUserId)
    .first<{ id: string; local_part: string; domain: string }>();
  if (!row) return null;
  return { mailboxId: row.id, address: `${row.local_part}@${row.domain}` };
}

function describeBooking(
  eventType: EventType,
  booking: Booking,
  conferenceUrl: string | null,
): string {
  const lines: string[] = [];
  lines.push(`Booked by ${booking.inviteeName} <${booking.inviteeEmail}>`);
  if (conferenceUrl) lines.push(`Join: ${conferenceUrl}`);
  const answers = booking.answers ?? {};
  for (const q of eventType.customQuestions) {
    const a = answers[q.id];
    if (a) lines.push(`${q.label}: ${a}`);
  }
  if (eventType.description) {
    lines.push("");
    lines.push(eventType.description);
  }
  return lines.join("\n");
}

// Best-effort contact link: find an existing contact in the host mailbox by
// email, else create one. Never throws — contact linkage is enrichment.
async function ensureContact(
  hostUserId: string,
  mailboxId: string,
  email: string,
  name: string,
): Promise<string | null> {
  try {
    const db = getDb();
    const existing = await db
      .prepare("SELECT id FROM contacts WHERE mailbox_id = ? AND email_lc = ?")
      .bind(mailboxId, email.toLowerCase())
      .first<{ id: string }>();
    if (existing) return existing.id;
    const { createContact } = await import("./contacts");
    const created = await createContact(hostUserId, {
      mailbox_id: mailboxId,
      email,
      name: name || null,
      shared: true,
    });
    const cid =
      typeof created === "string"
        ? created
        : (created as { id?: string } | null)?.id;
    return cid ?? null;
  } catch (e) {
    console.warn("booking ensureContact failed", e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fulfillment
// ---------------------------------------------------------------------------

export async function fulfillBooking(
  eventType: EventType,
  booking: Booking,
  calendars: EventTypeCalendar[],
  origin?: string,
): Promise<void> {
  const summary = `${eventType.name} with ${booking.inviteeName}`;
  const hostMailbox = await resolveHostMailbox(booking.hostUserId, calendars);

  // ---- conference link --------------------------------------------------
  let conferenceProvider: string | null = null;
  let conferenceUrl: string | null = null;
  if (
    eventType.conferencingType === "phone" ||
    eventType.conferencingType === "in_person" ||
    eventType.conferencingType === "custom_link"
  ) {
    conferenceProvider = eventType.conferencingType;
    conferenceUrl = eventType.conferencingConfig?.value ?? null;
  }

  // ---- write into every write_bookings calendar -------------------------
  // For Google Meet, reorder so a Google calendar runs first — the Meet link
  // is minted on that insert, then reused as the location on the rest.
  const writeCals = calendars.filter((c) => c.writeBookings);
  if (eventType.conferencingType === "google_meet") {
    const gi = writeCals.findIndex(
      (c) => c.sourceKind === "google" && c.calendarConnectionId,
    );
    if (gi > 0) {
      const [g] = writeCals.splice(gi, 1);
      writeCals.unshift(g);
    }
  }
  let meetMinted = false;

  for (const cal of writeCals) {
    try {
      const description = describeBooking(eventType, booking, conferenceUrl);
      if (cal.sourceKind === "orange_native") {
        const eventId = await createSelfEvent({
          userId: cal.orangeUserId ?? booking.hostUserId,
          mailboxId: cal.orangeMailboxId ?? null,
          startsAt: booking.startsAt,
          endsAt: booking.endsAt,
          allDay: false,
          summary,
          location: conferenceUrl,
          description,
          tz: eventType.timezone,
        });
        await addBookingCalendarEvent({
          bookingId: booking.id,
          sourceKind: "orange_native",
          orangeCalendarEventId: eventId,
        });
      } else if (cal.sourceKind === "google" && cal.calendarConnectionId) {
        const conn = await getCalendarConnection(cal.calendarConnectionId);
        if (!conn) continue;
        const wantMeet =
          eventType.conferencingType === "google_meet" && !meetMinted;
        const res = await insertGoogleEvent(conn, {
          summary,
          description,
          location: conferenceUrl ?? undefined,
          start: booking.startsAt,
          end: booking.endsAt,
          attendees: [booking.inviteeEmail],
          addMeet: wantMeet,
        });
        if (wantMeet && res.meetUrl) {
          conferenceUrl = res.meetUrl;
          conferenceProvider = "google_meet";
          meetMinted = true;
        }
        await addBookingCalendarEvent({
          bookingId: booking.id,
          sourceKind: "google",
          calendarConnectionId: conn.id,
          googleEventId: res.eventId,
        });
      }
    } catch (e) {
      console.error("booking calendar write failed", cal.id, e);
    }
  }

  if (conferenceProvider || conferenceUrl) {
    await setBookingConference(
      booking.id,
      conferenceProvider,
      conferenceUrl,
      null,
    );
  }

  // ---- contact link -----------------------------------------------------
  if (hostMailbox && !booking.contactId) {
    const cid = await ensureContact(
      booking.hostUserId,
      hostMailbox.mailboxId,
      booking.inviteeEmail,
      booking.inviteeName,
    );
    if (cid) await setBookingContact(booking.id, cid);
  }

  // ---- confirmation email ----------------------------------------------
  if (hostMailbox) {
    try {
      const ics = buildRequestIcs({
        uid: `booking-${booking.id}@orange-inbox`,
        dtstamp: nowSec(),
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
        allDay: false,
        summary,
        location: conferenceUrl,
        description: describeBooking(eventType, booking, conferenceUrl),
        organizer: hostMailbox.address,
        attendees: [{ email: booking.inviteeEmail, cn: booking.inviteeName }],
        sequence: 0,
        tz: eventType.timezone,
      });
      await sendCalendarInvite(booking.hostUserId, {
        fromMailboxId: hostMailbox.mailboxId,
        to: [booking.inviteeEmail],
        subject: `Confirmed: ${eventType.name}`,
        text: confirmationText(eventType, booking, conferenceUrl, origin),
        ics,
        method: "REQUEST",
      });
    } catch (e) {
      console.error("booking confirmation email failed", booking.id, e);
    }
  } else {
    console.warn(
      "booking confirmation skipped — host has no Orange mailbox",
      booking.id,
    );
  }

  // ---- reminders --------------------------------------------------------
  const t = nowSec();
  for (const offset of [24 * 3600, 3600]) {
    const remindAt = booking.startsAt - offset;
    if (remindAt > t + 60) {
      try {
        await addBookingReminder(booking.id, remindAt);
      } catch (e) {
        console.warn("addBookingReminder failed", e);
      }
    }
  }
}

function confirmationText(
  eventType: EventType,
  booking: Booking,
  conferenceUrl: string | null,
  origin?: string,
): string {
  const when = new Date(booking.startsAt * 1000).toUTCString();
  const lines = [
    `Hi ${booking.inviteeName},`,
    "",
    `Your booking for "${eventType.name}" is confirmed.`,
    `When: ${when} (${eventType.durationMinutes} min)`,
  ];
  if (conferenceUrl) lines.push(`Where: ${conferenceUrl}`);
  lines.push("", "A calendar invite is attached.");
  if (origin) {
    lines.push(
      "",
      `Reschedule: ${origin}/p/book/${eventType.slug}/reschedule/${booking.rescheduleToken}`,
      `Cancel: ${origin}/p/book/${eventType.slug}/cancel/${booking.cancelToken}`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export async function cancelBookingFulfillment(
  eventType: EventType,
  booking: Booking,
): Promise<void> {
  const summary = `${eventType.name} with ${booking.inviteeName}`;
  const events = await getBookingCalendarEvents(booking.id);
  for (const ev of events) {
    try {
      if (ev.sourceKind === "orange_native" && ev.orangeCalendarEventId) {
        await deleteSelfEvent(booking.hostUserId, ev.orangeCalendarEventId);
      } else if (
        ev.sourceKind === "google" &&
        ev.calendarConnectionId &&
        ev.googleEventId
      ) {
        const conn = await getCalendarConnection(ev.calendarConnectionId);
        if (conn) await deleteGoogleEvent(conn, ev.googleEventId);
      }
    } catch (e) {
      console.error("booking cancel — calendar delete failed", ev.id, e);
    }
  }
  await clearBookingReminders(booking.id);

  const hostMailbox = await resolveHostMailbox(booking.hostUserId, []);
  if (hostMailbox) {
    try {
      const ics = buildCancelIcs({
        uid: `booking-${booking.id}@orange-inbox`,
        dtstamp: nowSec(),
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
        allDay: false,
        summary,
        location: booking.conferenceUrl,
        description: null,
        organizer: hostMailbox.address,
        attendees: [{ email: booking.inviteeEmail, cn: booking.inviteeName }],
        sequence: 1,
        tz: eventType.timezone,
      });
      await sendCalendarInvite(booking.hostUserId, {
        fromMailboxId: hostMailbox.mailboxId,
        to: [booking.inviteeEmail],
        subject: `Cancelled: ${eventType.name}`,
        text: `Your booking for "${eventType.name}" has been cancelled.`,
        ics,
        method: "CANCEL",
      });
    } catch (e) {
      console.error("booking cancellation email failed", booking.id, e);
    }
  }
}

// ---------------------------------------------------------------------------
// Reschedule — move every calendar event the booking touched to the new time.
// ---------------------------------------------------------------------------

export async function rescheduleBookingFulfillment(
  eventType: EventType,
  booking: Booking,
  newStart: number,
  newEnd: number,
): Promise<void> {
  const events = await getBookingCalendarEvents(booking.id);
  for (const ev of events) {
    try {
      if (ev.sourceKind === "orange_native" && ev.orangeCalendarEventId) {
        await updateSelfEvent(booking.hostUserId, ev.orangeCalendarEventId, {
          startsAt: newStart,
          endsAt: newEnd,
        });
      } else if (
        ev.sourceKind === "google" &&
        ev.calendarConnectionId &&
        ev.googleEventId
      ) {
        const conn = await getCalendarConnection(ev.calendarConnectionId);
        if (conn) {
          await patchGoogleEvent(conn, ev.googleEventId, {
            start: newStart,
            end: newEnd,
          });
        }
      }
    } catch (e) {
      console.error("booking reschedule — calendar update failed", ev.id, e);
    }
  }
  await clearBookingReminders(booking.id);
  const t = nowSec();
  for (const offset of [24 * 3600, 3600]) {
    const remindAt = newStart - offset;
    if (remindAt > t + 60) {
      await addBookingReminder(booking.id, remindAt).catch(() => {});
    }
  }

  const hostMailbox = await resolveHostMailbox(booking.hostUserId, []);
  if (hostMailbox) {
    try {
      const summary = `${eventType.name} with ${booking.inviteeName}`;
      const ics = buildRequestIcs({
        uid: `booking-${booking.id}@orange-inbox`,
        dtstamp: nowSec(),
        startsAt: newStart,
        endsAt: newEnd,
        allDay: false,
        summary,
        location: booking.conferenceUrl,
        description: describeBooking(eventType, booking, booking.conferenceUrl),
        organizer: hostMailbox.address,
        attendees: [{ email: booking.inviteeEmail, cn: booking.inviteeName }],
        sequence: 1,
        tz: eventType.timezone,
      });
      await sendCalendarInvite(booking.hostUserId, {
        fromMailboxId: hostMailbox.mailboxId,
        to: [booking.inviteeEmail],
        subject: `Rescheduled: ${eventType.name}`,
        text: `Your booking for "${eventType.name}" has been moved. An updated invite is attached.`,
        ics,
        method: "REQUEST",
      });
    } catch (e) {
      console.error("booking reschedule email failed", booking.id, e);
    }
  }
}
