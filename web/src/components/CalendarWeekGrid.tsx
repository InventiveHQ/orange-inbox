"use client";

import { useRouter } from "next/navigation";
import { type CalendarEvent, type NewEventDraft, startOfWeek } from "./CalendarManager";

// Week view: 7 columns × 24 hour rows + an all-day strip across the top.
// Events are absolute-positioned by their start hour + duration; clicks on
// an invite navigate back to the source thread, clicks on a self event
// open the edit form. Clicks on empty hour cells / all-day strip open the
// New Event modal prefilled with that slot's time.

interface Props {
  cursor: Date;
  events: CalendarEvent[];
  // Per-event color override (#78). The CalendarManager provides a lookup
  // that maps the event's mailbox_id back to the user's calendar prefs;
  // returning null falls back to the default sky/brand tones.
  colorFor?: (ev: CalendarEvent) => string | null;
  onEditEvent: (ev: CalendarEvent) => void;
  onCreateAt: (draft: NewEventDraft) => void;
}

const HOUR_HEIGHT = 40; // px — also drives slot row height in the grid template
const SLOT_MINUTES = 30; // quick-create snap granularity

export default function CalendarWeekGrid({ cursor, events, colorFor, onEditEvent, onCreateAt }: Props) {
  const router = useRouter();
  const weekStart = startOfWeek(cursor);
  const days: Date[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });

  // Partition into all-day (any with all_day=1, plus events whose duration
  // covers >= 24h) vs timed events. The grid below positions timed events
  // absolutely within the day's column; all-day events sit in the strip.
  const allDay: CalendarEvent[] = [];
  const timed: CalendarEvent[] = [];
  for (const e of events) {
    if (e.all_day === 1 || isLongEvent(e)) allDay.push(e);
    else timed.push(e);
  }

  function handleClick(ev: CalendarEvent) {
    if (ev.source_message_id) {
      // Invite → jump back to the source thread. The mailbox scope isn't
      // stored on the event row, so route via /all which lets the layout
      // resolve the right mailbox view from the thread itself.
      router.push(`/inbox/all/${ev.source_message_id}`);
      return;
    }
    if (ev.source === "self") {
      onEditEvent(ev);
    }
  }

  return (
    <div className="grid" style={{ gridTemplateColumns: "60px repeat(7, 1fr)" }}>
      {/* Day-header row */}
      <div className="border-b border-r border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 sticky top-0 z-10" />
      {days.map(d => (
        <DayHeader key={d.toISOString()} date={d} />
      ))}

      {/* All-day strip */}
      <div className="border-b border-r border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 text-[10px] font-medium text-neutral-500 uppercase tracking-wider px-2 py-1 sticky top-[44px] z-10">
        All day
      </div>
      {days.map(d => (
        <AllDayCell
          key={`ad-${d.toISOString()}`}
          date={d}
          events={allDayEventsForDay(allDay, d)}
          colorFor={colorFor}
          onClick={handleClick}
          onCreate={() => onCreateAt(allDayDraftForDate(d))}
        />
      ))}

      {/* Hour rows + timed event overlay */}
      <HourLabelsColumn />
      {days.map(d => (
        <DayColumn
          key={`col-${d.toISOString()}`}
          date={d}
          events={timedEventsForDay(timed, d)}
          colorFor={colorFor}
          onClick={handleClick}
          onCreate={draft => onCreateAt(draft)}
        />
      ))}
    </div>
  );
}

function DayHeader({ date }: { date: Date }) {
  const isToday = isSameDay(date, new Date());
  return (
    <div
      className={`border-b border-r border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 px-2 py-1 text-center sticky top-0 z-10 ${
        isToday ? "text-[var(--color-brand)]" : ""
      }`}
    >
      <div className="text-[10px] uppercase tracking-wider">
        {date.toLocaleDateString(undefined, { weekday: "short" })}
      </div>
      <div className={`text-base ${isToday ? "font-semibold" : ""}`}>
        {date.getDate()}
      </div>
    </div>
  );
}

