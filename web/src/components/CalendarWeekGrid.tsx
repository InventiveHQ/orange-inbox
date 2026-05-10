"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  type CalendarEvent,
  type NewEventDraft,
  startOfWeekFor,
} from "./CalendarManager";
import { useMinuteTick } from "./useMinuteTick";

// Week view: 7 columns × 24 hour rows + an all-day strip across the top.
// Events are absolute-positioned by their start hour + duration; clicks on
// an invite navigate back to the source thread, clicks on a self event
// open the edit form. Clicks on empty hour cells / all-day strip open the
// New Event modal prefilled with that slot's time.
//
// Drag interactions (#79):
//   - drag-to-create: pointerdown on empty space → ghost block → pointerup
//     opens the New Event modal prefilled with the dragged start/end.
//   - drag-to-move: pointerdown on an event chip body → translates the
//     event in 30-minute snaps; pointerup PATCHes the new starts_at/ends_at.
//   - drag-to-resize: pointerdown on the bottom-edge handle of an event
//     chip → drags the end forward; pointerup PATCHes the new ends_at.
//   - Click vs drag: anything under DRAG_THRESHOLD_PX (≈3) stays a click.

interface Props {
  cursor: Date;
  events: CalendarEvent[];
  // Per-event color override (#78). The CalendarManager provides a lookup
  // that maps the event's mailbox_id back to the user's calendar prefs;
  // returning null falls back to the default sky/brand tones.
  colorFor?: (ev: CalendarEvent) => string | null;
  weekStartDay: number;
  onEditEvent: (ev: CalendarEvent) => void;
  onCreateAt: (draft: NewEventDraft) => void;
  // Called after a successful drag-move/resize PATCH so the parent can
  // refresh the event list — keeps the displayed geometry in sync without
  // a full page reload.
  onPatched?: () => void;
}

const HOUR_HEIGHT = 40; // px — also drives slot row height in the grid template
const SLOT_MINUTES = 30; // quick-create snap granularity
const DRAG_THRESHOLD_PX = 3; // pointer travel under this stays a click

