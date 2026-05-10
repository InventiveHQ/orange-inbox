"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  // Per-mailbox attribution (#78). NULL = Personal calendar.
  mailbox_id: string | null;
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
  // IANA tz (#82). NULL = floating / viewer-local.
  tz?: string | null;
  // Recurrence (#80). RFC 5545 RRULE value sans the "RRULE:" prefix.
  // NULL = single-shot. The form's "Repeats" picker round-trips this.
  rrule?: string | null;
  rdate?: string | null;
  exdate?: string | null;
  created_at?: number;
  updated_at?: number;
}

// Sidebar entry (#78). One row per accessible calendar; "personal" is
// always present, mailbox calendars come from listMailboxesForUser.
export interface CalendarSummary {
  id: string;             // "personal" or mailbox id — what the API takes back
  mailbox_id: string | null;
  name: string;
  color: string;          // hex, fallback default supplied by the API
  hidden: boolean;
  kind: "personal" | "mailbox";
}

// Marker for "no specific calendar selected" — i.e. the consolidated view.
// Distinct from "personal" (the literal Personal calendar) which is also a
// valid sidebar selection.
const SCOPE_ALL = "all" as const;
type ScopeSelection = typeof SCOPE_ALL | string; // "all" | "personal" | mailbox id

export default function CalendarManager() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const initialView: CalendarView = parseView(searchParams.get("view"));
  const initialDate = parseDate(searchParams.get("date"));
  // Sidebar scope: which calendar the grid is filtered to. Stored in the
  // URL so a copied link re-opens to the same view. Default = consolidated.
  const initialScope: ScopeSelection = searchParams.get("calendar") ?? SCOPE_ALL;

  const [view, setView] = useState<CalendarView>(initialView);
  const [cursor, setCursor] = useState<Date>(initialDate);
  const [scope, setScope] = useState<ScopeSelection>(initialScope);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [calendars, setCalendars] = useState<CalendarSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Modal state: null = closed, NewEventDraft = create (optionally prefilled
  // from a grid click), otherwise an existing event in edit mode.
  const [editing, setEditing] = useState<CalendarEvent | NewEventDraft | null>(null);
  // 0 = Sunday, 1 = Monday. Sourced from `users.week_start_day` via
  // /api/me/preferences on mount; we render Sunday-first until the fetch
  // returns so the first-paint window doesn't flicker.
  const [weekStartDay, setWeekStartDay] = useState<0 | 1>(0);
  // Visibility of the header date-picker popover (#84). Toggled by the
  // "Go to date" button and dismissed on outside click / Escape.
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Compute the fetch window for the current view. Honors the user's
  // week-start preference once it's loaded (default Sunday).
  const fetchWindow = useMemo(
    () => computeWindow(view, cursor, weekStartDay),
    [view, cursor, weekStartDay],
  );

  // Calendar list — loaded once on mount, refreshed after a pref change.
  // The grid-event list is independent so a color tweak doesn't have to
  // re-fetch the heavier event window.
  const fetchCalendars = useCallback(async () => {
    try {
      const res = await fetch("/api/calendar/calendars");
      const body = (await res.json().catch(() => ({}))) as {
        calendars?: CalendarSummary[];
      };
      if (res.ok) setCalendars(body.calendars ?? []);
    } catch {
      // Soft-fail — the grid still works without prefs (default colors,
      // no hide filtering); the next refresh attempt will retry.
    }
  }, []);
  useEffect(() => {
    // Mirror the fetchEvents pattern below — fetchCalendars is wrapped in
    // useCallback and only setState's the calendar list on response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchCalendars();
  }, [fetchCalendars]);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Pick up the scope filter — "all" omits the param so the API
      // returns the consolidated view (with hidden calendars stripped).
      const url = new URL("/api/calendar/events", window.location.origin);
      url.searchParams.set("from", String(fetchWindow.from));
      url.searchParams.set("to", String(fetchWindow.to));
      if (scope !== SCOPE_ALL) url.searchParams.set("mailbox", scope);
      const res = await fetch(url.pathname + url.search);
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
  }, [fetchWindow.from, fetchWindow.to, scope]);

  useEffect(() => {
    // fetchEvents wraps setLoading/setEvents — the same pattern as
    // fetchCalendars above; the React 19 "no setState in effect" rule
    // doesn't apply when the setter is gated on a network response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchEvents();
  }, [fetchEvents]);

  // Load the week-start preference once on mount. We don't gate first
  // render on it — Sunday is the right default for most users and the
  // refresh that fires when the value lands is cheap.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/me/preferences");
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as
          | { week_start_day?: number }
          | null;
        if (cancelled) return;
        if (body?.week_start_day === 1) setWeekStartDay(1);
        else setWeekStartDay(0);
      } catch {
        // soft-fail: stick with the default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // mailbox_id → color lookup so the grid can paint each event with its
  // calendar's swatch. Personal events (mailbox_id null) use the Personal
  // pref color; missing entries fall back to the original hard-coded tones
  // in eventTone.
  const colorByMailbox = useMemo(() => {
    const m = new Map<string | null, string>();
    for (const c of calendars) m.set(c.mailbox_id, c.color);
    return m;
  }, [calendars]);
  const colorFor = useCallback(
    (ev: CalendarEvent): string | null => colorByMailbox.get(ev.mailbox_id) ?? null,
    [colorByMailbox],
  );

  // Patch a calendar pref (color or hidden). Optimistically updates the
  // sidebar so the swatch + checkbox don't lag the click; on failure we
  // re-fetch to undo.
  const updateCalendar = useCallback(
    async (id: string, patch: { color?: string; hidden?: boolean }) => {
      // Snapshot for rollback.
      const prev = calendars;
      setCalendars(prev.map(c => (c.id === id ? { ...c, ...patch } : c)));
      try {
        const res = await fetch("/api/calendar/calendars", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mailbox_id: id, // API normalises "personal" → null on its side
            ...patch,
          }),
        });
        if (!res.ok) {
          // Rollback. fetchCalendars() will overwrite anyway, but this
          // keeps the visual blip short.
          setCalendars(prev);
          fetchCalendars();
          return;
        }
        // Hidden toggles affect the consolidated view's row set — re-fetch
        // events so the grid mirrors the new visibility.
        if (patch.hidden !== undefined && scope === SCOPE_ALL) {
          fetchEvents();
        }
      } catch {
        setCalendars(prev);
      }
    },
    [calendars, fetchCalendars, fetchEvents, scope],
  );

  // Keep the URL in sync so navigation feels right and links are sharable.
  // Using replace rather than push — view/date changes shouldn't flood the
  // back stack.
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", view);
    params.set("date", formatDateParam(cursor));
    if (scope === SCOPE_ALL) params.delete("calendar");
    else params.set("calendar", scope);
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
  }, [view, cursor, scope]);

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

  // Calendar-scoped keyboard shortcuts (#87). Document-level listener so
  // the user can drive the grid without clicking it first. Mirrors the
  // global KeyboardShortcuts component's pattern: bail when typing, no-op
  // on modifiers, single document listener cleaned up on unmount.
  // Refs hold the latest closures so the listener doesn't have to re-bind
  // every render. We sync them inside an effect (React 19's "no refs in
  // render" rule) — they only need to be current by the time the next
  // keydown fires.
  const viewRef = useRef(view);
  const editingRef = useRef(editing);
  useEffect(() => {
    viewRef.current = view;
    editingRef.current = editing;
  });
  useEffect(() => {
    function isTyping(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (t.isContentEditable) return true;
      return false;
    }
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) return;
      // The event form modal owns its own Escape/Enter handling — don't
      // let calendar shortcuts steal keys while it's open.
      if (editingRef.current !== null) return;
      // We register with `capture: true` and stopImmediatePropagation on a
      // handled key so the global inbox KeyboardShortcuts listener doesn't
      // also fire `c → compose` / `j/k → move thread selection` for keys
      // the calendar grid wants to own.
      switch (e.key) {
        case "d":
          setView("day");
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        case "w":
          setView("week");
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        case "m":
          setView("month");
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        case "t":
          todayCursor();
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        case "j": {
          // Match the convention of the global j/k (next/prev); on the
          // calendar that maps to the next time-unit for the active view.
          const next = new Date(cursor);
          if (viewRef.current === "day") next.setDate(next.getDate() + 1);
          else if (viewRef.current === "week") next.setDate(next.getDate() + 7);
          else next.setMonth(next.getMonth() + 1);
          setCursor(next);
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        case "k": {
          const next = new Date(cursor);
          if (viewRef.current === "day") next.setDate(next.getDate() - 1);
          else if (viewRef.current === "week") next.setDate(next.getDate() - 7);
          else next.setMonth(next.getMonth() - 1);
          setCursor(next);
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        case "c":
          setEditing({ kind: "new" });
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        default:
          return;
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // `cursor` deliberately re-binds: j/k math reads it. Other state is
    // accessed via refs.
  }, [cursor]);

  // Search (#84): the global SearchBar routes `?q=` here when the user has
  // Calendar selected. We hit `/api/calendar/events?q=…` server-side so the
  // search covers the user's full history rather than just the rendered
  // window. Result rows render in a side panel; clicking a row jumps the
  // grid to that event's day.
  const searchQuery = (searchParams.get("q") ?? "").trim();
  const [searchResults, setSearchResults] = useState<CalendarEvent[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  useEffect(() => {
    if (!searchQuery) {
      // Empty-query branch: clear results synchronously so the panel
      // disappears immediately when the user clears the search.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    (async () => {
      try {
        const url = new URL("/api/calendar/events", window.location.origin);
        url.searchParams.set("q", searchQuery);
        if (scope !== SCOPE_ALL) url.searchParams.set("mailbox", scope);
        const res = await fetch(url.pathname + url.search);
        const body = (await res.json().catch(() => ({}))) as {
          events?: CalendarEvent[];
        };
        if (cancelled) return;
        setSearchResults(body.events ?? []);
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchQuery, scope]);
  // The main grid still gets the windowed event list as before — the
  // search panel is additive, not a filter on the rendered grid.
  const filteredEvents = events;

  return (
    <div className="flex h-full min-h-0">
      <CalendarSidebar
        calendars={calendars}
        scope={scope}
        onScopeChange={setScope}
        onUpdate={updateCalendar}
      />
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
      <header className="border-b border-neutral-200 dark:border-neutral-800 px-4 py-3 flex flex-wrap items-center gap-3 print:hidden">
        <h1 className="text-base font-semibold mr-2">Calendar</h1>

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

        <div className="relative">
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={showDatePicker}
            onClick={() => setShowDatePicker(s => !s)}
            className="text-sm font-medium ml-1 px-2 h-8 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-900 inline-flex items-center gap-1"
            title="Go to date"
          >
            {formatHeader(view, cursor, weekStartDay)}
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
          </button>
          {showDatePicker && (
            <MiniDatePicker
              cursor={cursor}
              weekStartDay={weekStartDay}
              onPick={d => {
                setCursor(d);
                setShowDatePicker(false);
              }}
              onClose={() => setShowDatePicker(false)}
            />
          )}
        </div>

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
          {view === "week" && (
            <button
              type="button"
              onClick={() => window.print()}
              title="Print this week"
              aria-label="Print"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-900 text-xs"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M4 1.5h8a.5.5 0 0 1 .5.5v3h-9V2a.5.5 0 0 1 .5-.5Zm-1 4v-3A1.5 1.5 0 0 1 4.5 1h7A1.5 1.5 0 0 1 13 2.5v3h.5A1.5 1.5 0 0 1 15 7v5a1.5 1.5 0 0 1-1.5 1.5H13v1A1.5 1.5 0 0 1 11.5 16h-7A1.5 1.5 0 0 1 3 14.5v-1h-.5A1.5 1.5 0 0 1 1 12V7a1.5 1.5 0 0 1 1.5-1.5H3Zm1 5v4a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5v-4h-8Z" />
              </svg>
            </button>
          )}
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

      <div className="flex-1 overflow-auto min-h-0 flex">
        <div className="flex-1 min-w-0 overflow-auto">
        {loading && events.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            Loading…
          </div>
        ) : view === "day" ? (
          <CalendarDayGrid
            cursor={cursor}
            events={filteredEvents}
            colorFor={colorFor}
            onEditEvent={ev => setEditing(ev)}
            onCreateAt={draft => setEditing(draft)}
            onPatched={refresh}
          />
        ) : view === "week" ? (
          <CalendarWeekGrid
            cursor={cursor}
            events={filteredEvents}
            colorFor={colorFor}
            weekStartDay={weekStartDay}
            onEditEvent={ev => setEditing(ev)}
            onCreateAt={draft => setEditing(draft)}
            onPatched={refresh}
          />
        ) : (
          <CalendarMonthGrid
            cursor={cursor}
            events={filteredEvents}
            colorFor={colorFor}
            weekStartDay={weekStartDay}
            onEditEvent={ev => setEditing(ev)}
            onSelectDate={d => {
              setCursor(d);
              setView("day");
            }}
            onCreateAt={draft => setEditing(draft)}
          />
        )}
        </div>
        {searchQuery && (
          <SearchResultsPane
            query={searchQuery}
            results={searchResults}
            loading={searchLoading}
            onPick={ev => {
              const d = new Date(ev.starts_at * 1000);
              d.setHours(0, 0, 0, 0);
              setCursor(d);
              setView("day");
            }}
          />
        )}
      </div>

      {editing !== null && (
        <CalendarEventForm
          event={isNewDraft(editing) ? null : editing}
          calendars={calendars}
          // Default the dropdown to whichever calendar is scoped in the
          // sidebar — if the user is looking at "Marketing", a "+ New event"
          // click should land there, not in Personal. Consolidated view
          // (SCOPE_ALL) falls back to Personal.
          defaultCalendarId={scope === SCOPE_ALL ? "personal" : scope}
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
    </div>
  );
}

// Left-rail sidebar: one row per calendar with a color swatch + visibility
// checkbox. Clicking a row name scopes the grid to that calendar; clicking
// "All calendars" returns to the consolidated view. Colors are clickable
// → opens an inline picker with a fixed Tailwind palette so the user
// doesn't have to type hex codes (the API still accepts free-form hex on
// the wire, but UX defaults stay constrained).
const COLOR_PALETTE: string[] = [
  "#3b82f6", // blue
  "#22c55e", // green
  "#f97316", // orange
  "#ef4444", // red
  "#a855f7", // purple
  "#ec4899", // pink
  "#14b8a6", // teal
  "#eab308", // yellow
  "#64748b", // slate
];

function CalendarSidebar({
  calendars,
  scope,
  onScopeChange,
  onUpdate,
}: {
  calendars: CalendarSummary[];
  scope: ScopeSelection;
  onScopeChange: (s: ScopeSelection) => void;
  onUpdate: (id: string, patch: { color?: string; hidden?: boolean }) => void;
}) {
  const [openSwatchId, setOpenSwatchId] = useState<string | null>(null);
  return (
    <aside className="hidden md:flex w-56 shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-800 bg-neutral-50/40 dark:bg-neutral-950/40 overflow-y-auto">
      <div className="px-3 py-2 text-[11px] uppercase tracking-wider font-medium text-neutral-500">
        Calendars
      </div>
      <button
        type="button"
        onClick={() => onScopeChange(SCOPE_ALL)}
        className={`text-left px-3 py-1.5 text-xs ${
          scope === SCOPE_ALL
            ? "bg-[var(--color-brand)]/10 text-[var(--color-brand)] font-medium"
            : "hover:bg-neutral-100 dark:hover:bg-neutral-900 text-neutral-700 dark:text-neutral-300"
        }`}
      >
        All calendars
      </button>
      <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-neutral-400">
        Filter
      </div>
      <ul className="flex-1 px-1 pb-2 space-y-0.5">
        {calendars.map(c => {
          const active = scope === c.id;
          return (
            <li key={c.id} className="relative">
              <div
                className={`group flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${
                  active
                    ? "bg-[var(--color-brand)]/10"
                    : "hover:bg-neutral-100 dark:hover:bg-neutral-900"
                }`}
              >
                <input
                  type="checkbox"
                  checked={!c.hidden}
                  onChange={e => onUpdate(c.id, { hidden: !e.target.checked })}
                  aria-label={`Show ${c.name}`}
                  className="h-3 w-3 cursor-pointer"
                />
                <button
                  type="button"
                  onClick={() => setOpenSwatchId(openSwatchId === c.id ? null : c.id)}
                  aria-label={`Recolor ${c.name}`}
                  className="h-3 w-3 rounded-full ring-1 ring-black/10 dark:ring-white/10 cursor-pointer shrink-0"
                  style={{ backgroundColor: c.color }}
                />
                <button
                  type="button"
                  onClick={() => onScopeChange(c.id)}
                  className={`flex-1 truncate text-left ${
                    active
                      ? "text-[var(--color-brand)] font-medium"
                      : "text-neutral-700 dark:text-neutral-300"
                  } ${c.hidden ? "opacity-50" : ""}`}
                  title={c.name}
                >
                  {c.name}
                </button>
              </div>
              {openSwatchId === c.id && (
                <div
                  className="absolute z-10 left-2 top-full mt-1 flex flex-wrap gap-1 p-2 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-md"
                  role="dialog"
                  aria-label={`Pick color for ${c.name}`}
                >
                  {COLOR_PALETTE.map(hex => (
                    <button
                      key={hex}
                      type="button"
                      aria-label={`Set color ${hex}`}
                      onClick={() => {
                        onUpdate(c.id, { color: hex });
                        setOpenSwatchId(null);
                      }}
                      className={`h-4 w-4 rounded-full ring-1 ring-black/10 dark:ring-white/10 ${
                        c.color.toLowerCase() === hex
                          ? "outline outline-2 outline-offset-1 outline-[var(--color-brand)]"
                          : ""
                      }`}
                      style={{ backgroundColor: hex }}
                    />
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function isNewDraft(x: CalendarEvent | NewEventDraft): x is NewEventDraft {
  return (x as NewEventDraft).kind === "new";
}

// Compact mini month picker (#84). Drops below the header date button so
// the user can jump anywhere without opening Month view. Uses the same
// week-start preference as the main grid so weekday columns line up.
function MiniDatePicker({
  cursor,
  weekStartDay,
  onPick,
  onClose,
}: {
  cursor: Date;
  weekStartDay: number;
  onPick: (d: Date) => void;
  onClose: () => void;
}) {
  // Local month-of-view — separate from the parent cursor so the user can
  // page through months in the picker without committing to a new date
  // until they click a day cell.
  const [viewing, setViewing] = useState<Date>(() => {
    const x = new Date(cursor);
    x.setHours(0, 0, 0, 0);
    x.setDate(1);
    return x;
  });
  const ref = useRef<HTMLDivElement | null>(null);
  // Outside-click + Escape dismissal.
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

  const start = startOfWeekFor(new Date(viewing.getFullYear(), viewing.getMonth(), 1), weekStartDay);
  const cells: Date[] = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
  const weekdayLabels = weekStartDay === 1
    ? ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]
    : ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const today = new Date();

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Go to date"
      className="absolute z-20 top-full left-0 mt-1 w-64 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg p-2"
    >
      <div className="flex items-center justify-between px-1">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() =>
            setViewing(v => new Date(v.getFullYear(), v.getMonth() - 1, 1))
          }
          className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-neutral-100 dark:hover:bg-neutral-900"
        >
          <ChevronIcon dir="left" />
        </button>
        <div className="text-xs font-medium">
          {viewing.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </div>
        <button
          type="button"
          aria-label="Next month"
          onClick={() =>
            setViewing(v => new Date(v.getFullYear(), v.getMonth() + 1, 1))
          }
          className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-neutral-100 dark:hover:bg-neutral-900"
        >
          <ChevronIcon dir="right" />
        </button>
      </div>
      <div className="grid grid-cols-7 mt-2 text-[10px] uppercase tracking-wider text-neutral-500">
        {weekdayLabels.map(l => (
          <div key={l} className="text-center py-0.5">
            {l}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5">
        {cells.map(d => {
          const inMonth = d.getMonth() === viewing.getMonth();
          const isToday =
            d.getFullYear() === today.getFullYear() &&
            d.getMonth() === today.getMonth() &&
            d.getDate() === today.getDate();
          const isCursor =
            d.getFullYear() === cursor.getFullYear() &&
            d.getMonth() === cursor.getMonth() &&
            d.getDate() === cursor.getDate();
          return (
            <button
              key={d.toISOString()}
              type="button"
              onClick={() => {
                const picked = new Date(d);
                picked.setHours(0, 0, 0, 0);
                onPick(picked);
              }}
              className={`text-xs h-7 rounded tabular-nums ${
                isCursor
                  ? "bg-[var(--color-brand)] text-white"
                  : isToday
                    ? "ring-1 ring-[var(--color-brand)]"
                    : "hover:bg-neutral-100 dark:hover:bg-neutral-900"
              } ${inMonth ? "" : "text-neutral-400"}`}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Right-side search results panel (#84). Renders against the server-side
// search hits so the list isn't bounded by the rendered window. Clicking
// a row jumps the grid to that event's day.
function SearchResultsPane({
  query,
  results,
  loading,
  onPick,
}: {
  query: string;
  results: CalendarEvent[];
  loading: boolean;
  onPick: (ev: CalendarEvent) => void;
}) {
  return (
    <aside
      aria-label="Search results"
      className="hidden lg:flex w-72 shrink-0 flex-col border-l border-neutral-200 dark:border-neutral-800 bg-neutral-50/40 dark:bg-neutral-950/40 overflow-y-auto print:hidden"
    >
      <div className="px-3 py-2 text-[11px] uppercase tracking-wider font-medium text-neutral-500 border-b border-neutral-200 dark:border-neutral-800">
        Search · &ldquo;{query}&rdquo;
      </div>
      {loading ? (
        <div className="p-3 text-xs text-neutral-500">Searching…</div>
      ) : results.length === 0 ? (
        <div className="p-3 text-xs text-neutral-500">No matches.</div>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {results.map(ev => (
            <li key={ev.id}>
              <button
                type="button"
                onClick={() => onPick(ev)}
                className="w-full text-left px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                <div className="text-xs font-medium truncate">
                  {ev.summary || "(no title)"}
                </div>
                <div className="text-[11px] text-neutral-500 tabular-nums">
                  {formatSearchDate(ev)}
                </div>
                {ev.location && (
                  <div className="text-[11px] text-neutral-500 truncate">
                    {ev.location}
                  </div>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function formatSearchDate(ev: CalendarEvent): string {
  const d = new Date(ev.starts_at * 1000);
  if (ev.all_day === 1) {
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
function computeWindow(
  view: CalendarView,
  cursor: Date,
  weekStartDay: number,
): { from: number; to: number } {
  if (view === "day") {
    const from = new Date(cursor);
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return { from: Math.floor(from.getTime() / 1000), to: Math.floor(to.getTime() / 1000) };
  }
  if (view === "week") {
    const from = startOfWeekFor(cursor, weekStartDay);
    const to = new Date(from);
    to.setDate(to.getDate() + 7);
    return { from: Math.floor(from.getTime() / 1000), to: Math.floor(to.getTime() / 1000) };
  }
  // month
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const from = startOfWeekFor(first, weekStartDay);
  const to = new Date(from);
  to.setDate(to.getDate() + 42); // 6-week grid
  return { from: Math.floor(from.getTime() / 1000), to: Math.floor(to.getTime() / 1000) };
}

// Sunday-first start-of-week. Kept for backward compatibility with callers
// that haven't been threaded with the week-start preference yet. New
// callers (grid components, etc.) should prefer `startOfWeekFor` so the
// rendered week respects the user's pref.
export function startOfWeek(d: Date): Date {
  return startOfWeekFor(d, 0);
}

// Week-start aware variant (#87). `weekStartDay` is 0 (Sunday) or 1
// (Monday); we shift back to whichever weekday lands first. Anything
// outside that range falls back to Sunday so callers that pass unvetted
// ints don't spin into nonsense.
export function startOfWeekFor(d: Date, weekStartDay: number): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay(); // 0 = Sunday … 6 = Saturday
  const start = weekStartDay === 1 ? 1 : 0;
  // Days to subtract: (day - start + 7) mod 7. Handles Sun→Mon-start
  // wrapping back six days, etc.
  const back = (day - start + 7) % 7;
  x.setDate(x.getDate() - back);
  return x;
}

function formatHeader(view: CalendarView, cursor: Date, weekStartDay: number): string {
  if (view === "day") {
    return cursor.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }
  if (view === "week") {
    const s = startOfWeekFor(cursor, weekStartDay);
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
