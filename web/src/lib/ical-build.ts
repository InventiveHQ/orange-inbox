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
// Time-zones (#94): when the event row has a non-NULL `tz` AND we have a
// VTIMEZONE rule for it, we emit DTSTART/DTEND with `TZID=<iana>` and a
// local-time value (no `Z`), plus a VTIMEZONE component at the top of the
// VCALENDAR. Apple Calendar and Outlook honour TZID+VTIMEZONE; Google
// Calendar accepts either form. Floating events (`tz` NULL) and
// unrecognised zones fall back to the historical UTC `Z` form so we never
// emit an invite a recipient can't decode.
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
  // IANA tz. When set AND we have a VTIMEZONE rule for the zone, we emit
  // DTSTART/DTEND with `TZID=<iana>` plus a local-time value (no `Z`) and
  // a VTIMEZONE component at the top of the VCALENDAR. When NULL or the
  // zone isn't in our table, we fall back to UTC `Z` emission and the
  // X-WR-TIMEZONE hint — the same shape the pre-#94 emitter used.
  tz?: string | null;
}

export function buildRequestIcs(args: BuildRequestIcsArgs): string {
  return wrapCalendar(args, "REQUEST");
}

export function buildCancelIcs(args: BuildRequestIcsArgs): string {
  return wrapCalendar(args, "CANCEL");
}

function wrapCalendar(args: BuildRequestIcsArgs, method: string): string {
  const tz = args.tz ?? null;
  // All-day events use VALUE=DATE — VTIMEZONE doesn't apply (RFC 5545
  // §3.3.4 / §3.6.5). Likewise floating events stamp UTC.
  const tzData = tz && !args.allDay ? TZ_DATA[tz] : null;
  const lines: string[] = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push(`PRODID:${escapeText(PRODID)}`);
  lines.push("CALSCALE:GREGORIAN");
  lines.push(`METHOD:${method}`);
  if (tz) lines.push(`X-WR-TIMEZONE:${escapeText(tz)}`);
  if (tzData) {
    for (const l of buildVTimezoneLines(tz!, tzData)) lines.push(l);
  }
  for (const l of buildVEventLines(args, method, tzData ? tz : null)) lines.push(l);
  lines.push("END:VCALENDAR");
  return foldAndJoin(lines);
}

