"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import type { CalendarEvent } from "./CalendarManager";

// Agenda-style list view (#TBD). Sister to CalendarDayGrid /
// CalendarWeekGrid / CalendarMonthGrid — shares the colorFor + click
// behavior so an event painted in week view paints the same dot here.
//
// The window is owned upstream (CalendarManager.computeWindow); this
// component just groups whatever events it receives by local date and
// renders them chronologically. Empty days are skipped on purpose —
// the value of an agenda over a month grid is a tight, scrollable list.

interface Props {
  cursor: Date;
  events: CalendarEvent[];
  colorFor?: (ev: CalendarEvent) => string | null;
  onEditEvent: (ev: CalendarEvent) => void;
}

export default function CalendarListView({
  cursor,
  events,
  colorFor,
  onEditEvent,
}: Props) {
  const router = useRouter();

  // Group by local date (YYYY-MM-DD), sort events within each day by
  // start time. All-day events sort first (they "anchor" the day).
  const groups = useMemo(() => {
    const sorted = [...events].sort((a, b) => {
      if (a.all_day !== b.all_day) return b.all_day - a.all_day;
      return a.starts_at - b.starts_at;
    });
    const m = new Map<string, CalendarEvent[]>();
    for (const ev of sorted) {
      const d = new Date(ev.starts_at * 1000);
      d.setHours(0, 0, 0, 0);
      const key = formatKey(d);
      const list = m.get(key) ?? [];
      list.push(ev);
      m.set(key, list);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [events]);

  function handleClick(ev: CalendarEvent) {
    if (ev.source_message_id) {
      router.push(`/inbox/all/${ev.source_message_id}`);
      return;
    }
    if (ev.source === "self") onEditEvent(ev);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cursorDay = new Date(cursor);
  cursorDay.setHours(0, 0, 0, 0);

  if (groups.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-500 px-6">
        No events in this range. Use Prev / Next to look at another month, or
        click <span className="font-medium">+ New event</span>.
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-6 py-4 mx-auto max-w-3xl w-full">
      {groups.map(([key, evs]) => {
        const date = parseKey(key);
        const isToday = date.getTime() === today.getTime();
        const isCursor = date.getTime() === cursorDay.getTime();
        const isPast = date.getTime() < today.getTime();
        return (
          <section
            key={key}
            id={`list-${key}`}
            className={`pb-3 ${isPast && !isToday ? "opacity-60" : ""}`}
          >
            <header
              className={`sticky top-0 z-10 bg-white dark:bg-neutral-950 py-2 mb-1 border-b border-neutral-200 dark:border-neutral-800 flex items-baseline gap-3`}
            >
              <span
                className={`text-2xl font-semibold tabular-nums ${
                  isToday ? "text-[var(--color-brand)]" : ""
                }`}
              >
                {date.getDate()}
              </span>
              <div className="flex flex-col leading-tight">
                <span className="text-xs uppercase tracking-wider">
                  {date.toLocaleDateString(undefined, { weekday: "long" })}
                </span>
                <span className="text-[10px] text-neutral-500">
                  {date.toLocaleDateString(undefined, {
                    month: "long",
                    year: "numeric",
                  })}
                </span>
              </div>
              {isToday && (
                <span className="ml-2 text-[10px] uppercase tracking-wider bg-[var(--color-brand)] text-white px-1.5 py-0.5 rounded">
                  Today
                </span>
              )}
              {!isToday && isCursor && (
                <span className="ml-2 text-[10px] uppercase tracking-wider border border-[var(--color-brand)] text-[var(--color-brand)] px-1.5 py-0.5 rounded">
                  Cursor
                </span>
              )}
            </header>
            <ul className="space-y-0.5">
              {evs.map(ev => (
                <ListRow
                  key={ev.id}
                  event={ev}
                  color={colorFor?.(ev) ?? null}
                  onClick={() => handleClick(ev)}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function ListRow({
  event,
  color,
  onClick,
}: {
  event: CalendarEvent;
  color: string | null;
  onClick: () => void;
}) {
  const start = new Date(event.starts_at * 1000);
  const end = event.ends_at != null ? new Date(event.ends_at * 1000) : null;
  const allDay = event.all_day === 1;
  const timeLabel = allDay
    ? "All day"
    : end
      ? `${formatTime(start)} – ${formatTime(end)}`
      : formatTime(start);
  const dotColor = color ?? "#3b82f6";
  const cancelled = event.cancelled === 1;
  const fromInvite = event.source === "invite";

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`w-full flex items-start gap-3 text-left px-3 py-1.5 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-900 ${
          cancelled ? "line-through opacity-60" : ""
        }`}
      >
        <span className="w-20 shrink-0 text-[11px] tabular-nums text-neutral-600 dark:text-neutral-400 pt-0.5">
          {timeLabel}
        </span>
        <span
          className="mt-1.5 inline-block h-2 w-2 rounded-full shrink-0"
          style={{ backgroundColor: dotColor }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm truncate">
            {event.summary || "(no title)"}
            {fromInvite && (
              <span className="ml-2 text-[10px] uppercase tracking-wider text-neutral-500">
                invite
              </span>
            )}
          </div>
          {event.location && (
            <div className="text-xs text-neutral-500 truncate">
              {event.location}
            </div>
          )}
        </div>
      </button>
    </li>
  );
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatKey(d: Date): string {
  const y = d.getFullYear().toString().padStart(4, "0");
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setHours(0, 0, 0, 0);
  return dt;
}
