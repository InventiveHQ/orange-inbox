"use client";

import { useRouter } from "next/navigation";
import { type CalendarEvent, startOfWeek } from "./CalendarManager";

// Week view: 7 columns × 24 hour rows + an all-day strip across the top.
// Events are absolute-positioned by their start hour + duration; clicks on
// an invite navigate back to the source thread, clicks on a self event
// open the edit form.

interface Props {
  cursor: Date;
  events: CalendarEvent[];
  onEditEvent: (ev: CalendarEvent) => void;
}

const HOUR_HEIGHT = 40; // px — also drives slot row height in the grid template

export default function CalendarWeekGrid({ cursor, events, onEditEvent }: Props) {
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
          onClick={handleClick}
        />
      ))}

      {/* Hour rows + timed event overlay */}
      <HourLabelsColumn />
      {days.map(d => (
        <DayColumn
          key={`col-${d.toISOString()}`}
          date={d}
          events={timedEventsForDay(timed, d)}
          onClick={handleClick}
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
  onClick,
}: {
  date: Date;
  events: CalendarEvent[];
  onClick: (e: CalendarEvent) => void;
}) {
  return (
    <div className="border-b border-r border-neutral-200 dark:border-neutral-800 min-h-[28px] py-1 px-1 flex flex-col gap-0.5 sticky top-[44px] z-10 bg-white dark:bg-neutral-950">
      {events.map(ev => (
        <EventChip key={ev.id} event={ev} onClick={onClick} compact />
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
  onClick,
}: {
  date: Date;
  events: CalendarEvent[];
  onClick: (e: CalendarEvent) => void;
}) {
  // Absolute-positioned event blocks over a 24×HOUR_HEIGHT column.
  return (
    <div
      className="relative border-r border-neutral-200 dark:border-neutral-800"
      style={{ height: 24 * HOUR_HEIGHT }}
    >
      {Array.from({ length: 24 }, (_, h) => (
        <div
          key={h}
          className="border-b border-neutral-100 dark:border-neutral-900"
          style={{ height: HOUR_HEIGHT }}
        />
      ))}
      {events.map(ev => {
        const { top, height } = positionEvent(ev, date);
        return (
          <button
            key={ev.id}
            type="button"
            onClick={() => onClick(ev)}
            className={`absolute left-1 right-1 rounded text-left text-[11px] px-1.5 py-0.5 truncate border ${eventTone(ev)}`}
            style={{ top, height: Math.max(height, 16) }}
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

function EventChip({
  event,
  onClick,
  compact,
}: {
  event: CalendarEvent;
  onClick: (e: CalendarEvent) => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(event)}
      className={`text-left text-[11px] truncate rounded px-1.5 ${compact ? "py-0" : "py-0.5"} border ${eventTone(event)}`}
      title={event.summary || "(no title)"}
    >
      <span className={event.cancelled ? "line-through" : ""}>
        {event.summary || "(no title)"}
      </span>
    </button>
  );
}

// Tone selection: cancelled is loud (rose) regardless of source so the user
// can spot dead events at a glance; invites are sky, self events use brand
// so they pop against the inviter-heavy default.
export function eventTone(ev: CalendarEvent): string {
  if (ev.cancelled === 1) {
    return "bg-rose-100 dark:bg-rose-950/40 border-rose-300 dark:border-rose-900 text-rose-900 dark:text-rose-200";
  }
  if (ev.source === "self") {
    return "bg-[var(--color-brand)]/15 border-[var(--color-brand)]/40 text-[var(--color-brand)]";
  }
  return "bg-sky-100 dark:bg-sky-950/40 border-sky-300 dark:border-sky-900 text-sky-900 dark:text-sky-200";
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