export default function CalendarWeekGrid({
  cursor,
  events,
  colorFor,
  weekStartDay,
  onEditEvent,
  onCreateAt,
  onPatched,
}: Props) {
  const router = useRouter();
  const weekStart = startOfWeekFor(cursor, weekStartDay);
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
    <div className="grid calendar-week-grid" style={{ gridTemplateColumns: "60px repeat(7, 1fr)" }}>
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
          onPatched={onPatched}
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

// Internal drag state for a DayColumn. Drag-to-create draws a translucent
// ghost block between the pointerdown slot and the current pointer; the
// modal opens on pointerup. Drag-to-move/resize tracks an event id +
// initial geometry so pointermove can paint an in-flight preview without
// committing until pointerup.
type DragState =
  | { kind: "create"; startMin: number; currentMin: number }
  | {
      kind: "move";
      eventId: string;
      startMin: number;     // original event start (minutes from midnight)
      durationMin: number;
      pointerStartMin: number;
      currentMin: number;
    }
  | {
      kind: "resize";
      eventId: string;
      startMin: number;
      endMin: number;       // current end (minutes from midnight)
    };

function DayColumn({
  date,
  events,
  colorFor,
  onClick,
  onCreate,
  onPatched,
}: {
  date: Date;
  events: CalendarEvent[];
  colorFor?: (ev: CalendarEvent) => string | null;
  onClick: (e: CalendarEvent) => void;
  onCreate: (draft: NewEventDraft) => void;
  onPatched?: () => void;
}) {
  const columnRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  // Suppresses the click handlers that fire after a drag pointerup; React
  // delivers a click event right after pointerup on the same element, and
  // we don't want the empty-cell click to also pop a New Event modal.
  const suppressClickRef = useRef(false);
  const viewerTz = useViewerTz();

  // Convert clientY to absolute minutes-of-day, snapped to SLOT_MINUTES.
  function yToMinute(clientY: number): number {
    const el = columnRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
    const totalMin = (y / HOUR_HEIGHT) * 60;
    return Math.max(0, Math.min(24 * 60, Math.round(totalMin / SLOT_MINUTES) * SLOT_MINUTES));
  }

  function commitMove(eventId: string, newStartMin: number, newEndMin: number) {
    const startsAt = secondsAt(date, newStartMin);
    const endsAt = secondsAt(date, newEndMin);
    patchEvent(eventId, { starts_at: startsAt, ends_at: endsAt }).then(ok => {
      if (ok) onPatched?.();
    });
  }

  function commitResize(eventId: string, newEndMin: number) {
    const endsAt = secondsAt(date, newEndMin);
    patchEvent(eventId, { ends_at: endsAt }).then(ok => {
      if (ok) onPatched?.();
    });
  }

  function onColumnPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Only react to the primary button. Right-clicks / middle-clicks fall
    // through to default browser behavior.
    if (e.button !== 0) return;
    // Skip if the actual target is a button/chip — those have their own
    // pointer handlers.
    if ((e.target as HTMLElement).closest("button")) return;
    const minute = yToMinute(e.clientY);
    setDrag({ kind: "create", startMin: minute, currentMin: minute });
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onColumnPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const m = yToMinute(e.clientY);
    if (drag.kind === "create") {
      setDrag({ ...drag, currentMin: m });
      return;
    }
    if (drag.kind === "move") {
      setDrag({ ...drag, currentMin: m });
      return;
    }
    if (drag.kind === "resize") {
      // Resize can't take the end past midnight or before its start.
      const next = Math.max(drag.startMin + SLOT_MINUTES, Math.min(24 * 60, m));
      setDrag({ ...drag, endMin: next });
      return;
    }
  }

  function onColumnPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag) return;
    try {
      if (drag.kind === "create") {
        const { startMin, currentMin } = drag;
        const lo = Math.min(startMin, currentMin);
        const hi = Math.max(startMin, currentMin);
        // Click-vs-drag: if the user barely moved, treat as a click and
        // default to a 1-hour block from the clicked slot.
        const travelPx = Math.abs((currentMin - startMin) / 60) * HOUR_HEIGHT;
        if (travelPx < DRAG_THRESHOLD_PX) {
          onCreate(slotDraftForMinutes(date, lo, lo + 60));
        } else {
          onCreate(slotDraftForMinutes(date, lo, Math.max(hi, lo + SLOT_MINUTES)));
        }
        suppressClickRef.current = true;
      } else if (drag.kind === "move") {
        const delta = drag.currentMin - drag.pointerStartMin;
        const newStart = Math.max(0, Math.min(24 * 60 - drag.durationMin, drag.startMin + delta));
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
        // Capture may already have been released on a child node — ignore.
      }
      // Clear the suppress flag on the next tick so a future click is
      // accepted normally.
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
  }

  // The today column gets a horizontal red now-line at the current minute.
  const tickMinute = useMinuteTick();
  const isTodayColumn = isSameDay(date, new Date());
  const nowOffset = (() => {
    if (!isTodayColumn) return null;
    const now = new Date();
    const min = now.getHours() * 60 + now.getMinutes();
    // tickMinute is read so the component re-renders each minute; the
    // actual y-offset comes from `now` which lines up to the second.
    void tickMinute;
    return (min / 60) * HOUR_HEIGHT;
  })();

  // Render the ghost block for a drag-to-create in progress.
  const ghost = drag && drag.kind === "create" ? (() => {
    const lo = Math.min(drag.startMin, drag.currentMin);
    const hi = Math.max(drag.startMin, drag.currentMin);
    return {
      top: (lo / 60) * HOUR_HEIGHT,
      height: Math.max(((hi - lo) / 60) * HOUR_HEIGHT, 2),
    };
  })() : null;

  return (
    <div
      ref={columnRef}
      className="relative border-r border-neutral-200 dark:border-neutral-800 select-none"
      style={{ height: 24 * HOUR_HEIGHT }}
      onPointerDown={onColumnPointerDown}
      onPointerMove={onColumnPointerMove}
      onPointerUp={onColumnPointerUp}
      onPointerCancel={() => setDrag(null)}
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
        // If this event is currently being dragged, override its geometry
        // with the in-flight values so the user sees the live preview.
        let liveTop = top;
        let liveHeight = Math.max(height, 16);
        if (drag && (drag.kind === "move" || drag.kind === "resize") && drag.eventId === ev.id) {
          if (drag.kind === "move") {
            const delta = drag.currentMin - drag.pointerStartMin;
            const newStart = Math.max(0, Math.min(24 * 60 - drag.durationMin, drag.startMin + delta));
            liveTop = (newStart / 60) * HOUR_HEIGHT;
            liveHeight = (drag.durationMin / 60) * HOUR_HEIGHT;
          } else {
            liveTop = (drag.startMin / 60) * HOUR_HEIGHT;
            liveHeight = ((drag.endMin - drag.startMin) / 60) * HOUR_HEIGHT;
          }
        }
        const tzSubtitle = eventTzSubtitle(ev, viewerTz);
        const canMutate = ev.source === "self" && !ev.source_message_id;
        return (
          <button
            key={ev.id}
            type="button"
            data-event-id={ev.id}
            onPointerDown={e => {
              if (e.button !== 0) return;
              if (!canMutate) return;
              // Resize handle: bottom 6px of the chip → resize, else move.
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
              } else {
                setDrag({
                  kind: "move",
                  eventId: ev.id,
                  startMin: evStartMin,
                  durationMin: evDurMin,
                  pointerStartMin: pointerMin,
                  currentMin: pointerMin,
                });
              }
              // Capture on the column so subsequent move/up fire there
              // even if the pointer leaves the chip rect.
              if (columnRef.current) {
                try {
                  columnRef.current.setPointerCapture(e.pointerId);
                } catch {
                  // Some browsers throw if capture already set — fine.
                }
              }
              e.stopPropagation();
            }}
            onClick={e => {
              if (suppressClickRef.current) {
                // Drag just ended — swallow the synthetic click.
                e.stopPropagation();
                return;
              }
              e.stopPropagation();
              onClick(ev);
            }}
            className={`absolute left-1 right-1 rounded text-left text-[11px] px-1.5 py-0.5 truncate border ${eventTone(ev, override)} ${canMutate ? "cursor-grab" : ""}`}
            // Merge geometry + tone style. eventStyle returns undefined
            // for the no-override path, so we spread conditionally.
            style={{ top: liveTop, height: Math.max(liveHeight, 16), ...(styleOverride ?? {}) }}
            title={ev.summary || "(no title)"}
          >
            <span className={ev.cancelled ? "line-through" : ""}>
              {ev.summary || "(no title)"}
            </span>
            {tzSubtitle && (
              <span className="block text-[9px] opacity-70 truncate">{tzSubtitle}</span>
            )}
            {canMutate && (
              <span
                aria-hidden
                // Tiny non-interactive handle bar — pointerdown for resize
                // is detected via clientY against the chip rect, so this
                // span is purely a visual affordance.
                className="absolute inset-x-0 bottom-0 h-1 cursor-ns-resize"
              />
            )}
          </button>
        );
      })}
      {ghost && (
        <div
          aria-hidden
          className="absolute left-1 right-1 rounded border border-[var(--color-brand)] bg-[var(--color-brand)]/15 pointer-events-none"
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

// PATCH /api/calendar/events/[id] with new starts_at/ends_at. Returns true
// on success; failures are swallowed so a stale optimistic UI flips back
// on the next refresh.
async function patchEvent(
  id: string,
  patch: { starts_at?: number; ends_at?: number | null },
): Promise<boolean> {
  try {
    const res = await fetch(`/api/calendar/events/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function secondsAt(date: Date, minutesOfDay: number): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutesOfDay);
  return Math.floor(d.getTime() / 1000);
}

function slotDraftForMinutes(date: Date, startMin: number, endMin: number): NewEventDraft {
  return {
    kind: "new",
    startsAt: secondsAt(date, startMin),
    endsAt: secondsAt(date, endMin),
    allDay: false,
  };
}

// Returned for callers (DayGrid) that still construct drafts from
// (hour, minute) — keeps the old factory available so the day grid's
// quick-create paths don't need a rewrite.
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

export { allDayDraftForDate, slotDraftForDate, SLOT_MINUTES, patchEvent };

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

// Viewer's IANA zone, computed once per browser session. We use it to
// decide when an event's `tz` is worth surfacing as a subtitle — if it
// matches the viewer's zone, we'd just be noise.
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

// Build the small "10:00 AM PT" subtitle for an event whose source tz
// differs from the viewer's.
export function eventTzSubtitle(ev: CalendarEvent, viewerTz: string | null): string | null {
  const tz = ev.tz;
  if (!tz || !viewerTz || tz === viewerTz) return null;
  if (ev.all_day === 1) return null;
  // Format the event's start time in its source zone. Trim to short
  // weekday-less form — column already conveys the date.
  let timeStr: string;
  try {
    timeStr = new Date(ev.starts_at * 1000).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz,
    });
  } catch {
    return null;
  }
  return `${timeStr} ${shortTz(tz)}`;
}

// "America/Los_Angeles" → "Los Angeles". For the IANA UTC-zone family we
// strip the prefix; legacy/unprefixed entries get returned as-is so we
// always have something printable.
function shortTz(tz: string): string {
  const idx = tz.indexOf("/");
  if (idx === -1) return tz;
  return tz.slice(idx + 1).replace(/_/g, " ");
}

