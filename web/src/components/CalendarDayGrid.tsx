"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { type CalendarEvent, type NewEventDraft } from "./CalendarManager";
import {
  allDayDraftForDate,
  allDayEventsForDay,
  eventStyle,
  eventTone,
  eventTzSubtitle,
  LONG_PRESS_MS,
  patchEvent,
  positionEvent,
  SLOT_MINUTES,
  TOUCH_SCROLL_CANCEL_PX,
  timedEventsForDay,
} from "./CalendarWeekGrid";
import { useMinuteTick } from "./useMinuteTick";

// Day view: single column with the same hour-row + absolute-event geometry
// as Week. Shares positioning helpers with CalendarWeekGrid so a layout
// tweak in one carries to the other.
//
// Drag interactions match the week view: drag-on-empty → create, drag-on
// -chip → move, drag-bottom-edge → resize. Patches go through the same
// `patchEvent` helper as the week grid.
//
// #93 follow-up: move drag on touch requires a long-press hold (matches
// week view) so vertical scrolling stays unimpeded. Cross-day is N/A here
// (single column).

interface Props {
  cursor: Date;
  events: CalendarEvent[];
  colorFor?: (ev: CalendarEvent) => string | null;
  onEditEvent: (ev: CalendarEvent) => void;
  onCreateAt: (draft: NewEventDraft) => void;
  onPatched?: () => void;
}

const HOUR_HEIGHT = 40;
const DRAG_THRESHOLD_PX = 3;

type DragState =
  | { kind: "create"; startMin: number; currentMin: number }
  | {
      kind: "move";
      eventId: string;
      startMin: number;
      durationMin: number;
      pointerStartMin: number;
      currentMin: number;
    }
  | { kind: "resize"; eventId: string; startMin: number; endMin: number };

// Touch-only "armed" placeholder while the long-press timer ticks. Becomes
// a real DragState.move once the timer fires; a sufficiently large
// pointermove cancels and lets the browser scroll.
type ArmedTouch = {
  pointerId: number;
  eventId: string;
  clientX: number;
  clientY: number;
  startMin: number;
  durationMin: number;
  // Snapped minute-of-day under the finger at pointerdown — used as the
  // promoted DragState.move's pointerStartMin so the chip doesn't jump.
  pointerStartMin: number;
};

export default function CalendarDayGrid({
  cursor,
  events,
  colorFor,
  onEditEvent,
  onCreateAt,
  onPatched,
}: Props) {
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
    <div className="grid calendar-day-grid" style={{ gridTemplateColumns: "60px 1fr" }}>
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
          allDayForDay.map(ev => {
            const override = colorFor?.(ev) ?? null;
            return (
              <button
                key={ev.id}
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  handleClick(ev);
                }}
                className={`text-left text-[12px] truncate rounded px-2 py-0.5 border ${eventTone(ev, override)}`}
                style={eventStyle(ev, override)}
                title={ev.summary || "(no title)"}
              >
                <span className={ev.cancelled ? "line-through" : ""}>
                  {ev.summary || "(no title)"}
                </span>
              </button>
            );
          })
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
      <DayBody
        date={day}
        events={timedForDay}
        colorFor={colorFor}
        onClick={handleClick}
        onCreateAt={onCreateAt}
        onPatched={onPatched}
      />
    </div>
  );
}

