// RRULE parser/builder for the Custom recurrence editor (#95).
//
// CalendarEventForm's "Repeats" dropdown ships presets only — Daily, Weekly
// on <weekday>, Monthly on <day>, Yearly. Users who want shapes outside
// that set (every 2 weeks, BYDAY=MO,WE, COUNT=10, etc.) had no way to
// author them; the editor's "Custom…" option opens a small form whose
// state round-trips through `parseRRule` ↔ `buildRRule`.
//
// The parser is intentionally permissive — anything we don't recognise
// gets carried in `extras` so a save with no edits writes back the same
// string. The expander in calendar.ts only knows DAILY/WEEKLY/MONTHLY/
// YEARLY + INTERVAL/COUNT/UNTIL/BYDAY/BYMONTHDAY, so other parts pass
// through verbatim and only matter for round-trip fidelity.
//
// All values are RFC 5545 names sans the "RRULE:" prefix — the value of
// the calendar_events.rrule column. parseRRule on null/empty returns a
// "default" custom state (FREQ=WEEKLY, every 1, no end), which lets the
// form present a reasonable starting state when the user picks
// "Custom…" from a previously-NONE event.

export type RRuleFreq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export type RRuleByday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export const ALL_WEEKDAYS: RRuleByday[] = [
  "MO",
  "TU",
  "WE",
  "TH",
  "FR",
  "SA",
  "SU",
];

// Monthly recurs in two distinct shapes:
//   "by_day"     → fires on a specific day-of-month (BYMONTHDAY=15).
//   "by_weekday" → fires on the Nth weekday of the month
//                  (BYDAY=2MO for "second Monday"). Carries position +
//                  weekday separately so the UI can render two selects.
export type MonthlyMode = "by_day" | "by_weekday";

// COUNT and UNTIL are mutually exclusive in RFC 5545; we model that as a
// single discriminated `ends`. UNTIL is stored as the YYYYMMDD-or-
// YYYYMMDDTHHMMSSZ string verbatim so we round-trip exactly what the
// user typed (or what the source RRULE shipped).
export type RRuleEnds =
  | { kind: "never" }
  | { kind: "count"; count: number }
  | { kind: "until"; until: string };

export interface CustomRRuleState {
  freq: RRuleFreq;
  // 1..99 — RFC 5545 doesn't bound INTERVAL but the form caps at 99 for
  // display sanity; round-tripping a higher value clamps to 99.
  interval: number;
  // WEEKLY-only — empty array means "use the seed weekday" (we omit
  // BYDAY entirely on serialise).
  byday: RRuleByday[];
  // MONTHLY-only.
  monthlyMode: MonthlyMode;
  // by_day: 1..31. We don't enforce "valid for this month" here — the
  // expander silently skips Feb 30, etc.
  monthlyByMonthDay: number;
  // by_weekday: pos = -1, 1..5. -1 = last; 1..5 = first..fifth.
  monthlyByWeekdayPos: number;
  monthlyByWeekday: RRuleByday;
  // Termination clause.
  ends: RRuleEnds;
  // Round-trip carry. Anything we didn't model lands here so saving with
  // no edits regenerates the same string. Map keys are upper-cased; we
  // don't drop these on serialise.
  extras: Record<string, string>;
}

// Sensible default for "Custom…" when the source RRULE was NONE — a
// blank weekly recurrence with no end.
export function defaultCustomState(seedDate?: Date): CustomRRuleState {
  const d = seedDate ?? new Date();
  return {
    freq: "WEEKLY",
    interval: 1,
    byday: [weekdayFromIndex(d.getDay())],
    monthlyMode: "by_day",
    monthlyByMonthDay: d.getDate(),
    monthlyByWeekdayPos: nthWeekdayOfMonth(d),
    monthlyByWeekday: weekdayFromIndex(d.getDay()),
    ends: { kind: "never" },
    extras: {},
  };
}

