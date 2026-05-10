"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  type CalendarEvent,
  type NewEventDraft,
  startOfWeekFor,
} from "./CalendarManager";
import {
  allDayDraftForDate,
  eventStyle,
  eventTone,
  LONG_PRESS_MS,
  patchEvent,
  TOUCH_SCROLL_CANCEL_PX,
} from "./CalendarWeekGrid";

// Month view: 6×7 day-cell grid. Each cell shows up to MAX_PER_CELL event
// titles; overflow opens a small "more…" popover with the full day's list
// instead of jumping to day view (#87). Clicking the date number still
// switches to Day view for users who want the timed grid for that day.
//
// #93 follow-up: drag an event chip from one cell to another to reschedule
// it onto a different day, preserving the source time-of-day. Touch
// requires a long-press hold to engage; mouse drags fire immediately.

const MAX_PER_CELL = 3;
const DRAG_THRESHOLD_PX = 3;

interface Props {
  cursor: Date;
  events: CalendarEvent[];
  colorFor?: (ev: CalendarEvent) => string | null;
  weekStartDay: number;
  onEditEvent: (ev: CalendarEvent) => void;
  onSelectDate: (d: Date) => void;
  onCreateAt: (draft: NewEventDraft) => void;
  onPatched?: () => void;
}

// Active drag for a chip moving between day cells. We keep the source
// event id, the source date (so we can compute its starts_at delta), and
// the date currently under the pointer. The PATCH on drop preserves the
// event's time-of-day and only swaps the date.
type DragState = {
  eventId: string;
  source: CalendarEvent;
  sourceDate: Date;
  currentDate: Date;
  // Track travel so we can distinguish a click from a drag.
  startClientX: number;
  startClientY: number;
  travelPx: number;
};

// Touch-only "armed" placeholder. Set on pointerdown; promoted to a real
// DragState once LONG_PRESS_MS elapses without significant movement.
type ArmedTouch = {
  pointerId: number;
  eventId: string;
  source: CalendarEvent;
  sourceDate: Date;
  clientX: number;
  clientY: number;
};

