// RFC 5545 emitter for our calendar feed (#83).
//
// We only render outbound iCalendar; parsing of inbound `text/calendar` lives
// in the email-worker. The surface here is tight on purpose:
//
//   buildVEvent(row)     → string  // a single VEVENT block, CRLF-terminated.
//   buildVCalendar(rows) → string  // a full VCALENDAR wrapping N VEVENTs.
//
// Things RFC 5545 demands that callers tend to forget:
//
//   * CRLF line endings everywhere. LF-only feeds confuse Outlook.
//   * Lines >75 OCTETS (UTF-8 bytes, not characters) must be folded with a
//     CRLF + single space continuation. We fold by byte count.
//   * TEXT-typed properties (SUMMARY, LOCATION, DESCRIPTION) need `,`, `;`,
//     `\` and newlines escaped per §3.3.11.
//   * DATE-TIME values rendered as UTC with the `Z` suffix avoid the whole
//     VTIMEZONE rabbit hole.
//   * UID must be globally unique; we use the `id` column for self/imported
//     events, falling back to `<id>@<host>` if the row had no `ical_uid` —
//     the host suffix keeps it RFC-compliant even if a future iCalUID-aware
//     consumer dedupes across sources.

import type { CalendarEventRow } from "./calendar";

const PRODID = "-//Orange Inbox//Calendar 1.0//EN";

export interface BuildOptions {
  // Hostname used to qualify UIDs that don't already have an `@<domain>`. We
  // pass this in rather than reading headers here so the helper stays testable.
  uidDomain: string;
  // Calendar name shown in subscribers (Apple/Outlook/Google honour this).
  calendarName?: string;
}

export function buildVCalendar(
  rows: CalendarEventRow[],
  opts: BuildOptions,
): string {
  const lines: string[] = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push(`PRODID:${escapeText(PRODID)}`);
  lines.push("CALSCALE:GREGORIAN");
  lines.push("METHOD:PUBLISH");
  if (opts.calendarName) {
    lines.push(`X-WR-CALNAME:${escapeText(opts.calendarName)}`);
    // Microsoft and a few stragglers honour the X-MS-OLK variant; cheap to
    // add and harmless on consumers that ignore it.
    lines.push(`NAME:${escapeText(opts.calendarName)}`);
  }
  for (const row of rows) {
    lines.push(...buildVEventLines(row, opts));
  }
  lines.push("END:VCALENDAR");
  return foldAndJoin(lines);
}

// Build a VCALENDAR containing exactly one VEVENT — the per-event `.ics`
// download endpoint serves this shape.
export function buildSingleEventCalendar(
  row: CalendarEventRow,
  opts: BuildOptions,
): string {
  return buildVCalendar([row], opts);
}

// Public for tests / single-event composition. The full VCALENDAR helpers
// above are usually what callers want.
export function buildVEvent(row: CalendarEventRow, opts: BuildOptions): string {
  return foldAndJoin(buildVEventLines(row, opts));
}

function buildVEventLines(row: CalendarEventRow, opts: BuildOptions): string[] {
  const out: string[] = [];
  out.push("BEGIN:VEVENT");
  out.push(`UID:${escapeText(uidFor(row, opts.uidDomain))}`);
  out.push(`DTSTAMP:${formatUtc(row.updated_at ?? row.created_at ?? row.starts_at)}`);

  if (row.all_day === 1) {
    out.push(`DTSTART;VALUE=DATE:${formatDate(row.starts_at)}`);
    if (row.ends_at) {
      // RFC 5545: DTEND for all-day events is exclusive (the day AFTER the
      // last day). Calendars that produce inclusive end dates round-trip
      // correctly because we do the same on the read side.
      out.push(`DTEND;VALUE=DATE:${formatDate(row.ends_at)}`);
    }
  } else {
    out.push(`DTSTART:${formatUtc(row.starts_at)}`);
    if (row.ends_at) {
      out.push(`DTEND:${formatUtc(row.ends_at)}`);
    }
  }

  if (row.summary) out.push(`SUMMARY:${escapeText(row.summary)}`);
  if (row.location) out.push(`LOCATION:${escapeText(row.location)}`);
  if (row.description) out.push(`DESCRIPTION:${escapeText(row.description)}`);
  if (row.organizer_email) {
    // ORGANIZER is a CAL-ADDRESS (mailto: URI). Don't text-escape — colons
    // and slashes here are syntactic.
    out.push(`ORGANIZER:mailto:${row.organizer_email}`);
  }
  if (row.cancelled === 1) {
    out.push("STATUS:CANCELLED");
  } else {
    out.push("STATUS:CONFIRMED");
  }
  // Subscribers like Google poll periodically; SEQUENCE bumps so they
  // pick up edits. updated_at is monotonic-ish enough for our needs.
  out.push(`SEQUENCE:${Math.max(0, Math.floor((row.updated_at ?? 0) - (row.created_at ?? 0)))}`);
  out.push("END:VEVENT");
  return out;
}

function uidFor(row: CalendarEventRow, domain: string): string {
  if (row.ical_uid && row.ical_uid.includes("@")) return row.ical_uid;
  if (row.ical_uid) return `${row.ical_uid}@${domain}`;
  return `${row.id}@${domain}`;
}

// RFC 5545 §3.3.5: BASIC date-time in UTC is YYYYMMDDTHHMMSSZ.
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

// RFC 5545 §3.3.4: DATE form is YYYYMMDD (no T/timezone).
function formatDate(unix: number): string {
  const d = new Date(unix * 1000);
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

// RFC 5545 §3.3.11 — escape rules for TEXT-typed property values.
function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

// RFC 5545 §3.1: any line >75 octets must be folded. We fold per-line, then
// join with CRLF and append a trailing CRLF (§3.4 requires it).
function foldAndJoin(lines: string[]): string {
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

function foldLine(line: string): string {
  // 75 octets is the cap. Walk the UTF-8 byte length; CR/LF inside a property
  // value are already escaped above so we don't have to re-handle them.
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    // First chunk takes up to 75 bytes; continuation chunks take up to 74
    // because the leading SP burns one byte of the line budget.
    const cap = parts.length === 0 ? 75 : 74;
    let end = Math.min(i + cap, bytes.length);
    // Don't split mid-codepoint. UTF-8 continuation bytes start with 10xxxxxx.
    while (end > i && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
      end -= 1;
    }
    const chunk = decoder.decode(bytes.subarray(i, end));
    parts.push(parts.length === 0 ? chunk : ` ${chunk}`);
    i = end;
  }
  return parts.join("\r\n");
}