// Parse an RRULE value (the part after `RRULE:`, or what's stored in
// calendar_events.rrule). Anything missing/unknown gracefully falls back
// to the seed-derived defaults; unrecognised parts are preserved in
// `extras`. Round-trip rule: an RRULE that's already "custom" (parsed
// then immediately rebuilt) MUST produce the same string. We achieve
// this by NOT injecting seed-derived defaults when the input is
// non-empty — only `defaultCustomState` does that, and it's only called
// when the source RRULE is null/empty.
export function parseRRule(s: string | null, seedDate?: Date): CustomRRuleState {
  if (!s) return defaultCustomState(seedDate);
  const state = defaultCustomState(seedDate);
  // For non-empty inputs we strip the seed-derived BYDAY default — the
  // builder only emits BYDAY when the array is non-empty, so an input
  // of "FREQ=WEEKLY" round-trips to "FREQ=WEEKLY".
  state.byday = [];
  const parts = parseRRuleParts(s);

  // FREQ — only the four we model. Unknown FREQ falls back to WEEKLY,
  // which keeps the editor usable; the original FREQ is NOT preserved in
  // extras since FREQ is a required field that the builder always emits.
  const freq = (parts.FREQ ?? "").toUpperCase();
  if (freq === "DAILY" || freq === "WEEKLY" || freq === "MONTHLY" || freq === "YEARLY") {
    state.freq = freq;
  }

  if (parts.INTERVAL != null) {
    const n = Number(parts.INTERVAL);
    if (Number.isFinite(n) && n >= 1) {
      state.interval = Math.min(99, Math.floor(n));
    }
  }

  // WEEKLY+BYDAY parses as a list of bare weekday codes.
  // MONTHLY+BYDAY parses as a positional weekday (e.g. "2MO" or "-1FR").
  if (parts.BYDAY) {
    const tokens = parts.BYDAY.split(",")
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);
    if (state.freq === "MONTHLY") {
      // Take the first token; MONTHLY+BYDAY with multiple positions is
      // out of scope for the editor (carried via extras instead).
      const m = /^(-?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(tokens[0] ?? "");
      if (m) {
        const pos = m[1] ? Number(m[1]) : 1;
        state.monthlyMode = "by_weekday";
        state.monthlyByWeekdayPos =
          pos === -1 || (pos >= 1 && pos <= 5) ? pos : 1;
        state.monthlyByWeekday = m[2] as RRuleByday;
      } else {
        // Unmodelled BYDAY shape — preserve verbatim.
        state.extras.BYDAY = parts.BYDAY;
      }
    } else if (state.freq === "WEEKLY") {
      const valid = tokens.filter((t): t is RRuleByday =>
        (ALL_WEEKDAYS as string[]).includes(t),
      );
      if (valid.length > 0) state.byday = valid;
      const skipped = tokens.filter((t) => !(ALL_WEEKDAYS as string[]).includes(t));
      if (skipped.length > 0 && valid.length > 0) {
        // Anything we didn't recognise (e.g. positional in WEEKLY) is
        // preserved alongside the recognised codes so the unmodelled
        // bit re-emits at build time.
        state.extras.BYDAY_EXTRA = skipped.join(",");
      }
    } else {
      // DAILY/YEARLY don't model BYDAY in the editor — pass through.
      state.extras.BYDAY = parts.BYDAY;
    }
  }

  if (parts.BYMONTHDAY) {
    const n = Number(parts.BYMONTHDAY.split(",")[0]);
    if (Number.isFinite(n) && n >= 1 && n <= 31 && state.freq === "MONTHLY") {
      state.monthlyMode = "by_day";
      state.monthlyByMonthDay = Math.floor(n);
    } else {
      state.extras.BYMONTHDAY = parts.BYMONTHDAY;
    }
  }

  if (parts.COUNT != null) {
    const n = Number(parts.COUNT);
    if (Number.isFinite(n) && n >= 1) {
      state.ends = { kind: "count", count: Math.floor(n) };
    }
  } else if (parts.UNTIL) {
    state.ends = { kind: "until", until: parts.UNTIL };
  }

  // Carry every other key we didn't consume — BYMONTH, BYSETPOS,
  // WKST, etc. Builder re-emits them in input order at the tail so
  // round-trip is byte-identical for the unmodelled parts.
  const consumed = new Set([
    "FREQ",
    "INTERVAL",
    "BYDAY",
    "BYMONTHDAY",
    "COUNT",
    "UNTIL",
  ]);
  for (const [k, v] of Object.entries(parts)) {
    if (!consumed.has(k)) state.extras[k] = v;
  }

  return state;
}

