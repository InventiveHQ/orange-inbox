// Minimal RFC 5545 parser — just enough to render an inline calendar card
// and reply with a `method=REPLY` PARTSTAT update. We deliberately skip:
//
//   - Recurrence (RRULE / RDATE / EXDATE / EXRULE) — we'd need a full
//     expander to surface anything sensible in the UI.
//   - VTIMEZONE blocks — we trust whatever absolute UTC the sender stamped
//     and fall back to the local-time interpretation otherwise. A future
//     pass can resolve TZID against the bundled VTIMEZONE component.
//   - VTODO / VJOURNAL / VFREEBUSY — only VEVENT is rendered.
//   - ATTENDEE list parsing — RSVP composes against ORGANIZER, since v1
//     just sends a single REPLY back to the inviter.
//
// Tolerant of the most common date formats:
//   - YYYYMMDD                — DATE (all-day)
//   - YYYYMMDDTHHMMSS         — local-time DATE-TIME (treated as UTC when
//                               no TZID is present; close enough for v1)
//   - YYYYMMDDTHHMMSSZ        — UTC DATE-TIME (canonical)
//   - With TZID prefix        — TZID:America/Los_Angeles:YYYYMMDDTHHMMSS
//                               (we strip the prefix and parse the value)

export interface ParsedIcs {
  startsAt: number;            // unix seconds
  endsAt: number | null;       // unix seconds; null when DTEND is missing
  summary: string | null;
  location: string | null;
  organizer: string | null;    // bare email, lowercased
  uid: string | null;
  method: string | null;       // REQUEST | CANCEL | REPLY | PUBLISH | …
  // Recurrence (#80). RFC 5545 RRULE value sans the "RRULE:" prefix.
  // NULL when the event isn't recurring; a non-null value is stored
  // verbatim and passed through to calendar_events.rrule on promotion.
  rrule: string | null;
  // IANA tz lifted from DTSTART;TZID= (#82). Falls back to NULL when
  // the value is UTC (`Z` suffix) or floating. Stored separately from
  // startsAt so the display side can render in the inviter's intended
  // zone independent of where DTSTART resolves on the wire.
  tz: string | null;
  // Inbound REPLY routing (#81). The first ATTENDEE we find in a
  // METHOD=REPLY VEVENT — its mailto + PARTSTAT drive
  // updateAttendeeRsvp on the web side. NULL on REQUEST/CANCEL.
  replyAttendee: string | null;
  replyPartstat: "ACCEPTED" | "TENTATIVE" | "DECLINED" | "NEEDS-ACTION" | null;
}

export function parseIcs(raw: string): ParsedIcs | null {
  const lines = unfold(raw);

  // Walk the property list, capturing METHOD at the calendar level and the
  // first VEVENT block we find. Most invites have exactly one VEVENT; if
  // there are multiple (recurring exceptions, multiple events shipped in a
  // single component) we surface the first — fine for the inline card.
  //
  // ATTENDEE lines are special: a single VEVENT can carry several. We
  // collect them on a separate list so the REPLY-routing path (#81) can
  // walk them; the rest of the props use the first-occurrence Map below.
  let method: string | null = null;
  let event: Map<string, IcsValue> | null = null;
  let eventAttendees: IcsValue[] = [];
  let current: Map<string, IcsValue> | null = null;
  let currentAttendees: IcsValue[] = [];
  let depth = 0; // 0 = top-level, 1 = inside VEVENT (or anything we entered)

  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const { name, params, value } = parsed;
    const upper = name.toUpperCase();

    if (upper === "BEGIN") {
      const block = value.toUpperCase();
      if (block === "VEVENT" && current === null) {
        current = new Map();
        currentAttendees = [];
      }
      depth += 1;
      continue;
    }
    if (upper === "END") {
      depth -= 1;
      const block = value.toUpperCase();
      if (block === "VEVENT" && current !== null) {
        if (event === null) {
          event = current;
          eventAttendees = currentAttendees;
        }
        current = null;
        currentAttendees = [];
      }
      continue;
    }

    // Top-level METHOD lives outside the VEVENT.
    if (depth === 0 && upper === "METHOD") {
      method = value.toUpperCase().trim() || null;
      continue;
    }

    if (current) {
      if (upper === "ATTENDEE") {
        currentAttendees.push({ params, value });
        continue;
      }
      // Capture event-scoped properties. We keep the first occurrence —
      // duplicate DTSTART/DTEND would be malformed anyway.
      if (!current.has(upper)) {
        current.set(upper, { params, value });
      }
    }
  }

  if (!event) return null;

  const dtstart = event.get("DTSTART");
  if (!dtstart) return null;

  const startsAt = parseDateValue(dtstart);
  if (startsAt === null) return null;

  const dtend = event.get("DTEND");
  const endsAt = dtend ? parseDateValue(dtend) : null;

  // RRULE: stored verbatim sans the "RRULE:" prefix (the prefix never
  // makes it past parseLine).
  const rruleVal = event.get("RRULE");
  const rrule = rruleVal ? rruleVal.value.trim() || null : null;

  // TZID: lifted off DTSTART's params if present. We deliberately don't
  // try to resolve VTIMEZONE blocks here — the IANA name in TZID is
  // what we surface to the user; the wire startsAt was already converted
  // to unix seconds via parseDateValue (with the floating-time fallback
  // documented at the top of this file).
  const tz = dtstart.params.TZID || null;

  // REPLY routing: if METHOD=REPLY, surface the first ATTENDEE's mailto
  // and PARTSTAT so updateAttendeeRsvp can flip the matching row. We pick
  // the first attendee — RFC 5546 §3.2.3 says a REPLY carries exactly the
  // responding attendee's row, so "first" is "the one we care about".
  let replyAttendee: string | null = null;
  let replyPartstat: ParsedIcs["replyPartstat"] = null;
  if ((method ?? "").toUpperCase() === "REPLY" && eventAttendees.length > 0) {
    const first = eventAttendees[0];
    const raw = first.value.trim();
    const mail = raw.toLowerCase().startsWith("mailto:") ? raw.slice(7) : raw;
    replyAttendee = mail.trim().toLowerCase() || null;
    const partstat = (first.params.PARTSTAT || "").toUpperCase();
    if (
      partstat === "ACCEPTED" ||
      partstat === "TENTATIVE" ||
      partstat === "DECLINED" ||
      partstat === "NEEDS-ACTION"
    ) {
      replyPartstat = partstat;
    }
  }

  return {
    startsAt,
    endsAt,
    summary: textValue(event.get("SUMMARY")),
    location: textValue(event.get("LOCATION")),
    organizer: extractMailto(event.get("ORGANIZER")),
    uid: textValue(event.get("UID")),
    method,
    rrule,
    tz,
    replyAttendee,
    replyPartstat,
  };
}

