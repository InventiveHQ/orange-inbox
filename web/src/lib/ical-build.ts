// RFC 5545 builder for outbound calendar invites (#81). Lean on the
// existing emitter in `ical.ts` for the PUBLISH / per-event download
// path; this file owns:
//
//   buildRequestIcs(...)  → METHOD=REQUEST VEVENT for new/updated invites
//   buildCancelIcs(...)   → METHOD=CANCEL VEVENT for deletes
//   buildReplyIcs(...)    → existing inline impl already lives in the rsvp
//                           route; not duplicated here.
//
// REQUEST/CANCEL must include ATTENDEE lines (ical.ts's PUBLISH path
// doesn't), so we ship a tiny dedicated builder rather than threading
// extra params through the existing emitter.
//
// Recurrence: when the event row carries an RRULE we emit it verbatim. We
// don't synthesise EXDATE / RDATE here — those round-trip via the
// calendar_events columns the same way RRULE does.
//
// Folding & escaping conventions match ical.ts: CRLF terminators, 75-byte
// line cap with continuation lines, RFC 5545 §3.3.11 TEXT escaping.

const PRODID = "-//Orange Inbox//Calendar 1.0//EN";

export interface AttendeeForInvite {
  email: string;
  // RFC 5545 ROLE — we default to REQ-PARTICIPANT when unset. PARTSTAT is
  // always NEEDS-ACTION on outbound REQUEST; recipients flip it via REPLY.
  role?: string | null;
  cn?: string | null;
}

export interface BuildRequestIcsArgs {
  uid: string;
  // unix seconds DTSTAMP — usually unixepoch() at send time. Required by
  // RFC 5545 §3.8.7.2 on every outbound VEVENT.
  dtstamp: number;
  startsAt: number;
  endsAt: number | null;
  allDay: boolean;
  summary: string | null;
  location: string | null;
  description: string | null;
  organizer: string;
  organizerName?: string | null;
  attendees: AttendeeForInvite[];
  // Monotonic SEQUENCE per RFC 5545 §3.8.7.4. Increments on every
  // ORGANIZER edit so external calendars know the REQUEST supersedes the
  // previous one. Caller derives this from updated_at - created_at on
  // the row (or 0 for the very first REQUEST).
  sequence: number;
  // RFC 5545 RRULE value, sans the "RRULE:" prefix. NULL = single-shot.
  rrule?: string | null;
  // IANA tz. Used for the X-WR-TIMEZONE hint on the calendar. We still
  // emit DTSTART/DTEND in UTC `Z` form so consumers without a VTIMEZONE
  // resolver get the right absolute time; a future pass can switch to
  // TZID-prefixed local-time emission.
  tz?: string | null;
}

export function buildRequestIcs(args: BuildRequestIcsArgs): string {
  return wrapCalendar(buildVEventLines(args, "REQUEST"), "REQUEST", args.tz ?? null);
}

export function buildCancelIcs(args: BuildRequestIcsArgs): string {
  return wrapCalendar(buildVEventLines(args, "CANCEL"), "CANCEL", args.tz ?? null);
}

function wrapCalendar(eventLines: string[], method: string, tz: string | null): string {
  const lines: string[] = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push(`PRODID:${escapeText(PRODID)}`);
  lines.push("CALSCALE:GREGORIAN");
  lines.push(`METHOD:${method}`);
  if (tz) lines.push(`X-WR-TIMEZONE:${escapeText(tz)}`);
  for (const l of eventLines) lines.push(l);
  lines.push("END:VCALENDAR");
  return foldAndJoin(lines);
}