export default function CalendarMonthGrid({
  cursor,
  events,
  colorFor,
  weekStartDay,
  onEditEvent,
  onSelectDate,
  onCreateAt,
  onPatched,
}: Props) {
  const router = useRouter();
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const gridStart = startOfWeekFor(first, weekStartDay);
  const cells: Date[] = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + i);
    return d;
  });

  // Per-cell ref so a pointermove on the grid can resolve clientX/Y → cell
  // → date by hit-testing each rect.
  const cellRefs = useRef<Array<HTMLDivElement | null>>(
    Array(42).fill(null) as Array<HTMLDivElement | null>,
  );

  const [drag, setDrag] = useState<DragState | null>(null);
  const suppressClickRef = useRef(false);

  const longPressTimerRef = useRef<number | null>(null);
  const armedRef = useRef<ArmedTouch | null>(null);
  const [armedEventId, setArmedEventId] = useState<string | null>(null);

  function clearLongPress() {
    if (longPressTimerRef.current != null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    armedRef.current = null;
    setArmedEventId(null);
  }

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current != null) {
        window.clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  function handleClick(ev: CalendarEvent) {
    if (ev.source_message_id) {
      router.push(`/inbox/all/${ev.source_message_id}`);
      return;
    }
    if (ev.source === "self") onEditEvent(ev);
  }

  // Hit-test the cell refs to find which date the pointer is over. Returns
  // null if outside every cell — the caller treats null as "stay on the
  // previous current date" so the preview doesn't flicker mid-drag.
  function pointToDate(clientX: number, clientY: number): Date | null {
    for (let i = 0; i < 42; i++) {
      const el = cellRefs.current[i];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      ) {
        return cells[i];
      }
    }
    return null;
  }

  function startEventDrag(
    e: React.PointerEvent<HTMLElement>,
    ev: CalendarEvent,
    sourceDate: Date,
  ) {
    if (e.button !== 0) return;
    if (ev.source !== "self" || ev.source_message_id) return;

    if (e.pointerType === "touch") {
      armedRef.current = {
        pointerId: e.pointerId,
        eventId: ev.id,
        source: ev,
        sourceDate,
        clientX: e.clientX,
        clientY: e.clientY,
      };
      setArmedEventId(ev.id);
      longPressTimerRef.current = window.setTimeout(() => {
        const armed = armedRef.current;
        if (!armed) return;
        try {
          navigator.vibrate?.(20);
        } catch {
          // ok
        }
        setDrag({
          eventId: armed.eventId,
          source: armed.source,
          sourceDate: armed.sourceDate,
          currentDate: armed.sourceDate,
          startClientX: armed.clientX,
          startClientY: armed.clientY,
          travelPx: 0,
        });
        longPressTimerRef.current = null;
      }, LONG_PRESS_MS);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // ok
      }
      return;
    }

    // Mouse / pen → drag immediately.
    setDrag({
      eventId: ev.id,
      source: ev,
      sourceDate,
      currentDate: sourceDate,
      startClientX: e.clientX,
      startClientY: e.clientY,
      travelPx: 0,
    });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ok
    }
    e.stopPropagation();
  }

  function onGridPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const armed = armedRef.current;
    if (armed && armed.pointerId === e.pointerId && !drag) {
      const dx = Math.abs(e.clientX - armed.clientX);
      const dy = Math.abs(e.clientY - armed.clientY);
      if (Math.max(dx, dy) > TOUCH_SCROLL_CANCEL_PX) {
        clearLongPress();
        try {
          (e.currentTarget as Element).releasePointerCapture(e.pointerId);
        } catch {
          // ok
        }
      }
      return;
    }

    if (!drag) return;
    const newDate = pointToDate(e.clientX, e.clientY);
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    const travelPx = Math.sqrt(dx * dx + dy * dy);
    setDrag(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        currentDate: newDate ?? prev.currentDate,
        travelPx,
      };
    });
  }

  function onGridPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (armedRef.current && !drag) {
      clearLongPress();
      try {
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      } catch {
        // ok
      }
      return;
    }
    if (!drag) return;
    try {
      const moved = !isSameDay(drag.currentDate, drag.sourceDate);
      const traveledEnough = drag.travelPx >= DRAG_THRESHOLD_PX;
      if (moved && traveledEnough) {
        // Preserve time-of-day: compute the source's offset within its
        // local day, then reapply on top of the new date's midnight.
        const src = drag.source;
        const sourceMidnight = new Date(drag.sourceDate);
        sourceMidnight.setHours(0, 0, 0, 0);
        const offsetMs = src.starts_at * 1000 - sourceMidnight.getTime();
        const duration = src.ends_at != null ? src.ends_at - src.starts_at : null;

        const targetMidnight = new Date(drag.currentDate);
        targetMidnight.setHours(0, 0, 0, 0);
        const newStartMs = targetMidnight.getTime() + offsetMs;
        const newStart = Math.floor(newStartMs / 1000);
        const patch: { starts_at: number; ends_at?: number | null } = {
          starts_at: newStart,
        };
        if (duration != null) {
          patch.ends_at = newStart + duration;
        }
        patchEvent(drag.eventId, patch).then(ok => {
          if (ok) onPatched?.();
        });
        suppressClickRef.current = true;
      } else if (traveledEnough) {
        // Dragged but ended on the same cell — still suppress the click so
        // the chip doesn't open the edit modal mid-gesture.
        suppressClickRef.current = true;
      }
    } finally {
      setDrag(null);
      try {
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      } catch {
        // ok
      }
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
  }

  function onGridPointerCancel() {
    clearLongPress();
    setDrag(null);
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
      <div
        className="grid grid-cols-7 grid-rows-6 flex-1 min-h-0"
        onPointerMove={onGridPointerMove}
        onPointerUp={onGridPointerUp}
        onPointerCancel={onGridPointerCancel}
      >
        {cells.map((d, idx) => {
          const isDropTarget = drag != null && isSameDay(d, drag.currentDate)
            && !isSameDay(d, drag.sourceDate);
          return (
            <DayCell
              key={d.toISOString()}
              date={d}
              month={cursor.getMonth()}
              events={eventsForDay(events, d)}
              colorFor={colorFor}
              onEventClick={handleClick}
              onSelectDate={onSelectDate}
              onCreate={() => onCreateAt(allDayDraftForDate(d))}
              registerRef={el => {
                cellRefs.current[idx] = el;
              }}
              onChipPointerDown={(e, ev) => startEventDrag(e, ev, d)}
              suppressClickRef={suppressClickRef}
              armedEventId={armedEventId}
              activeDragEventId={drag?.eventId ?? null}
              isDropTarget={isDropTarget}
            />
          );
        })}
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
  registerRef,
  onChipPointerDown,
  suppressClickRef,
  armedEventId,
  activeDragEventId,
  isDropTarget,
}: {
  date: Date;
  month: number;
  events: CalendarEvent[];
  colorFor?: (ev: CalendarEvent) => string | null;
  onEventClick: (ev: CalendarEvent) => void;
  onSelectDate: (d: Date) => void;
  onCreate: () => void;
  registerRef: (el: HTMLDivElement | null) => void;
  onChipPointerDown: (
    e: React.PointerEvent<HTMLElement>,
    ev: CalendarEvent,
  ) => void;
  suppressClickRef: React.MutableRefObject<boolean>;
  armedEventId: string | null;
  activeDragEventId: string | null;
  isDropTarget: boolean;
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
      ref={registerRef}
      role="button"
      tabIndex={0}
      aria-label={`Create event on ${date.toDateString()}`}
      onClick={() => {
        if (suppressClickRef.current) return;
        onCreate();
      }}
      onKeyDown={e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onCreate();
        }
      }}
      className={`relative border-b border-r border-neutral-200 dark:border-neutral-800 p-1 flex flex-col min-h-[6rem] cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900/40 ${
        inMonth ? "bg-white dark:bg-neutral-950" : "bg-neutral-50 dark:bg-neutral-900/50"
      } ${isDropTarget ? "ring-2 ring-inset ring-[var(--color-brand)] bg-[var(--color-brand)]/5" : ""}`}
    >
      <button
        type="button"
        onClick={e => {
          e.stopPropagation();
          if (suppressClickRef.current) return;
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
          const canMutate = ev.source === "self" && !ev.source_message_id;
          const isArmed = armedEventId === ev.id;
          const isActiveDrag = activeDragEventId === ev.id;
          const dragHaloClass = (isArmed || isActiveDrag)
            ? "ring-2 ring-[var(--color-brand)] shadow-md"
            : "";
          return (
            <button
              key={ev.id}
              type="button"
              onPointerDown={e => {
                if (canMutate) onChipPointerDown(e, ev);
              }}
              onClick={e => {
                e.stopPropagation();
                if (suppressClickRef.current) return;
                onEventClick(ev);
              }}
              className={`text-left text-[10px] leading-tight truncate rounded px-1 py-px border ${eventTone(ev, override)} ${canMutate ? "cursor-grab" : ""} ${dragHaloClass}`}
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