function AllDayCell({
  date,
  events,
  colorFor,
  onClick,
  onCreate,
}: {
  date: Date;
  events: CalendarEvent[];
  colorFor?: (ev: CalendarEvent) => string | null;
  onClick: (e: CalendarEvent) => void;
  onCreate: () => void;
}) {
  // Empty space in the strip is the click target — event chips below
  // stopPropagation so clicking a chip doesn't also fire create.
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Create all-day event on ${date.toDateString()}`}
      onClick={onCreate}
      onKeyDown={e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onCreate();
        }
      }}
      className="border-b border-r border-neutral-200 dark:border-neutral-800 min-h-[28px] py-1 px-1 flex flex-col gap-0.5 sticky top-[44px] z-10 bg-white dark:bg-neutral-950 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900/60"
    >
      {events.map(ev => (
        <EventChip
          key={ev.id}
          event={ev}
          colorOverride={colorFor?.(ev) ?? null}
          onClick={onClick}
          compact
        />
      ))}
      {events.length === 0 && <div className="text-[10px] text-neutral-300">{" "}</div>}
      {/* date prop unused in render — kept so the layout can derive a tooltip later */}
      <span className="sr-only">{date.toISOString()}</span>
    </div>
  );
}

function HourLabelsColumn() {
  return (
    <div className="border-r border-neutral-200 dark:border-neutral-800">
      {Array.from({ length: 24 }, (_, h) => (
        <div
          key={h}
          className="border-b border-neutral-100 dark:border-neutral-900 text-[10px] text-neutral-500 pr-1 text-right tabular-nums"
          style={{ height: HOUR_HEIGHT }}
        >
          {h === 0 ? "" : formatHourLabel(h)}
        </div>
      ))}
    </div>
  );
}

function DayColumn({
  date,
  events,
  colorFor,
  onClick,
  onCreate,
}: {
  date: Date;
  events: CalendarEvent[];
  colorFor?: (ev: CalendarEvent) => string | null;
  onClick: (e: CalendarEvent) => void;
  onCreate: (draft: NewEventDraft) => void;
}) {
  // Absolute-positioned event blocks over a 24×HOUR_HEIGHT column.
  // Each hour row is a click target — y-offset within the row snaps to
  // SLOT_MINUTES so clicking the top half of a row → :00, bottom half → :30.
  return (
    <div
      className="relative border-r border-neutral-200 dark:border-neutral-800"
      style={{ height: 24 * HOUR_HEIGHT }}
    >
      {Array.from({ length: 24 }, (_, h) => (
        <div
          key={h}
          role="button"
          tabIndex={-1}
          aria-label={`Create event at ${formatSlot(h, 0)}`}
          onClick={e => {
            const slot = slotFromClick(e, h);
            onCreate(slotDraftForDate(date, slot.hour, slot.minute));
          }}
          className="border-b border-neutral-100 dark:border-neutral-900 cursor-pointer hover:bg-[var(--color-brand)]/5"
          style={{ height: HOUR_HEIGHT }}
        />
      ))}
      {events.map(ev => {
        const { top, height } = positionEvent(ev, date);
        const override = colorFor?.(ev) ?? null;
        const styleOverride = eventStyle(ev, override);
        return (
          <button
            key={ev.id}
            type="button"
            onClick={e => {
              e.stopPropagation();
              onClick(ev);
            }}
            className={`absolute left-1 right-1 rounded text-left text-[11px] px-1.5 py-0.5 truncate border ${eventTone(ev, override)}`}
            // Merge geometry + tone style. eventStyle returns undefined
            // for the no-override path, so we spread conditionally.
            style={{ top, height: Math.max(height, 16), ...(styleOverride ?? {}) }}
            title={ev.summary || "(no title)"}
          >
            <span className={ev.cancelled ? "line-through" : ""}>
              {ev.summary || "(no title)"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Convert a click on an hour row into a (hour, minute) slot. offsetY is
// the y-coordinate within the row (0..HOUR_HEIGHT); we bucket it to
// SLOT_MINUTES so the user lands on a half-hour boundary.
function slotFromClick(
  e: React.MouseEvent<HTMLDivElement>,
  hour: number,
): { hour: number; minute: number } {
  const rect = e.currentTarget.getBoundingClientRect();
  const offsetY = e.clientY - rect.top;
  const fraction = Math.max(0, Math.min(1, offsetY / HOUR_HEIGHT));
  const minute = Math.floor((fraction * 60) / SLOT_MINUTES) * SLOT_MINUTES;
  return { hour, minute };
}

function slotDraftForDate(date: Date, hour: number, minute: number): NewEventDraft {
  const start = new Date(date);
  start.setHours(hour, minute, 0, 0);
  const end = new Date(start);
  end.setHours(end.getHours() + 1);
  return {
    kind: "new",
    startsAt: Math.floor(start.getTime() / 1000),
    endsAt: Math.floor(end.getTime() / 1000),
    allDay: false,
  };
}

function allDayDraftForDate(date: Date): NewEventDraft {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    kind: "new",
    startsAt: Math.floor(start.getTime() / 1000),
    endsAt: Math.floor(end.getTime() / 1000),
    allDay: true,
  };
}

function formatSlot(hour: number, minute: number): string {
  const h12 = ((hour + 11) % 12) + 1;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12}:${minute.toString().padStart(2, "0")} ${ampm}`;
}

