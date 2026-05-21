// Request-body validation for the scheduling admin API. Shared by the
// create (POST) and update (PATCH) event-type routes — the editor form
// always submits a complete event type, so PATCH is a full replace.

import type {
  ConferencingType,
  CustomQuestion,
  EventTypeCalendarInput,
  EventTypeInput,
  WeeklyRule,
} from "./booking";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const HHMM_RE = /^\d{1,2}:\d{2}$/;
const CONF: ConferencingType[] = [
  "none",
  "google_meet",
  "phone",
  "in_person",
  "custom_link",
];

export interface ValidatedEventType {
  input: EventTypeInput;
  calendars: EventTypeCalendarInput[];
}

function clampInt(v: unknown, dflt: number, lo: number, hi: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function parseWeekly(raw: unknown): WeeklyRule[] {
  if (!Array.isArray(raw)) return [];
  const out: WeeklyRule[] = [];
  for (const r of raw) {
    const day = Number((r as { day?: unknown })?.day);
    const start = String((r as { start?: unknown })?.start ?? "");
    const end = String((r as { end?: unknown })?.end ?? "");
    if (
      Number.isInteger(day) &&
      day >= 0 &&
      day <= 6 &&
      HHMM_RE.test(start) &&
      HHMM_RE.test(end) &&
      start < end
    ) {
      out.push({ day, start, end });
    }
  }
  return out;
}

function parseQuestions(raw: unknown): CustomQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomQuestion[] = [];
  for (const q of raw) {
    const label = String((q as { label?: unknown })?.label ?? "").trim();
    if (!label) continue;
    const type =
      (q as { type?: unknown })?.type === "textarea" ? "textarea" : "text";
    out.push({
      id:
        String((q as { id?: unknown })?.id ?? "").trim() ||
        crypto.randomUUID().slice(0, 8),
      label: label.slice(0, 200),
      type,
      required: (q as { required?: unknown })?.required === true,
    });
  }
  return out;
}

function parseCalendars(raw: unknown): EventTypeCalendarInput[] {
  if (!Array.isArray(raw)) return [];
  const out: EventTypeCalendarInput[] = [];
  for (const c of raw) {
    const kind = (c as { sourceKind?: unknown })?.sourceKind;
    if (kind === "orange_native") {
      out.push({
        sourceKind: "orange_native",
        orangeUserId:
          (c as { orangeUserId?: string })?.orangeUserId ?? null,
        orangeMailboxId:
          (c as { orangeMailboxId?: string })?.orangeMailboxId ?? null,
        checkAvailability:
          (c as { checkAvailability?: unknown })?.checkAvailability !== false,
        writeBookings:
          (c as { writeBookings?: unknown })?.writeBookings !== false,
      });
    } else if (kind === "google") {
      const connId = (c as { calendarConnectionId?: string })
        ?.calendarConnectionId;
      if (!connId) continue;
      out.push({
        sourceKind: "google",
        calendarConnectionId: connId,
        checkAvailability:
          (c as { checkAvailability?: unknown })?.checkAvailability !== false,
        writeBookings:
          (c as { writeBookings?: unknown })?.writeBookings !== false,
      });
    }
  }
  return out;
}

export function validateEventTypeBody(
  b: unknown,
): ValidatedEventType | { error: string } {
  const o = (b ?? {}) as Record<string, unknown>;
  const slug = String(o.slug ?? "").trim().toLowerCase();
  if (!SLUG_RE.test(slug)) return { error: "invalid_slug" };
  const name = String(o.name ?? "").trim();
  if (!name) return { error: "missing_name" };
  const durationMinutes = Number(o.durationMinutes);
  if (
    !Number.isInteger(durationMinutes) ||
    durationMinutes < 5 ||
    durationMinutes > 1440
  ) {
    return { error: "invalid_duration" };
  }
  const timezone = String(o.timezone ?? "").trim();
  if (!timezone) return { error: "missing_timezone" };
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    return { error: "invalid_timezone" };
  }
  const conferencingType: ConferencingType = CONF.includes(
    o.conferencingType as ConferencingType,
  )
    ? (o.conferencingType as ConferencingType)
    : "none";
  const confValue = (o.conferencingConfig as { value?: unknown })?.value;

  const input: EventTypeInput = {
    slug,
    name: name.slice(0, 200),
    description: o.description ? String(o.description).slice(0, 2000) : null,
    durationMinutes,
    timezone,
    availability: parseWeekly(o.availability),
    bufferBeforeMinutes: clampInt(o.bufferBeforeMinutes, 0, 0, 240),
    bufferAfterMinutes: clampInt(o.bufferAfterMinutes, 0, 0, 240),
    minNoticeMinutes: clampInt(o.minNoticeMinutes, 0, 0, 525600),
    bookingWindowDays: clampInt(o.bookingWindowDays, 60, 1, 365),
    slotIntervalMinutes: clampInt(o.slotIntervalMinutes, 30, 5, 240),
    conferencingType,
    conferencingConfig: confValue
      ? { value: String(confValue).slice(0, 500) }
      : null,
    customQuestions: parseQuestions(o.customQuestions),
    color: o.color ? String(o.color).slice(0, 20) : null,
    active: o.active !== false,
  };
  return { input, calendars: parseCalendars(o.calendars) };
}
