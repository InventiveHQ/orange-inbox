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

  // Compute the fetch window for the current view. Week starts on Sunday —
  // mirrors the default for US users; international users will see a
  // Sunday-first week too in v1.
  const fetchWindow = useMemo(() => computeWindow(view, cursor), [view, cursor]);

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
    fetchEvents();
  }, [fetchEvents]);

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
    <div className="flex h-full min-h-0">
      <CalendarSidebar
        calendars={calendars}
        scope={scope}
        onScopeChange={setScope}
        onUpdate={updateCalendar}
      />
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
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
            colorFor={colorFor}
            onEditEvent={ev => setEditing(ev)}
            onCreateAt={draft => setEditing(draft)}
          />
        ) : view === "week" ? (
          <CalendarWeekGrid
            cursor={cursor}
            events={filteredEvents}
            colorFor={colorFor}
            onEditEvent={ev => setEditing(ev)}
            onCreateAt={draft => setEditing(draft)}
          />
        ) : (
          <CalendarMonthGrid
            cursor={cursor}
            events={filteredEvents}
            colorFor={colorFor}
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
