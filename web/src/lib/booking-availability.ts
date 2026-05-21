// Availability engine for meeting booking (orange-inbox#103, #111).
//
// Computes open slots as the INTERSECTION of free time across every
// check_availability calendar a booking link spans — Orange-native calendars
// (via the existing free/busy helpers) and Google calendars (via FreeBusy) —
// minus buffers, the notice window, the booking horizon, and already-confirmed
// bookings. A slot is offered only if it is free on all of them.

import {
  getBusyWindowsForUser,
  getMailboxBusyWindows,
  type BusyWindow,
} from "./calendar";
import {
  getCalendarConnection,
  listConfirmedBookingsInRange,
  type DateOverride,
  type EventType,
  type EventTypeCalendar,
} from "./booking";
import { getGoogleBusyWindows } from "./google-calendar";

export interface Slot {
  start: number; // unix seconds
  end: number;
}

// ---------------------------------------------------------------------------
// Timezone helpers — Intl.DateTimeFormat resolves IANA offsets (incl. DST)
// without pulling in a tzdb dependency.
// ---------------------------------------------------------------------------

interface TzParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsInTz(epochSec: number, tz: string): TzParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(epochSec * 1000))) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    year: +map.year,
    month: +map.month,
    day: +map.day,
    hour: +map.hour % 24,
    minute: +map.minute,
    second: +map.second,
  };
}

// Offset (ms) of `tz` from UTC at the given UTC instant.
function tzOffsetMs(utcMs: number, tz: string): number {
  const p = partsInTz(Math.floor(utcMs / 1000), tz);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - utcMs;
}

// Convert a wall-clock time in `tz` to a UTC epoch (seconds).
function zonedToEpoch(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  tz: string,
): number {
  const guessUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
  let offset = tzOffsetMs(guessUtc, tz);
  // One correction pass handles all but the rarest DST-gap edge cases.
  offset = tzOffsetMs(guessUtc - offset, tz);
  return Math.floor((guessUtc - offset) / 1000);
}

function parseHHMM(s: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s ?? "").trim());
  if (!m) return null;
  const h = +m[1];
  const mi = +m[2];
  if (h < 0 || h > 24 || mi < 0 || mi > 59) return null;
  return { h, m: mi };
}

function overlaps(aS: number, aE: number, bS: number, bE: number): boolean {
  return aS < bE && bS < aE;
}

// ---------------------------------------------------------------------------
// Busy-window collection
// ---------------------------------------------------------------------------

// Gather busy windows across every check_availability calendar plus existing
// confirmed bookings. Fails closed: a calendar we cannot read throws, so we
// never offer a slot we could not verify as free.
async function collectBusy(
  eventType: EventType,
  calendars: EventTypeCalendar[],
  rangeFrom: number,
  rangeTo: number,
): Promise<BusyWindow[]> {
  const busy: BusyWindow[] = [];
  for (const cal of calendars) {
    if (!cal.checkAvailability) continue;
    try {
      if (cal.sourceKind === "orange_native") {
        if (cal.orangeMailboxId) {
          busy.push(
            ...(await getMailboxBusyWindows(cal.orangeMailboxId, rangeFrom, rangeTo)),
          );
        } else if (cal.orangeUserId) {
          busy.push(
            ...(await getBusyWindowsForUser(cal.orangeUserId, rangeFrom, rangeTo)),
          );
        }
      } else if (cal.sourceKind === "google" && cal.calendarConnectionId) {
        const conn = await getCalendarConnection(cal.calendarConnectionId);
        if (conn && conn.status !== "revoked") {
          busy.push(...(await getGoogleBusyWindows(conn, rangeFrom, rangeTo)));
        }
      }
    } catch (e) {
      throw new Error(
        `could not read calendar ${cal.id}: ${(e as Error)?.message ?? e}`,
      );
    }
  }
  for (const b of await listConfirmedBookingsInRange(
    eventType.id,
    rangeFrom,
    rangeTo,
  )) {
    busy.push({ start: b.startsAt, end: b.endsAt });
  }
  return busy;
}