function DayBody({
  date,
  events,
  colorFor,
  onClick,
  onCreateAt,
  onPatched,
}: {
  date: Date;
  events: CalendarEvent[];
  colorFor?: (ev: CalendarEvent) => string | null;
  onClick: (ev: CalendarEvent) => void;
  onCreateAt: (draft: NewEventDraft) => void;
  onPatched?: () => void;
}) {
  const columnRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const viewerTz = useViewerTz();
  const tickMinute = useMinuteTick();
  const isToday = isSameDay(date, new Date());

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

  function yToMinute(clientY: number): number {
    const el = columnRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
    const totalMin = (y / HOUR_HEIGHT) * 60;
    return Math.max(
      0,
      Math.min(24 * 60, Math.round(totalMin / SLOT_MINUTES) * SLOT_MINUTES),
    );
  }

  function secondsAt(minutesOfDay: number): number {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setMinutes(minutesOfDay);
    return Math.floor(d.getTime() / 1000);
  }

  function commitMove(id: string, startMin: number, endMin: number) {
    patchEvent(id, { starts_at: secondsAt(startMin), ends_at: secondsAt(endMin) }).then(ok => {
      if (ok) onPatched?.();
    });
  }
  function commitResize(id: string, endMin: number) {
    patchEvent(id, { ends_at: secondsAt(endMin) }).then(ok => {
      if (ok) onPatched?.();
    });
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const minute = yToMinute(e.clientY);
    setDrag({ kind: "create", startMin: minute, currentMin: minute });
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    // Cancel a pending long-press if the finger drifted too far.
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
    const m = yToMinute(e.clientY);
    if (drag.kind === "create") setDrag({ ...drag, currentMin: m });
    else if (drag.kind === "move") setDrag({ ...drag, currentMin: m });
    else if (drag.kind === "resize") {
      const next = Math.max(drag.startMin + SLOT_MINUTES, Math.min(24 * 60, m));
      setDrag({ ...drag, endMin: next });
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    // Long-press still pending → no drag, fall through to chip click.
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
      if (drag.kind === "create") {
        const lo = Math.min(drag.startMin, drag.currentMin);
        const hi = Math.max(drag.startMin, drag.currentMin);
        const travelPx = Math.abs((drag.currentMin - drag.startMin) / 60) * HOUR_HEIGHT;
        if (travelPx < DRAG_THRESHOLD_PX) {
          onCreateAt({
            kind: "new",
            startsAt: secondsAt(lo),
            endsAt: secondsAt(lo + 60),
            allDay: false,
          });
        } else {
          onCreateAt({
            kind: "new",
            startsAt: secondsAt(lo),
            endsAt: secondsAt(Math.max(hi, lo + SLOT_MINUTES)),
            allDay: false,
          });
        }
        suppressClickRef.current = true;
      } else if (drag.kind === "move") {
        const delta = drag.currentMin - drag.pointerStartMin;
        const newStart = Math.max(
          0,
          Math.min(24 * 60 - drag.durationMin, drag.startMin + delta),
        );
        if (Math.abs(delta) >= 1) {
          commitMove(drag.eventId, newStart, newStart + drag.durationMin);
        }
        suppressClickRef.current = true;
      } else if (drag.kind === "resize") {
        commitResize(drag.eventId, drag.endMin);
        suppressClickRef.current = true;
      }
    } finally {
      setDrag(null);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ok
      }
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
  }

  const ghost = drag && drag.kind === "create" ? (() => {
    const lo = Math.min(drag.startMin, drag.currentMin);
    const hi = Math.max(drag.startMin, drag.currentMin);
    return {
      top: (lo / 60) * HOUR_HEIGHT,
      height: Math.max(((hi - lo) / 60) * HOUR_HEIGHT, 2),
    };
  })() : null;

  const nowOffset = (() => {
    if (!isToday) return null;
    const now = new Date();
    const min = now.getHours() * 60 + now.getMinutes();
    void tickMinute;
    return (min / 60) * HOUR_HEIGHT;
  })();

  return (
    <div
      ref={columnRef}
      className="relative select-none"
      style={{ height: 24 * HOUR_HEIGHT }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        clearLongPress();
        setDrag(null);
      }}
    >
      {Array.from({ length: 24 }, (_, h) => (
        <div
          key={h}
          aria-hidden
          className="border-b border-neutral-100 dark:border-neutral-900 hover:bg-[var(--color-brand)]/5"
          style={{ height: HOUR_HEIGHT }}
        />
      ))}
      {events.map(ev => {
        const { top, height } = positionEvent(ev, date);
        const override = colorFor?.(ev) ?? null;
        const styleOverride = eventStyle(ev, override);
        let liveTop = top;
        let liveHeight = Math.max(height, 18);
        if (drag && (drag.kind === "move" || drag.kind === "resize") && drag.eventId === ev.id) {
          if (drag.kind === "move") {
            const delta = drag.currentMin - drag.pointerStartMin;
            const newStart = Math.max(
              0,
              Math.min(24 * 60 - drag.durationMin, drag.startMin + delta),
            );
            liveTop = (newStart / 60) * HOUR_HEIGHT;
            liveHeight = (drag.durationMin / 60) * HOUR_HEIGHT;
          } else {
            liveTop = (drag.startMin / 60) * HOUR_HEIGHT;
            liveHeight = ((drag.endMin - drag.startMin) / 60) * HOUR_HEIGHT;
          }
        }
        const tzSubtitle = eventTzSubtitle(ev, viewerTz);
        const canMutate = ev.source === "self" && !ev.source_message_id;
        const isArmed = armedEventId === ev.id;
        const isActiveDrag = drag && drag.kind === "move" && drag.eventId === ev.id;
        const dragHaloClass = (isArmed || isActiveDrag)
          ? "ring-2 ring-[var(--color-brand)] shadow-lg"
          : "";
        return (
          <button
            key={ev.id}
            type="button"
            onPointerDown={e => {
              if (e.button !== 0) return;
              if (!canMutate) return;
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const inResizeHandle = e.clientY >= rect.bottom - 6;
              const { top: evTop, height: evH } = positionEvent(ev, date);
              const evStartMin = (evTop / HOUR_HEIGHT) * 60;
              const evDurMin = (evH / HOUR_HEIGHT) * 60;
              const evEndMin = evStartMin + evDurMin;
              const pointerMin = yToMinute(e.clientY);
              if (inResizeHandle) {
                setDrag({
                  kind: "resize",
                  eventId: ev.id,
                  startMin: evStartMin,
                  endMin: evEndMin,
                });
                if (columnRef.current) {
                  try {
                    columnRef.current.setPointerCapture(e.pointerId);
                  } catch {
                    // ok
                  }
                }
                e.stopPropagation();
                return;
              }

              if (e.pointerType === "touch") {
                // Arm long-press timer; upgrade to a real move drag if the
                // finger holds for LONG_PRESS_MS without drifting.
                armedRef.current = {
                  pointerId: e.pointerId,
                  eventId: ev.id,
                  clientX: e.clientX,
                  clientY: e.clientY,
                  startMin: evStartMin,
                  durationMin: evDurMin,
                  pointerStartMin: pointerMin,
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
                    kind: "move",
                    eventId: armed.eventId,
                    startMin: armed.startMin,
                    durationMin: armed.durationMin,
                    pointerStartMin: armed.pointerStartMin,
                    currentMin: armed.pointerStartMin,
                  });
                  longPressTimerRef.current = null;
                }, LONG_PRESS_MS);
                if (columnRef.current) {
                  try {
                    columnRef.current.setPointerCapture(e.pointerId);
                  } catch {
                    // ok
                  }
                }
                return;
              }

              // Mouse / pen → drag immediately.
              setDrag({
                kind: "move",
                eventId: ev.id,
                startMin: evStartMin,
                durationMin: evDurMin,
                pointerStartMin: pointerMin,
                currentMin: pointerMin,
              });
              if (columnRef.current) {
                try {
                  columnRef.current.setPointerCapture(e.pointerId);
                } catch {
                  // ok
                }
              }
              e.stopPropagation();
              // evEndMin is informational — no further use needed here.
              void evEndMin;
            }}
            onClick={e => {
              if (suppressClickRef.current) {
                e.stopPropagation();
                return;
              }
              e.stopPropagation();
              onClick(ev);
            }}
            className={`absolute left-2 right-2 rounded text-left text-[12px] px-2 py-0.5 truncate border ${eventTone(ev, override)} ${canMutate ? "cursor-grab" : ""} ${dragHaloClass}`}
            style={{ top: liveTop, height: Math.max(liveHeight, 18), ...(styleOverride ?? {}) }}
            title={ev.summary || "(no title)"}
          >
            <div className={`font-medium truncate ${ev.cancelled ? "line-through" : ""}`}>
              {ev.summary || "(no title)"}
            </div>
            {tzSubtitle && (
              <div className="text-[10px] truncate opacity-70">{tzSubtitle}</div>
            )}
            {liveHeight > 28 && ev.location && (
              <div className="text-[10px] truncate text-neutral-600 dark:text-neutral-400">
                {ev.location}
              </div>
            )}
            {canMutate && (
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-1 cursor-ns-resize"
              />
            )}
          </button>
        );
      })}
      {ghost && (
        <div
          aria-hidden
          className="absolute left-2 right-2 rounded border border-[var(--color-brand)] bg-[var(--color-brand)]/15 pointer-events-none"
          style={{ top: ghost.top, height: Math.max(ghost.height, 4) }}
        />
      )}
      {nowOffset != null && (
        <div
          aria-hidden
          className="now-line absolute left-0 right-0 pointer-events-none"
          style={{ top: nowOffset }}
        >
          <div className="absolute left-0 -translate-x-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-red-500" />
          <div className="h-px bg-red-500" />
        </div>
      )}
    </div>
  );
}

function useViewerTz(): string | null {
  const [tz, setTz] = useState<string | null>(null);
  useEffect(() => {
    // One-shot read of the platform-resolved zone. The React 19 rule
    // about setState-in-effect doesn't have a cleaner expression for
    // "read a browser API on mount" — this is the canonical pattern.
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTz(Intl.DateTimeFormat().resolvedOptions().timeZone || null);
    } catch {
      setTz(null);
    }
  }, []);
  return tz;
}

function formatHourLabel(h: number): string {
  if (h === 12) return "12 PM";
  if (h > 12) return `${h - 12} PM`;
  return `${h} AM`;
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