interface IcsValue {
  params: Record<string, string>;
  value: string;
}

interface ParsedLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

// RFC 5545 §3.1: a property line is `name(;param=value)*:value`. The colon
// that splits name+params from the value is the FIRST one not enclosed in
// double quotes (params can carry quoted values, e.g. CN="Doe, Jane").
function parseLine(line: string): ParsedLine | null {
  if (!line) return null;
  const colon = findUnquotedColon(line);
  if (colon === -1) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);

  // Split head on `;` but skip semicolons inside quoted param values.
  const parts: string[] = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < head.length; i += 1) {
    const ch = head[i];
    if (ch === '"') {
      inQuote = !inQuote;
      buf += ch;
      continue;
    }
    if (ch === ";" && !inQuote) {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  parts.push(buf);

  const name = parts.shift() ?? "";
  if (!name) return null;

  const params: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    const k = p.slice(0, eq).toUpperCase();
    let v = p.slice(eq + 1);
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = v;
  }

  return { name, params, value };
}

function findUnquotedColon(s: string): number {
  let inQuote = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) return i;
  }
  return -1;
}

// RFC 5545 §3.1 line-folding: a CRLF followed by a single SPACE or TAB
// continues the previous logical line. We accept LF too (some senders ship
// Unix line-endings).
export function unfold(raw: string): string[] {
  const out: string[] = [];
  const physical = raw.replace(/\r\n/g, "\n").split("\n");
  let buf: string | null = null;
  for (const line of physical) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (buf === null) buf = line.slice(1);
      else buf += line.slice(1);
      continue;
    }
    if (buf !== null) out.push(buf);
    buf = line;
  }
  if (buf !== null) out.push(buf);
  return out;
}

// Decode the RFC 5545 escapes used inside TEXT-typed properties: literal
// backslash-n becomes a real newline, \, and \; un-escape themselves.
function unescapeText(s: string): string {
  return s
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function textValue(v: IcsValue | undefined): string | null {
  if (!v) return null;
  const t = unescapeText(v.value).trim();
  return t || null;
}

// ORGANIZER comes through as `mailto:user@example.com` (sometimes with a
// CN= parameter — we don't need it). Strip the scheme prefix and lowercase
// for case-insensitive comparison downstream.
function extractMailto(v: IcsValue | undefined): string | null {
  if (!v) return null;
  const raw = v.value.trim();
  if (!raw) return null;
  const prefix = raw.toLowerCase().startsWith("mailto:") ? raw.slice(7) : raw;
  const cleaned = prefix.trim().toLowerCase();
  return cleaned || null;
}

// Parse the value of a DATE/DATE-TIME property to unix seconds. Handles the
// three common shapes plus a TZID-prefixed local time. Returns null when the
// value doesn't match any tolerable format.
export function parseDateValue(v: IcsValue): number | null {
  const value = v.value.trim();
  if (!value) return null;

  // YYYYMMDDTHHMMSSZ — UTC.
  let m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (m) {
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
  }

  // YYYYMMDDTHHMMSS — floating local time. With no TZID we treat it as UTC
  // (the ICS spec says floating means "the receiver's local time"; for v1
  // we don't surface a per-user timezone so UTC is the best we have).
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (m) {
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
  }

  // YYYYMMDD — DATE (all-day). Anchor to midnight UTC.
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (m) {
    return Date.UTC(+m[1], +m[2] - 1, +m[3], 0, 0, 0) / 1000;
  }

  return null;
}
