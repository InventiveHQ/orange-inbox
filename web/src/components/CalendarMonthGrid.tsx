"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  type CalendarEvent,
  type NewEventDraft,
  startOfWeekFor,
} from "./CalendarManager";
import { allDayDraftForDate, eventStyle, eventTone } from "./CalendarWeekGrid";

// Month view: 6×7 day-cell grid. Each cell shows up to MAX_PER_CELL event
// titles; overflow opens a small "more…" popover with the full day's list
// instead of jumping to day view (#87). Clicking the date number still
// switches to Day view for users who want the timed grid for that day.

const MAX_PER_CELL = 3;

interface Props {
  cursor: Date;
  events: CalendarEvent[];
  colorFor?: (ev: CalendarEvent) => string | null;
  weekStartDay: number;
  onEditEvent: (ev: CalendarEvent) => void;
  onSelectDate: (d: Date) => void;
  onCreateAt: (draft: NewEventDraft) => void;
}

export default function CalendarMonthGrid({
  cursor,
  events,
  colorFor,
  weekStartDay,
  onEditEvent,
  onSelectDate,
  onCreateAt,
}: Props) {
  const router = useRouter();
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const gridStart = startOfWeekFor(first, weekStartDay);
  const cells: Date[] = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + i);
    return d;
  });

  function handleClick(ev: CalendarEvent) {
    if (ev.source_message_id) {
      router.push(`/inbox/all/${ev.source_message_id}`);
      return;
    }
    if (ev.source === "self") onEditEvent(ev);
  }

  const weekdayLabels = weekStartDay === 1
    ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div className="flex flex-col h-full">
      <div className="grid grid-cols-7 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950">
        {weekdayLabels.map(l => (
          <div
            key={l}
            className="px-2 py-1 text-[10px] uppercase tracking-wider text-neutral-500 text-center"
          >
            {l}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 grid-rows-6 flex-1 min-h-0">
        {cells.map(d => (
          <DayCell
            key={d.toISOString()}
            date={d}
            month={cursor.getMonth()}
            events={eventsForDay(events, d)}
            colorFor={colorFor}
            onEventClick={handleClick}
            onSelectDate={onSelectDate}
            onCreate={() => onCreateAt(allDayDraftForDate(d))}
          />
        ))}
      </div>
    </div>
  );
}

function DayCell({
  date,
  month,
  events,
  colorFor,
  onEventClick,
  onSelectDate,
  onCreate,
}: {
  date: Date;
  month: number;
  events: CalendarEvent[];
  colorFor?: (ev: CalendarEvent) => string | null;
  onEventClick: (ev: CalendarEvent) => void;
  onSelectDate: (d: Date) => void;
  onCreate: () => void;
}) {
  const inMonth = date.getMonth() === month;
  const isToday = isSameDay(date, new Date());
  const visible = events.slice(0, MAX_PER_CELL);
  const overflow = events.length - visible.length;
  const [popover, setPopover] = useState(false);

  // Whole cell is the click target for quick-create; the date number,
  // event chips, and overflow link below stopPropagation so they keep
  // their own behavior.
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Create event on ${date.toDateString()}`}
      onClick={onCreate}
      onKeyDown={e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onCreate();
        }
      }}
      className={`relative border-b border-r border-neutral-200 dark:border-neutral-800 p-1 flex flex-col min-h-[6rem] cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900/40 ${
        inMonth ? "bg-white dark:bg-neutral-950" : "bg-neutral-50 dark:bg-neutral-900/50"
      }`}
    >
      <button
        type="button"
        onClick={e => {
          e.stopPropagation();
          onSelectDate(date);
        }}
        className={`self-end text-[11px] tabular-nums px-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
          isToday
            ? "bg-[var(--color-brand)] text-white hover:bg-[var(--color-brand)]"
            : inMonth
              ? ""
              : "text-neutral-400"
        }`}
        aria-label={`Open day view for ${date.toDateString()}`}
      >
        {date.getDate()}
      </button>
      <div className="mt-0.5 flex flex-col gap-0.5 min-h-0">
        {visible.map(ev => {
          const override = colorFor?.(ev) ?? null;
          return (
            <button
              key={ev.id}
              type="button"
              onClick={e => {
                e.stopPropagation();
                onEventClick(ev);
              }}
              className={`text-left text-[10px] leading-tight truncate rounded px-1 py-px border ${eventTone(ev, override)}`}
              style={eventStyle(ev, override)}
              title={ev.summary || "(no title)"}
            >
              <span className={ev.cancelled ? "line-through" : ""}>
                {ev.summary || "(no title)"}
              </span>
            </button>
          );
        })}
        {overflow > 0 && (
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              setPopover(true);
            }}
            className="text-left text-[10px] text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 px-1"
          >
            + {overflow} more
          </button>
        )}
      </div>
      {popover && (
        <MorePopover
          date={date}
          events={events}
          colorFor={colorFor}
          onEventClick={ev => {
            setPopover(false);
            onEventClick(ev);
          }}
          onClose={() => setPopover(false)}
        />
      )}
    </div>
  );
}

// Small popover that lists every event on a day. Used by the "+ N more"
// overflow link in the month grid. Sits on top of the cell — z-index above
// neighbouring chips, outside-click / Escape to dismiss.
function MorePopover({
  date,
  events,
  colorFor,
  onEventClick,
  onClose,
}: {
  date: Date;
  events: CalendarEvent[];
  colorFor?: (ev: CalendarEvent) => string | null;
  onEventClick: (ev: CalendarEvent) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Events on ${date.toDateString()}`}
      onClick={e => e.stopPropagation()}
      className="absolute z-20 left-1 top-6 w-56 max-h-64 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg p-2"
    >
      <div className="flex items-center justify-between mb-1">
        <div className="text-[11px] font-medium text-neutral-500">
          {date.toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
          })}
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 px-1"
        >
          ×
        </button>
      </div>
      <ul className="flex flex-col gap-1">
        {events.map(ev => {
          const override = colorFor?.(ev) ?? null;
          return (
            <li key={ev.id}>
              <button
                type="button"
                onClick={() => onEventClick(ev)}
                className={`w-full text-left text-[11px] leading-tight rounded px-1.5 py-1 border ${eventTone(ev, override)}`}
                style={eventStyle(ev, override)}
                title={ev.summary || "(no title)"}
              >
                <div className={`truncate ${ev.cancelled ? "line-through" : ""}`}>
                  {ev.summary || "(no title)"}
                </div>
                {ev.all_day !== 1 && (
                  <div className="text-[10px] opacity-70 tabular-nums">
                    {formatTimeRange(ev)}
                  </div>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatTimeRange(ev: CalendarEvent): string {
  const start = new Date(ev.starts_at * 1000).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (ev.ends_at == null) return start;
  const end = new Date(ev.ends_at * 1000).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${start} – ${end}`;
}

function eventsForDay(events: CalendarEvent[], day: Date): CalendarEvent[] {
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const dayStartSec = Math.floor(dayStart.getTime() / 1000);
  const dayEndSec = Math.floor(dayEnd.getTime() / 1000);
  // Default a missing ends_at to a 1h block for ordering — same convention
  // the Week grid uses for sizing.
  return events
    .filter(ev => {
      const start = ev.starts_at;
      const end = ev.ends_at ?? start + 3600;
      return start < dayEndSec && end > dayStartSec;
    })
    .sort((a, b) => a.starts_at - b.starts_at);
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