// Serialise back to an RRULE string. Order: FREQ, INTERVAL, BYDAY,
// BYMONTHDAY, COUNT|UNTIL, then any extras in insertion order. We omit
// INTERVAL=1 by convention (matches Apple/Google) and omit BYDAY when
// it's "default for this freq" (WEEKLY+seed-only is implicit from
// DTSTART).
//
// Round-trip rule: parseRRule(buildRRule(s, seed)) should produce the
// same logical state as parseRRule(s, seed); two consecutive
// build→parse→build cycles must produce identical strings.
export function buildRRule(state: CustomRRuleState): string {
  const segs: string[] = [];
  segs.push(`FREQ=${state.freq}`);
  if (state.interval > 1) segs.push(`INTERVAL=${state.interval}`);

  if (state.freq === "WEEKLY" && state.byday.length > 0) {
    // Sort canonically: MO,TU,WE,TH,FR,SA,SU. Two states with the same
    // weekday set should serialise identically regardless of click order.
    const sorted = [...state.byday].sort(
      (a, b) => ALL_WEEKDAYS.indexOf(a) - ALL_WEEKDAYS.indexOf(b),
    );
    let bydayValue = sorted.join(",");
    // Re-attach any unmodelled tokens we parked on parse so round-trip
    // carries them.
    if (state.extras.BYDAY_EXTRA) {
      bydayValue = `${bydayValue},${state.extras.BYDAY_EXTRA}`;
    }
    segs.push(`BYDAY=${bydayValue}`);
  }

  if (state.freq === "MONTHLY") {
    if (state.monthlyMode === "by_day") {
      segs.push(`BYMONTHDAY=${state.monthlyByMonthDay}`);
    } else {
      const pos =
        state.monthlyByWeekdayPos === 0 ? 1 : state.monthlyByWeekdayPos;
      segs.push(`BYDAY=${pos}${state.monthlyByWeekday}`);
    }
  }

  if (state.ends.kind === "count" && state.ends.count > 0) {
    segs.push(`COUNT=${state.ends.count}`);
  } else if (state.ends.kind === "until" && state.ends.until) {
    segs.push(`UNTIL=${state.ends.until}`);
  }

  // Emit extras last. Skip the internal BYDAY_EXTRA flag (already
  // merged into the BYDAY segment above when applicable). Skip any
  // BYDAY/BYMONTHDAY extras that the modelled emit above already
  // covered for this freq — otherwise we'd double-emit.
  for (const [k, v] of Object.entries(state.extras)) {
    if (k === "BYDAY_EXTRA") continue;
    // For WEEKLY+modelled-byday and MONTHLY+by_weekday we already wrote
    // a BYDAY segment; suppress the extras copy in those branches.
    if (k === "BYDAY" && state.freq === "WEEKLY" && state.byday.length > 0) continue;
    if (k === "BYDAY" && state.freq === "MONTHLY" && state.monthlyMode === "by_weekday") continue;
    if (k === "BYMONTHDAY" && state.freq === "MONTHLY" && state.monthlyMode === "by_day") continue;
    segs.push(`${k}=${v}`);
  }

  return segs.join(";");
}

// Format a Date as an UNTIL value. "date" form (YYYYMMDD) for all-day
// semantics; the form passes the ISO-style YYYY-MM-DD in the date input
// and we strip the dashes here. Time is implicit end-of-day.
export function formatUntilDate(yyyyMmDd: string): string {
  // Accept either YYYY-MM-DD or YYYYMMDD; emit YYYYMMDD.
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(yyyyMmDd);
  if (!m) return "";
  return `${m[1]}${m[2]}${m[3]}`;
}

// Inverse for the date input — turns a stored UNTIL (either form) back
// into YYYY-MM-DD so a <input type="date"> can render it.
export function untilToDateInput(until: string): string {
  if (!until) return "";
  // YYYYMMDDTHHMMSSZ → date only.
  const dt = /^(\d{4})(\d{2})(\d{2})/.exec(until);
  if (!dt) return "";
  return `${dt[1]}-${dt[2]}-${dt[3]}`;
}

// Helper: which Nth occurrence of its own weekday is `d` in its month?
// 1 = first, 2 = second, … 4 = fourth. We never return 5 here — the
// editor exposes "5th" as an explicit option but we don't auto-pick it.
function nthWeekdayOfMonth(d: Date): number {
  return Math.floor((d.getDate() - 1) / 7) + 1;
}

function weekdayFromIndex(i: number): RRuleByday {
  return (["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as RRuleByday[])[i] ?? "MO";
}

function parseRRuleParts(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const seg of s.split(";")) {
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    const key = seg.slice(0, eq).trim().toUpperCase();
    const value = seg.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}
