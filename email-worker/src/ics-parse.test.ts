import { describe, expect, it } from "vitest";
import { parseDateValue, parseIcs, unfold } from "./ics-parse";

// Helper for parseDateValue, which takes the IcsValue shape rather than a
// raw string — params don't matter for the formats we accept.
function dt(value: string) {
  return { params: {}, value };
}

describe("unfold", () => {
  it("joins lines that begin with a space onto the previous line", () => {
    // RFC 5545 §3.1: a CRLF followed by a single SPACE/TAB continues the
    // logical line. The continuation char itself is dropped.
    const raw = "SUMMARY:Hello\r\n World\r\nUID:abc";
    expect(unfold(raw)).toEqual(["SUMMARY:HelloWorld", "UID:abc"]);
  });

  it("accepts LF-only line endings", () => {
    expect(unfold("A:1\nB:2")).toEqual(["A:1", "B:2"]);
  });

  it("handles tabs as continuation markers", () => {
    expect(unfold("A:foo\r\n\tbar")).toEqual(["A:foobar"]);
  });
});

describe("parseDateValue", () => {
  it("parses YYYYMMDDTHHMMSSZ as UTC", () => {
    expect(parseDateValue(dt("20260615T143000Z"))).toBe(
      Date.UTC(2026, 5, 15, 14, 30, 0) / 1000,
    );
  });

  it("parses floating local-time as UTC (best-effort)", () => {
    // We don't have the user's TZ in v1, so floating times are interpreted
    // as UTC. Documented in the parser.
    expect(parseDateValue(dt("20260615T143000"))).toBe(
      Date.UTC(2026, 5, 15, 14, 30, 0) / 1000,
    );
  });

  it("parses YYYYMMDD as midnight UTC (all-day)", () => {
    expect(parseDateValue(dt("20260615"))).toBe(
      Date.UTC(2026, 5, 15) / 1000,
    );
  });

  it("returns null for unrecognised formats", () => {
    expect(parseDateValue(dt("nope"))).toBeNull();
    expect(parseDateValue(dt(""))).toBeNull();
  });
});

describe("parseIcs", () => {
  // Minimal end-to-end — exercises the unfold + line parser + property
  // extraction path on a typical Outlook-style invite.
  const sample = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    "UID:abc-123@example.com",
    "DTSTAMP:20260601T100000Z",
    "DTSTART:20260615T143000Z",
    "DTEND:20260615T153000Z",
    "SUMMARY:Quarterly review",
    "LOCATION:Room 4",
    "ORGANIZER;CN=Alice:mailto:alice@example.com",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("extracts the headline fields from a REQUEST", () => {
    const out = parseIcs(sample);
    expect(out).not.toBeNull();
    expect(out!.method).toBe("REQUEST");
    expect(out!.summary).toBe("Quarterly review");
    expect(out!.location).toBe("Room 4");
    expect(out!.organizer).toBe("alice@example.com");
    expect(out!.uid).toBe("abc-123@example.com");
    expect(out!.startsAt).toBe(Date.UTC(2026, 5, 15, 14, 30, 0) / 1000);
    expect(out!.endsAt).toBe(Date.UTC(2026, 5, 15, 15, 30, 0) / 1000);
  });

  it("returns null when the VEVENT has no DTSTART", () => {
    const broken = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Missing start",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(parseIcs(broken)).toBeNull();
  });

  it("tolerates folded SUMMARY lines (RFC 5545 §3.1)", () => {
    const folded = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "DTSTART:20260615T143000Z",
      "SUMMARY:Hello",
      " World",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(parseIcs(folded)?.summary).toBe("HelloWorld");
  });

  it("strips a TZID-prefixed local DTSTART value to its date portion", () => {
    // Our DTSTART parser ignores the TZID parameter and falls back to
    // floating-as-UTC — close enough for v1 and documented as such.
    const tz = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:tz-1",
      "DTSTART;TZID=America/Los_Angeles:20260615T093000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const out = parseIcs(tz);
    expect(out).not.toBeNull();
    expect(out!.startsAt).toBe(Date.UTC(2026, 5, 15, 9, 30, 0) / 1000);
  });

  it("captures METHOD at the calendar level even if it appears before the VEVENT", () => {
    const cancel = [
      "BEGIN:VCALENDAR",
      "METHOD:CANCEL",
      "BEGIN:VEVENT",
      "UID:c-1",
      "DTSTART:20260615T143000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(parseIcs(cancel)?.method).toBe("CANCEL");
  });

  it("unescapes \\, \\; and \\n in TEXT values", () => {
    const escaped = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:e-1",
      "DTSTART:20260615T143000Z",
      "SUMMARY:Hello\\, World",
      "LOCATION:Floor 1\\nRoom 4",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const out = parseIcs(escaped);
    expect(out!.summary).toBe("Hello, World");
    expect(out!.location).toBe("Floor 1\nRoom 4");
  });
});