// `effectiveTz` is the zone we're committing to TZID+local-time emission
// for. NULL means "fall back to UTC `Z`" — either floating, all-day, or a
// zone we don't have VTIMEZONE rules for.
function buildVEventLines(
  args: BuildRequestIcsArgs,
  method: string,
  effectiveTz: string | null,
): string[] {
  const out: string[] = [];
  out.push("BEGIN:VEVENT");
  out.push(`UID:${escapeText(args.uid)}`);
  out.push(`DTSTAMP:${formatUtc(args.dtstamp)}`);
  if (args.allDay) {
    out.push(`DTSTART;VALUE=DATE:${formatDate(args.startsAt)}`);
    if (args.endsAt) out.push(`DTEND;VALUE=DATE:${formatDate(args.endsAt)}`);
  } else if (effectiveTz) {
    // RFC 5545 §3.3.5: TZID parameter on DTSTART/DTEND with a local-time
    // value (no `Z`). The local time is the wall-clock at the event's
    // zone — Intl.DateTimeFormat resolves the offset including DST.
    out.push(`DTSTART;TZID=${effectiveTz}:${formatLocalInTz(args.startsAt, effectiveTz)}`);
    if (args.endsAt) {
      out.push(`DTEND;TZID=${effectiveTz}:${formatLocalInTz(args.endsAt, effectiveTz)}`);
    }
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

// ─── VTIMEZONE emission (#94) ──────────────────────────────────────────
//
// We hand-roll a VTIMEZONE table for the ~50 most common IANA zones rather
// than pull in a tzdb dependency. The runtime uses Intl.DateTimeFormat
// (available in Cloudflare Workers since the V8 update) for local-time
// formatting, which already knows every IANA zone — but VTIMEZONE blocks
// have to specify the DST RRULE up front, which Intl can't synthesise. So
// the table below covers the important zones; anything else falls back to
// UTC `Z` emission so we never ship a broken invite.
//
// Each entry is one of:
//   - { kind: "fixed", offset: ±minutes, abbrev }            no-DST zones
//   - { kind: "dst", standard: {...}, daylight: {...} }      with DST
//
// The DST sub-rules carry:
//   - month (1-12), day-of-week (0=Sun..6=Sat), nth (1..5; 5 = last)
//   - hour (local hour at which the transition fires)
//   - offset (minutes from UTC after the transition)
//   - abbrev (TZNAME)
//
// `dtstart` for each STANDARD/DAYLIGHT subcomponent uses a synthetic year
// (1970) — RFC 5545 only requires DTSTART to be the first instance of the
// rule, and clients walk the RRULE forward from there. The synthetic year
// keeps the table tiny.

interface FixedTzEntry {
  kind: "fixed";
  offset: number;       // minutes from UTC
  abbrev: string;
}

interface DstRule {
  month: number;        // 1..12
  byday: string;        // RFC 5545 BYDAY value, e.g. "2SU" (2nd Sun) or "-1SU"
  hour: number;         // local hour the transition fires
  offset: number;       // minutes from UTC AFTER the transition
  abbrev: string;
}

interface DstTzEntry {
  kind: "dst";
  standard: DstRule;    // when DST ends → STANDARD
  daylight: DstRule;    // when DST starts → DAYLIGHT
}

type TzEntry = FixedTzEntry | DstTzEntry;

// Common North-American DST: 2nd Sun in March (start) → 1st Sun in
// November (end), at 02:00 local. This is the post-2007 US/Canada rule.
function naDst(stdOffset: number, dstOffset: number, stdAbbrev: string, dstAbbrev: string): DstTzEntry {
  return {
    kind: "dst",
    standard: { month: 11, byday: "1SU", hour: 2, offset: stdOffset, abbrev: stdAbbrev },
    daylight: { month: 3,  byday: "2SU", hour: 2, offset: dstOffset, abbrev: dstAbbrev },
  };
}

// Common European DST: last Sun in March (start at 01:00 UTC = 02:00 CET)
// → last Sun in October (end at 01:00 UTC = 03:00 CEST). VTIMEZONE
// expresses transitions in local time at the moment of transition.
function euDst(stdOffset: number, dstOffset: number, stdAbbrev: string, dstAbbrev: string): DstTzEntry {
  return {
    kind: "dst",
    standard: { month: 10, byday: "-1SU", hour: 3, offset: stdOffset, abbrev: stdAbbrev },
    daylight: { month: 3,  byday: "-1SU", hour: 2, offset: dstOffset, abbrev: dstAbbrev },
  };
}

// Australia/NZ DST: starts 1st Sun Oct, ends 1st Sun Apr (local 02:00→03:00
// for AEDT/NZDT etc.). Entries below cover the common Aus/NZ zones.
function auDst(stdOffset: number, dstOffset: number, stdAbbrev: string, dstAbbrev: string): DstTzEntry {
  return {
    kind: "dst",
    standard: { month: 4,  byday: "1SU", hour: 3, offset: stdOffset, abbrev: stdAbbrev },
    daylight: { month: 10, byday: "1SU", hour: 2, offset: dstOffset, abbrev: dstAbbrev },
  };
}

const TZ_DATA: Record<string, TzEntry> = {
  // ── North America ────────────────────────────────────────────────────
  "America/New_York":     naDst(-300, -240, "EST",  "EDT"),
  "America/Detroit":      naDst(-300, -240, "EST",  "EDT"),
  "America/Toronto":      naDst(-300, -240, "EST",  "EDT"),
  "America/Chicago":      naDst(-360, -300, "CST",  "CDT"),
  "America/Mexico_City":  { kind: "fixed", offset: -360, abbrev: "CST" },
  "America/Denver":       naDst(-420, -360, "MST",  "MDT"),
  "America/Edmonton":     naDst(-420, -360, "MST",  "MDT"),
  "America/Phoenix":      { kind: "fixed", offset: -420, abbrev: "MST" },
  "America/Los_Angeles":  naDst(-480, -420, "PST",  "PDT"),
  "America/Vancouver":    naDst(-480, -420, "PST",  "PDT"),
  "America/Anchorage":    naDst(-540, -480, "AKST", "AKDT"),
  "America/Halifax":      naDst(-240, -180, "AST",  "ADT"),
  "America/St_Johns":     {
    // Newfoundland is the oddball: -3:30 / -2:30, same NA-DST rule.
    kind: "dst",
    standard: { month: 11, byday: "1SU", hour: 2, offset: -210, abbrev: "NST" },
    daylight: { month: 3,  byday: "2SU", hour: 2, offset: -150, abbrev: "NDT" },
  },
  "America/Sao_Paulo":    { kind: "fixed", offset: -180, abbrev: "BRT" },
  "America/Argentina/Buenos_Aires": { kind: "fixed", offset: -180, abbrev: "ART" },
  "America/Bogota":       { kind: "fixed", offset: -300, abbrev: "COT" },
  "America/Lima":         { kind: "fixed", offset: -300, abbrev: "PET" },
  "America/Santiago":     { kind: "fixed", offset: -240, abbrev: "CLT" },

  // ── Pacific ─────────────────────────────────────────────────────────
  "Pacific/Honolulu":     { kind: "fixed", offset: -600, abbrev: "HST" },
  "Pacific/Auckland":     {
    kind: "dst",
    standard: { month: 4,  byday: "1SU", hour: 3, offset: 720, abbrev: "NZST" },
    daylight: { month: 9,  byday: "-1SU", hour: 2, offset: 780, abbrev: "NZDT" },
  },
  "Pacific/Fiji":         { kind: "fixed", offset: 720, abbrev: "FJT" },

  // ── Europe ───────────────────────────────────────────────────────────
  "Europe/London":        euDst(0,    60,  "GMT", "BST"),
  "Europe/Dublin":        euDst(0,    60,  "GMT", "IST"),
  "Europe/Lisbon":        euDst(0,    60,  "WET", "WEST"),
  "Europe/Paris":         euDst(60,   120, "CET", "CEST"),
  "Europe/Berlin":        euDst(60,   120, "CET", "CEST"),
  "Europe/Madrid":        euDst(60,   120, "CET", "CEST"),
  "Europe/Rome":          euDst(60,   120, "CET", "CEST"),
  "Europe/Amsterdam":     euDst(60,   120, "CET", "CEST"),
  "Europe/Brussels":      euDst(60,   120, "CET", "CEST"),
  "Europe/Vienna":        euDst(60,   120, "CET", "CEST"),
  "Europe/Zurich":        euDst(60,   120, "CET", "CEST"),
  "Europe/Stockholm":     euDst(60,   120, "CET", "CEST"),
  "Europe/Copenhagen":    euDst(60,   120, "CET", "CEST"),
  "Europe/Oslo":          euDst(60,   120, "CET", "CEST"),
  "Europe/Warsaw":        euDst(60,   120, "CET", "CEST"),
  "Europe/Prague":        euDst(60,   120, "CET", "CEST"),
  "Europe/Athens":        euDst(120,  180, "EET", "EEST"),
  "Europe/Helsinki":      euDst(120,  180, "EET", "EEST"),
  "Europe/Bucharest":     euDst(120,  180, "EET", "EEST"),
  "Europe/Istanbul":      { kind: "fixed", offset: 180, abbrev: "TRT" },
  "Europe/Moscow":        { kind: "fixed", offset: 180, abbrev: "MSK" },

  // ── Asia ─────────────────────────────────────────────────────────────
  "Asia/Dubai":           { kind: "fixed", offset: 240,  abbrev: "GST" },
  "Asia/Tehran":          { kind: "fixed", offset: 210,  abbrev: "IRST" },
  "Asia/Karachi":         { kind: "fixed", offset: 300,  abbrev: "PKT" },
  "Asia/Kolkata":         { kind: "fixed", offset: 330,  abbrev: "IST" },
  "Asia/Calcutta":        { kind: "fixed", offset: 330,  abbrev: "IST" },
  "Asia/Dhaka":           { kind: "fixed", offset: 360,  abbrev: "BST" },
  "Asia/Bangkok":         { kind: "fixed", offset: 420,  abbrev: "ICT" },
  "Asia/Jakarta":         { kind: "fixed", offset: 420,  abbrev: "WIB" },
  "Asia/Singapore":       { kind: "fixed", offset: 480,  abbrev: "SGT" },
  "Asia/Kuala_Lumpur":    { kind: "fixed", offset: 480,  abbrev: "MYT" },
  "Asia/Manila":          { kind: "fixed", offset: 480,  abbrev: "PHT" },
  "Asia/Shanghai":        { kind: "fixed", offset: 480,  abbrev: "CST" },
  "Asia/Hong_Kong":       { kind: "fixed", offset: 480,  abbrev: "HKT" },
  "Asia/Taipei":          { kind: "fixed", offset: 480,  abbrev: "CST" },
  "Asia/Seoul":           { kind: "fixed", offset: 540,  abbrev: "KST" },
  "Asia/Tokyo":           { kind: "fixed", offset: 540,  abbrev: "JST" },

  // ── Africa ───────────────────────────────────────────────────────────
  "Africa/Cairo":         { kind: "fixed", offset: 120, abbrev: "EET" },
  "Africa/Lagos":         { kind: "fixed", offset: 60,  abbrev: "WAT" },
  "Africa/Johannesburg":  { kind: "fixed", offset: 120, abbrev: "SAST" },
  "Africa/Nairobi":       { kind: "fixed", offset: 180, abbrev: "EAT" },

  // ── Australia ────────────────────────────────────────────────────────
  "Australia/Perth":      { kind: "fixed", offset: 480, abbrev: "AWST" },
  "Australia/Adelaide":   auDst(570, 630, "ACST", "ACDT"),
  "Australia/Darwin":     { kind: "fixed", offset: 570, abbrev: "ACST" },
  "Australia/Brisbane":   { kind: "fixed", offset: 600, abbrev: "AEST" },
  "Australia/Sydney":     auDst(600, 660, "AEST", "AEDT"),
  "Australia/Melbourne":  auDst(600, 660, "AEST", "AEDT"),
  "Australia/Hobart":     auDst(600, 660, "AEST", "AEDT"),

  // ── UTC alias ────────────────────────────────────────────────────────
  "UTC":                  { kind: "fixed", offset: 0, abbrev: "UTC" },
  "Etc/UTC":              { kind: "fixed", offset: 0, abbrev: "UTC" },
};

// Format ±HHMM. RFC 5545 §3.3.14: leading sign, four digits, no colon.
function formatTzOffset(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const hh = Math.floor(abs / 60).toString().padStart(2, "0");
  const mm = (abs % 60).toString().padStart(2, "0");
  return `${sign}${hh}${mm}`;
}

// Format the BYDAY descriptor's first occurrence in 1970 as a synthetic
// DTSTART. e.g. month=3, byday="2SU" (2nd Sunday of March) → 19700308.
// nth=-1 means "last <DOW> of the month".
function firstInstanceOfRule(rule: DstRule, year: number): { y: number; m: number; d: number } {
  const dow = parseDow(rule.byday);
  const nth = parseNth(rule.byday);
  const lastDayOfMonth = new Date(Date.UTC(year, rule.month, 0)).getUTCDate();
  if (nth > 0) {
    // n-th occurrence: find the first matching DOW, then add 7*(nth-1).
    const first = new Date(Date.UTC(year, rule.month - 1, 1));
    const firstDow = first.getUTCDay();
    const offset = (dow - firstDow + 7) % 7;
    const day = 1 + offset + (nth - 1) * 7;
    return { y: year, m: rule.month, d: day };
  } else {
    // -1 = last <DOW> of the month. Walk back from the last day.
    const last = new Date(Date.UTC(year, rule.month - 1, lastDayOfMonth));
    const lastDow = last.getUTCDay();
    const back = (lastDow - dow + 7) % 7;
    return { y: year, m: rule.month, d: lastDayOfMonth - back };
  }
}

function parseDow(byday: string): number {
  const code = byday.slice(-2);
  switch (code) {
    case "SU": return 0;
    case "MO": return 1;
    case "TU": return 2;
    case "WE": return 3;
    case "TH": return 4;
    case "FR": return 5;
    case "SA": return 6;
    default: return 0;
  }
}

function parseNth(byday: string): number {
  // Strip the trailing 2-letter DOW code; what remains is the (possibly
  // signed) ordinal — empty string == 1st, "-1" == last.
  const head = byday.slice(0, -2);
  if (head === "" || head === "+") return 1;
  return Number(head);
}

function buildVTimezoneLines(tz: string, entry: TzEntry): string[] {
  const out: string[] = [];
  out.push("BEGIN:VTIMEZONE");
  out.push(`TZID:${tz}`);
  if (entry.kind === "fixed") {
    out.push("BEGIN:STANDARD");
    // RFC 5545 §3.6.5: STANDARD/DAYLIGHT need DTSTART, TZOFFSETFROM,
    // TZOFFSETTO, TZNAME. With no transitions, both FROM and TO are the
    // fixed offset; the synthetic 1970 anchor is fine.
    out.push("DTSTART:19700101T000000");
    out.push(`TZOFFSETFROM:${formatTzOffset(entry.offset)}`);
    out.push(`TZOFFSETTO:${formatTzOffset(entry.offset)}`);
    out.push(`TZNAME:${entry.abbrev}`);
    out.push("END:STANDARD");
  } else {
    // For DST zones we emit two subcomponents, each with a yearly RRULE
    // expressing the transition. TZOFFSETFROM is the offset BEFORE the
    // transition; TZOFFSETTO is AFTER. The DTSTART local-time anchor is
    // the moment of transition in the FROM offset.
    const std = entry.standard;
    const dst = entry.daylight;
    const stdInst = firstInstanceOfRule(std, 1970);
    const dstInst = firstInstanceOfRule(dst, 1970);

    // STANDARD: transition from DAYLIGHT → STANDARD. FROM = dst.offset,
    // TO = std.offset.
    out.push("BEGIN:STANDARD");
    out.push(
      `DTSTART:${pad4(stdInst.y)}${pad2(stdInst.m)}${pad2(stdInst.d)}T${pad2(std.hour)}0000`,
    );
    out.push(`RRULE:FREQ=YEARLY;BYMONTH=${std.month};BYDAY=${std.byday}`);
    out.push(`TZOFFSETFROM:${formatTzOffset(dst.offset)}`);
    out.push(`TZOFFSETTO:${formatTzOffset(std.offset)}`);
    out.push(`TZNAME:${std.abbrev}`);
    out.push("END:STANDARD");

    // DAYLIGHT: transition from STANDARD → DAYLIGHT. FROM = std.offset,
    // TO = dst.offset.
    out.push("BEGIN:DAYLIGHT");
    out.push(
      `DTSTART:${pad4(dstInst.y)}${pad2(dstInst.m)}${pad2(dstInst.d)}T${pad2(dst.hour)}0000`,
    );
    out.push(`RRULE:FREQ=YEARLY;BYMONTH=${dst.month};BYDAY=${dst.byday}`);
    out.push(`TZOFFSETFROM:${formatTzOffset(std.offset)}`);
    out.push(`TZOFFSETTO:${formatTzOffset(dst.offset)}`);
    out.push(`TZNAME:${dst.abbrev}`);
    out.push("END:DAYLIGHT");
  }
  out.push("END:VTIMEZONE");
  return out;
}

function pad2(n: number): string { return n.toString().padStart(2, "0"); }
function pad4(n: number): string { return n.toString().padStart(4, "0"); }

// Format a unix timestamp as YYYYMMDDTHHMMSS in the named IANA zone (no
// `Z` — this is a local-time form for use with TZID parameters). Uses
// Intl.DateTimeFormat to do the wall-clock projection; supported on V8
// runtimes including Cloudflare Workers.
function formatLocalInTz(unix: number, tz: string): string {
  const d = new Date(unix * 1000);
  // `en-CA` happens to format as `YYYY-MM-DD, HH:MM:SS` with hour12=false,
  // which is the closest stable shape across V8 builds. We strip the
  // separators and assemble the basic-form datetime.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "00";
  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  let hh = get("hour");
  // Some V8 versions render midnight as "24" with hour12=false — normalise.
  if (hh === "24") hh = "00";
  const mi = get("minute");
  const ss = get("second");
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}`;
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