// ---------------------------------------------------------------------------
// Slot computation
// ---------------------------------------------------------------------------

export async function computeAvailableSlots(
  eventType: EventType,
  calendars: EventTypeCalendar[],
  overrides: DateOverride[],
  rangeFrom: number,
  rangeTo: number,
): Promise<Slot[]> {
  const tz = eventType.timezone;
  const nowSec = Math.floor(Date.now() / 1000);
  const earliest = Math.max(rangeFrom, nowSec + eventType.minNoticeMinutes * 60);
  const windowEnd = Math.min(
    rangeTo,
    nowSec + eventType.bookingWindowDays * 86400,
  );
  if (earliest >= windowEnd) return [];

  const busy = await collectBusy(eventType, calendars, rangeFrom, rangeTo);

  const overrideByDate = new Map(overrides.map((o) => [o.date, o]));
  const durSec = eventType.durationMinutes * 60;
  const stepSec = Math.max(eventType.slotIntervalMinutes, 5) * 60;
  const bufBefore = eventType.bufferBeforeMinutes * 60;
  const bufAfter = eventType.bufferAfterMinutes * 60;

  // Iterate calendar days in the event type's timezone. The cursor is a pure
  // Y/M/D counter in UTC space (always 24h steps — no DST drift); weekday is
  // tz-independent for a given calendar date.
  const sp = partsInTz(rangeFrom, tz);
  const ep = partsInTz(rangeTo, tz);
  let cursor = Date.UTC(sp.year, sp.month - 1, sp.day);
  const lastCursor = Date.UTC(ep.year, ep.month - 1, ep.day);

  const slots: Slot[] = [];
  let guard = 0;
  while (cursor <= lastCursor && guard++ < 800) {
    const cd = new Date(cursor);
    const y = cd.getUTCFullYear();
    const mo = cd.getUTCMonth() + 1;
    const d = cd.getUTCDate();
    const weekday = cd.getUTCDay(); // 0 = Sunday
    const dateStr = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    cursor += 86400000;

    let windows: { start: string; end: string }[];
    const ov = overrideByDate.get(dateStr);
    if (ov) {
      if (!ov.available) continue;
      windows = ov.ranges;
    } else {
      windows = eventType.availability
        .filter((r) => r.day === weekday)
        .map((r) => ({ start: r.start, end: r.end }));
    }
    if (windows.length === 0) continue;

    for (const w of windows) {
      const ps = parseHHMM(w.start);
      const pe = parseHHMM(w.end);
      if (!ps || !pe) continue;
      const winStart = zonedToEpoch(y, mo, d, ps.h, ps.m, tz);
      const winEnd = zonedToEpoch(y, mo, d, pe.h, pe.m, tz);
      for (let s = winStart; s + durSec <= winEnd; s += stepSec) {
        const e = s + durSec;
        if (s < earliest || s >= windowEnd) continue;
        const blockStart = s - bufBefore;
        const blockEnd = e + bufAfter;
        let free = true;
        for (const bw of busy) {
          if (overlaps(blockStart, blockEnd, bw.start, bw.end)) {
            free = false;
            break;
          }
        }
        if (free) slots.push({ start: s, end: e });
      }
    }
  }
  slots.sort((a, b) => a.start - b.start);
  return slots;
}

// Race-safe single-slot check used at booking commit. Recomputes the day's
// slots and requires an exact start/end match.
export async function isSlotAvailable(
  eventType: EventType,
  calendars: EventTypeCalendar[],
  overrides: DateOverride[],
  start: number,
): Promise<boolean> {
  const end = start + eventType.durationMinutes * 60;
  const slots = await computeAvailableSlots(
    eventType,
    calendars,
    overrides,
    start - 86400,
    end + 86400,
  );
  return slots.some((sl) => sl.start === start && sl.end === end);
}