function EventChip({
  event,
  colorOverride,
  onClick,
  compact,
}: {
  event: CalendarEvent;
  colorOverride?: string | null;
  onClick: (e: CalendarEvent) => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={e => {
        // Don't let the click bubble to the parent all-day cell, which
        // would also open a New Event modal on top of the edit modal.
        e.stopPropagation();
        onClick(event);
      }}
      className={`text-left text-[11px] truncate rounded px-1.5 ${compact ? "py-0" : "py-0.5"} border ${eventTone(event, colorOverride)}`}
      style={eventStyle(event, colorOverride)}
      title={event.summary || "(no title)"}
    >
      <span className={event.cancelled ? "line-through" : ""}>
        {event.summary || "(no title)"}
      </span>
    </button>
  );
}

export { allDayDraftForDate, slotDraftForDate, SLOT_MINUTES };

// Tone selection: cancelled is loud (rose) regardless of source so the user
// can spot dead events at a glance. Otherwise we fall back to a per-calendar
// color (#78) when the caller supplies one — that's the sidebar swatch the
// user picked. Without an override (legacy callers / not-yet-loaded prefs),
// we keep the original sky/brand split so events still render usefully.
//
// The override is consumed via inline style — Tailwind can't generate
// arbitrary hex classes at runtime, and the prefs UI lets the user pick
// any hex value. We emit just the structural utility classes here and
// expect callers to spread `eventStyle()` into the `style` prop alongside.
export function eventTone(ev: CalendarEvent, colorOverride?: string | null): string {
  if (ev.cancelled === 1) {
    return "bg-rose-100 dark:bg-rose-950/40 border-rose-300 dark:border-rose-900 text-rose-900 dark:text-rose-200";
  }
  if (colorOverride) {
    // Border + text get the override color; background is a translucent
    // tint applied via inline style. Border / text inherit currentColor so
    // the inline style flow keeps them in sync.
    return "border text-current";
  }
  if (ev.source === "self") {
    return "bg-[var(--color-brand)]/15 border-[var(--color-brand)]/40 text-[var(--color-brand)]";
  }
  return "bg-sky-100 dark:bg-sky-950/40 border-sky-300 dark:border-sky-900 text-sky-900 dark:text-sky-200";
}

// Inline-style companion to eventTone: returns a style object that paints
// the event with a per-calendar color override, or `undefined` when no
// override applies (in which case eventTone's static utility classes
// handle painting). Cancelled events ignore the override — the rose tone
// dominates so the audit trail stays unambiguous.
export function eventStyle(
  ev: CalendarEvent,
  colorOverride?: string | null,
): React.CSSProperties | undefined {
  if (ev.cancelled === 1 || !colorOverride) return undefined;
  return {
    color: colorOverride,
    borderColor: hexWithAlpha(colorOverride, 0.5),
    backgroundColor: hexWithAlpha(colorOverride, 0.15),
  };
}

// `#rrggbb` + 0..1 alpha → `rgba(...)`. Tailwind's `bg-color/15` syntax
// requires a known color name; users pick free-form hex from the swatch
// dialog so we synth the rgba string ourselves.
function hexWithAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function allDayEventsForDay(allDay: CalendarEvent[], day: Date): CalendarEvent[] {
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const dayStartSec = Math.floor(dayStart.getTime() / 1000);
  const dayEndSec = Math.floor(dayEnd.getTime() / 1000);
  return allDay.filter(ev => {
    const start = ev.starts_at;
    const end = ev.ends_at ?? start + 24 * 3600;
    return start < dayEndSec && end > dayStartSec;
  });
}

export function timedEventsForDay(timed: CalendarEvent[], day: Date): CalendarEvent[] {
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const dayStartSec = Math.floor(dayStart.getTime() / 1000);
  const dayEndSec = Math.floor(dayEnd.getTime() / 1000);
  return timed.filter(ev => {
    const start = ev.starts_at;
    const end = ev.ends_at ?? start + 3600;
    return start < dayEndSec && end > dayStartSec;
  });
}

export function positionEvent(ev: CalendarEvent, day: Date): { top: number; height: number } {
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const startMs = ev.starts_at * 1000;
  const endMs = (ev.ends_at ?? ev.starts_at + 3600) * 1000;
  // Clamp to the day window so an event spilling over to tomorrow doesn't
  // render off the bottom of the column.
  const dayStartMs = dayStart.getTime();
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
  const visibleStart = Math.max(startMs, dayStartMs);
  const visibleEnd = Math.min(endMs, dayEndMs);
  const minuteOfDay = (visibleStart - dayStartMs) / 60000;
  const duration = (visibleEnd - visibleStart) / 60000;
  return {
    top: (minuteOfDay / 60) * HOUR_HEIGHT,
    height: (duration / 60) * HOUR_HEIGHT,
  };
}

function isLongEvent(ev: CalendarEvent): boolean {
  if (ev.ends_at == null) return false;
  return ev.ends_at - ev.starts_at >= 24 * 3600;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatHourLabel(h: number): string {
  // 12-hour with am/pm matches the US default; locales that prefer 24h
  // can be migrated later via a user pref.
  if (h === 12) return "12 PM";
  if (h > 12) return `${h - 12} PM`;
  return `${h} AM`;
}
