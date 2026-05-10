"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import CalendarDayGrid from "./CalendarDayGrid";
import CalendarEventForm from "./CalendarEventForm";
import CalendarMonthGrid from "./CalendarMonthGrid";
import CalendarWeekGrid from "./CalendarWeekGrid";

// Top-level page component for /inbox/calendar (#77). Owns the view-switch
// (day / week / month), the cursor date, the New Event modal, and the
// event-fetch loop. URL `?view=week&date=YYYY-MM-DD` is the persisted state
// so a copied URL re-opens to the same place — also gives the Help page
// + search results a deep-link target.
//
// Events are fetched per-view: each view computes its [from, to) window
// (in local time, then converted to unix seconds at the fetch boundary)
// and asks /api/calendar/events for the slice. The server caps the window
// to ~2 years on either side; the views always ask for a single month / week
// / day so we're well inside that.

export type CalendarView = "day" | "week" | "month";

// Quick-create handoff: a grid click ships a slot's start/end seconds (+
// all-day flag for month / all-day-strip clicks) and the manager opens the
// modal prefilled from those.
export interface NewEventDraft {
  kind: "new";
  startsAt?: number;
  endsAt?: number;
  allDay?: boolean;
}

export interface CalendarEvent {
  id: string;
  user_id: string;
  ical_uid: string | null;
  source: "invite" | "self" | "imported";
  source_message_id: string | null;
  starts_at: number;
  ends_at: number | null;
  all_day: number;
  summary: string | null;
  location: string | null;
  description: string | null;
  organizer_email: string | null;
  rsvp_status: "NEEDS-ACTION" | "ACCEPTED" | "TENTATIVE" | "DECLINED" | null;
  rsvp_sent_at: number | null;
  cancelled: number;
  raw_ics: string | null;
  created_at?: number;
  updated_at?: number;
}

