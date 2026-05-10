"use client";

import { useRouter } from "next/navigation";
import { type CalendarEvent, type NewEventDraft } from "./CalendarManager";
import {
  allDayDraftForDate,
  allDayEventsForDay,
  eventTone,
  positionEvent,
  slotDraftForDate,
  SLOT_MINUTES,
  timedEventsForDay,
} from "./CalendarWeekGrid";

// Day view: single column with the same hour-row + absolute-event geometry
// as Week. Shares positioning helpers with CalendarWeekGrid so a layout
// tweak in one carries to the other.

interface Props {
  cursor: Date;
  events: CalendarEvent[];
  onEditEvent: (ev: CalendarEvent) => void;
  onCreateAt: (draft: NewEventDraft) => void;
}

const HOUR_HEIGHT = 40;

export default function CalendarDayGrid({ cursor, events, onEditEvent, onCreateAt }: Props) {
  const router = useRouter();
  const day = new Date(cursor);
  day.setHours(0, 0, 0, 0);

  const allDay: CalendarEvent[] = [];
  const timed: CalendarEvent[] = [];
  for (const e of events) {
    if (e.all_day === 1 || (e.ends_at != null && e.ends_at - e.starts_at >= 24 * 3600)) {
      allDay.push(e);
    } else {
      timed.push(e);
    }
  }

  function handleClick(ev: CalendarEvent) {
    if (ev.source_message_id) {
      router.push(`/inbox/all/${ev.source_message_id}`);
      return;
    }
    if (ev.source === "self") onEditEvent(ev);
  }

  const allDayForDay = allDayEventsForDay(allDay, day);
  const timedForDay = timedEventsForDay(timed, day);

  return (
    <div className="grid" style={{ gridTemplateColumns: "60px 1fr" }}>
      <div className="border-b border-r border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 px-2 py-2 sticky top-0 z-10" />
      <div className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 px-3 py-2 sticky top-0 z-10">
        <div className="text-[10px] uppercase tracking-wider text-neutral-500">
          {day.toLocaleDateString(undefined, { weekday: "long" })}
        </div>
        <div className="text-base font-medium">
          {day.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}
        </div>
      </div>

      <div className="border-b border-r border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 text-[10px] font-medium text-neutral-500 uppercase tracking-wider px-2 py-1">
        All day
      </div>
      <div
        role="button"
        tabIndex={0}
        aria-label={`Create all-day event on ${day.toDateString()}`}
        onClick={() => onCreateAt(allDayDraftForDate(day))}
        onKeyDown={e => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onCreateAt(allDayDraftForDate(day));
          }
        }}
        className="border-b border-neutral-200 dark:border-neutral-800 min-h-[28px] py-1 px-2 flex flex-col gap-0.5 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900/60"
      >
        {allDayForDay.length === 0 ? (
          <div className="text-[11px] text-neutral-400">No all-day events</div>
        ) : (
          allDayForDay.map(ev => (
            <button
              key={ev.id}
              type="button"
              onClick={e => {
                e.stopPropagation();
                handleClick(ev);
              }}
              className={`text-left text-[12px] truncate rounded px-2 py-0.5 border ${eventTone(ev)}`}
              title={ev.summary || "(no title)"}
            >
              <span className={ev.cancelled ? "line-through" : ""}>
                {ev.summary || "(no title)"}
              </span>
            </button>
          ))
        )}
      </div>

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
      <div className="relative" style={{ height: 24 * HOUR_HEIGHT }}>
        {Array.from({ length: 24 }, (_, h) => (
          <div
            key={h}
            role="button"
            tabIndex={-1}
            aria-label={`Create event at ${formatSlotLabel(h, 0)}`}
            onClick={e => {
              const rect = e.currentTarget.getBoundingClientRect();
              const offsetY = e.clientY - rect.top;
              const fraction = Math.max(0, Math.min(1, offsetY / HOUR_HEIGHT));
              const minute = Math.floor((fraction * 60) / SLOT_MINUTES) * SLOT_MINUTES;
              onCreateAt(slotDraftForDate(day, h, minute));
            }}
            className="border-b border-neutral-100 dark:border-neutral-900 cursor-pointer hover:bg-[var(--color-brand)]/5"
            style={{ height: HOUR_HEIGHT }}
          />
        ))}
        {timedForDay.map(ev => {
          const { top, height } = positionEvent(ev, day);
          return (
            <button
              key={ev.id}
              type="button"
              onClick={e => {
                e.stopPropagation();
                handleClick(ev);
              }}
              className={`absolute left-2 right-2 rounded text-left text-[12px] px-2 py-0.5 truncate border ${eventTone(ev)}`}
              style={{ top, height: Math.max(height, 18) }}
              title={ev.summary || "(no title)"}
            >
              <div className={`font-medium truncate ${ev.cancelled ? "line-through" : ""}`}>
                {ev.summary || "(no title)"}
              </div>
              {height > 28 && ev.location && (
                <div className="text-[10px] truncate text-neutral-600 dark:text-neutral-400">
                  {ev.location}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function formatHourLabel(h: number): string {
  if (h === 12) return "12 PM";
  if (h > 12) return `${h - 12} PM`;
  return `${h} AM`;
}

function formatSlotLabel(hour: number, minute: number): string {
  const h12 = ((hour + 11) % 12) + 1;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12}:${minute.toString().padStart(2, "0")} ${ampm}`;
}