function buildVEventLines(args: BuildRequestIcsArgs, method: string): string[] {
  const out: string[] = [];
  out.push("BEGIN:VEVENT");
  out.push(`UID:${escapeText(args.uid)}`);
  out.push(`DTSTAMP:${formatUtc(args.dtstamp)}`);
  if (args.allDay) {
    out.push(`DTSTART;VALUE=DATE:${formatDate(args.startsAt)}`);
    if (args.endsAt) out.push(`DTEND;VALUE=DATE:${formatDate(args.endsAt)}`);
  } else {
    out.push(`DTSTART:${formatUtc(args.startsAt)}`);
    if (args.endsAt) out.push(`DTEND:${formatUtc(args.endsAt)}`);
  }
  if (args.summary) out.push(`SUMMARY:${escapeText(args.summary)}`);
  if (args.location) out.push(`LOCATION:${escapeText(args.location)}`);
  if (args.description) out.push(`DESCRIPTION:${escapeText(args.description)}`);
  // ORGANIZER is a CAL-ADDRESS (mailto: URI) — colons and slashes are
  // syntactic, not values, so don't text-escape. CN= goes on the
  // parameter and IS quoted to allow commas/semicolons in display names.
  if (args.organizerName) {
    out.push(`ORGANIZER;CN=${quoteParam(args.organizerName)}:mailto:${args.organizer}`);
  } else {
    out.push(`ORGANIZER:mailto:${args.organizer}`);
  }
  for (const a of args.attendees) {
    const role = a.role || "REQ-PARTICIPANT";
    const partstat = method === "CANCEL" ? "DECLINED" : "NEEDS-ACTION";
    const cn = a.cn ? `;CN=${quoteParam(a.cn)}` : "";
    out.push(
      `ATTENDEE${cn};ROLE=${role};PARTSTAT=${partstat};RSVP=TRUE:mailto:${a.email}`,
    );
  }
  if (args.rrule && method === "REQUEST") {
    // RRULE: prefix is the property name; the value is the raw rule.
    out.push(`RRULE:${args.rrule}`);
  }
  if (method === "CANCEL") {
    out.push("STATUS:CANCELLED");
  } else {
    out.push("STATUS:CONFIRMED");
  }
  out.push(`SEQUENCE:${Math.max(0, Math.floor(args.sequence))}`);
  out.push("END:VEVENT");
  return out;
}

// ─── RRULE serializer ───────────────────────────────────────────────────
// Form-side helper: take a structured spec, emit the RFC 5545 RRULE
// string we round-trip into calendar_events.rrule. Inverse-lighter than
// a full parser — the form only emits a constrained subset.

export type RecurrenceSpec =
  | { freq: "NONE" }
  | {
      freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
      interval?: number;
      // WEEKLY-only. Two-letter uppercase MO/TU/.../SU.
      byday?: string[];
      // MONTHLY-only. 1..31 (we don't model BYSETPOS+BYDAY for v1).
      bymonthday?: number;
      // Optional COUNT or UNTIL — caller picks at most one. UNTIL is unix
      // seconds, serialised to YYYYMMDDTHHMMSSZ. COUNT is a positive int.
      count?: number;
      until?: number;
    };

export function serializeRRule(spec: RecurrenceSpec): string | null {
  if (spec.freq === "NONE") return null;
  const parts: string[] = [`FREQ=${spec.freq}`];
  if (spec.interval != null && spec.interval > 1) {
    parts.push(`INTERVAL=${Math.floor(spec.interval)}`);
  }
  if (spec.freq === "WEEKLY" && spec.byday && spec.byday.length > 0) {
    parts.push(`BYDAY=${spec.byday.map(s => s.toUpperCase()).join(",")}`);
  }
  if (spec.freq === "MONTHLY" && spec.bymonthday) {
    parts.push(`BYMONTHDAY=${Math.floor(spec.bymonthday)}`);
  }
  if (spec.until != null) {
    parts.push(`UNTIL=${formatUtc(spec.until)}`);
  } else if (spec.count != null && spec.count > 0) {
    parts.push(`COUNT=${Math.floor(spec.count)}`);
  }
  return parts.join(";");
}

// ─── Formatting / folding helpers — kept private to mirror ical.ts ─────
function formatUtc(unix: number): string {
  const d = new Date(unix * 1000);
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mi = d.getUTCMinutes().toString().padStart(2, "0");
  const ss = d.getUTCSeconds().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

function formatDate(unix: number): string {
  const d = new Date(unix * 1000);
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function quoteParam(s: string): string {
  // RFC 5545 §3.2: param values containing `,;:` must be DQUOTE-quoted.
  // A literal `"` inside a quoted value is forbidden — strip them.
  return `"${s.replace(/"/g, "")}"`;
}

function foldAndJoin(lines: string[]): string {
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

function foldLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const cap = parts.length === 0 ? 75 : 74;
    let end = Math.min(i + cap, bytes.length);
    while (end > i && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
      end -= 1;
    }
    const chunk = decoder.decode(bytes.subarray(i, end));
    parts.push(parts.length === 0 ? chunk : ` ${chunk}`);
    i = end;
  }
  return parts.join("\r\n");
}