export default function CalendarManager() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const initialView: CalendarView = parseView(searchParams.get("view"));
  const initialDate = parseDate(searchParams.get("date"));

  const [view, setView] = useState<CalendarView>(initialView);
  const [cursor, setCursor] = useState<Date>(initialDate);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Modal state: null = closed, NewEventDraft = create (optionally prefilled
  // from a grid click), otherwise an existing event in edit mode.
  const [editing, setEditing] = useState<CalendarEvent | NewEventDraft | null>(null);

  // Compute the fetch window for the current view. Week starts on Sunday —
  // mirrors the default for US users; international users will see a
  // Sunday-first week too in v1.
  const fetchWindow = useMemo(() => computeWindow(view, cursor), [view, cursor]);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/calendar/events?from=${fetchWindow.from}&to=${fetchWindow.to}`;
      const res = await fetch(url);
      const body = (await res.json().catch(() => ({}))) as {
        events?: CalendarEvent[];
        error?: string;
      };
      if (!res.ok) {
        setError(body.error || `Failed (${res.status})`);
        return;
      }
      setEvents(body.events ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [fetchWindow.from, fetchWindow.to]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // Keep the URL in sync so navigation feels right and links are sharable.
  // Using replace rather than push — view/date changes shouldn't flood the
  // back stack.
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", view);
    params.set("date", formatDateParam(cursor));
    const qs = params.toString();
    const next = qs ? `${pathname}?${qs}` : pathname;
    // Skip when already in sync (initial render carries the right params).
    if (typeof window === "undefined") return;
    if (window.location.pathname + window.location.search === next) return;
    router.replace(next, { scroll: false });
    // We intentionally exclude `router`, `pathname`, `searchParams` from
    // deps — they're stable enough and re-running on every searchParams
    // change would loop with our own replace().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, cursor]);

  function shiftCursor(delta: number) {
    const next = new Date(cursor);
    if (view === "day") next.setDate(next.getDate() + delta);
    else if (view === "week") next.setDate(next.getDate() + delta * 7);
    else next.setMonth(next.getMonth() + delta);
    setCursor(next);
  }

  function todayCursor() {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    setCursor(t);
  }

  function refresh() {
    return fetchEvents();
  }

  // Search filter: the global SearchBar routes `?q=` here when the user has
  // Calendar selected. We filter in-memory across the already-fetched window
  // (case-insensitive substring on summary / location / description). When
  // there's no query, this is a no-op.
  const searchQuery = (searchParams.get("q") ?? "").trim().toLowerCase();
  const filteredEvents = useMemo(() => {
    if (!searchQuery) return events;
    return events.filter(e => {
      const hay = `${e.summary ?? ""}\n${e.location ?? ""}\n${e.description ?? ""}`.toLowerCase();
      return hay.includes(searchQuery);
    });
  }, [events, searchQuery]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="border-b border-neutral-200 dark:border-neutral-800 px-4 py-3 flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold mr-2">Calendar</h1>
        {searchQuery && (
          <span className="text-xs text-neutral-500">
            Filtering by &ldquo;{searchQuery}&rdquo; · {filteredEvents.length} of {events.length}
          </span>
        )}

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => shiftCursor(-1)}
            aria-label="Previous"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-900"
          >
            <ChevronIcon dir="left" />
          </button>
          <button
            type="button"
            onClick={todayCursor}
            className="px-3 h-8 rounded-md border border-neutral-200 dark:border-neutral-800 text-xs font-medium hover:bg-neutral-100 dark:hover:bg-neutral-900"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => shiftCursor(1)}
            aria-label="Next"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-900"
          >
            <ChevronIcon dir="right" />
          </button>
        </div>

        <div className="text-sm font-medium ml-1">{formatHeader(view, cursor)}</div>

        <div className="ml-auto flex items-center gap-2">
          <div
            role="tablist"
            aria-label="Calendar view"
            className="inline-flex rounded-md border border-neutral-200 dark:border-neutral-800 overflow-hidden text-xs"
          >
            <ViewTab v="day" current={view} onSelect={setView} />
            <ViewTab v="week" current={view} onSelect={setView} />
            <ViewTab v="month" current={view} onSelect={setView} />
          </div>
          <button
            type="button"
            onClick={() => setEditing({ kind: "new" })}
            className="inline-flex items-center gap-1 rounded-md bg-[var(--color-brand)] text-white px-3 h-8 text-xs font-medium hover:opacity-90"
          >
            <span aria-hidden>+</span> New event
          </button>
        </div>
      </header>

      {error && (
        <div
          role="alert"
          className="border-b border-rose-200 bg-rose-50 dark:bg-rose-950/30 dark:border-rose-900 px-4 py-2 text-xs text-rose-800 dark:text-rose-300"
        >
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto min-h-0">
        {loading && events.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            Loading…
          </div>
        ) : view === "day" ? (
          <CalendarDayGrid
            cursor={cursor}
            events={filteredEvents}
            onEditEvent={ev => setEditing(ev)}
            onCreateAt={draft => setEditing(draft)}
          />
        ) : view === "week" ? (
          <CalendarWeekGrid
            cursor={cursor}
            events={filteredEvents}
            onEditEvent={ev => setEditing(ev)}
            onCreateAt={draft => setEditing(draft)}
          />
        ) : (
          <CalendarMonthGrid
            cursor={cursor}
            events={filteredEvents}
            onEditEvent={ev => setEditing(ev)}
            onSelectDate={d => {
              setCursor(d);
              setView("day");
            }}
            onCreateAt={draft => setEditing(draft)}
          />
        )}
      </div>

      {editing !== null && (
        <CalendarEventForm
          event={isNewDraft(editing) ? null : editing}
          defaults={
            isNewDraft(editing)
              ? {
                  startsAt: editing.startsAt,
                  endsAt: editing.endsAt,
                  allDay: editing.allDay,
                }
              : undefined
          }
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
          onDeleted={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function isNewDraft(x: CalendarEvent | NewEventDraft): x is NewEventDraft {
  return (x as NewEventDraft).kind === "new";
}

function ViewTab({
  v,
  current,
  onSelect,
}: {
  v: CalendarView;
  current: CalendarView;
  onSelect: (v: CalendarView) => void;
}) {
  const label = v === "day" ? "Day" : v === "week" ? "Week" : "Month";
  const active = v === current;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(v)}
      className={`px-3 h-8 ${
        active
          ? "bg-[var(--color-brand)]/15 text-[var(--color-brand)] font-medium"
          : "hover:bg-neutral-100 dark:hover:bg-neutral-900 text-neutral-700 dark:text-neutral-300"
      }`}
    >
      {label}
    </button>
  );
}

function ChevronIcon({ dir }: { dir: "left" | "right" }) {
  return dir === "left" ? (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M10.78 3.22a.75.75 0 0 1 0 1.06L7.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L5.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M5.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L8.94 8 5.22 4.28a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

function parseView(raw: string | null): CalendarView {
  if (raw === "day" || raw === "week" || raw === "month") return raw;
  return "week";
}

function parseDate(raw: string | null): Date {
  if (raw) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3]);
      if (!Number.isNaN(d.getTime())) {
        d.setHours(0, 0, 0, 0);
        return d;
      }
    }
  }
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return t;
}

function formatDateParam(d: Date): string {
  const yy = d.getFullYear().toString().padStart(4, "0");
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// Compute the [from, to) window the active view needs to render. We pad
// the month view to a 6-week grid (a month can start late and end early —
// the grid still wants 42 cells) so the event fetch covers spill-over days.
function computeWindow(view: CalendarView, cursor: Date): { from: number; to: number } {
  if (view === "day") {
    const from = new Date(cursor);
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return { from: Math.floor(from.getTime() / 1000), to: Math.floor(to.getTime() / 1000) };
  }
  if (view === "week") {
    const from = startOfWeek(cursor);
    const to = new Date(from);
    to.setDate(to.getDate() + 7);
    return { from: Math.floor(from.getTime() / 1000), to: Math.floor(to.getTime() / 1000) };
  }
  // month
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const from = startOfWeek(first);
  const to = new Date(from);
  to.setDate(to.getDate() + 42); // 6-week grid
  return { from: Math.floor(from.getTime() / 1000), to: Math.floor(to.getTime() / 1000) };
}

export function startOfWeek(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay(); // 0 = Sunday
  x.setDate(x.getDate() - day);
  return x;
}

function formatHeader(view: CalendarView, cursor: Date): string {
  if (view === "day") {
    return cursor.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }
  if (view === "week") {
    const s = startOfWeek(cursor);
    const e = new Date(s);
    e.setDate(e.getDate() + 6);
    const sameMonth = s.getMonth() === e.getMonth();
    if (sameMonth) {
      return `${s.toLocaleDateString(undefined, { month: "long", day: "numeric" })} – ${e.getDate()}, ${e.getFullYear()}`;
    }
    return `${s.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${e.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${e.getFullYear()}`;
  }
  return cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
