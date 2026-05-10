"use client";

import { useEffect, useMemo, useState } from "react";
import type { CalendarSummary } from "./CalendarManager";

// Sidebar for /inbox/calendar (#78 / #97). Extracted from CalendarManager
// so the calendar UI files stay focused on grids + the event form. This
// file owns:
//
//   1. The 9-swatch palette + free-form hex picker (#97).
//   2. The mobile drawer behaviour — `hidden md:flex` for the rail at md+,
//      a hamburger button + slide-in <aside> below md (#97).
//   3. Drag-to-reorder via native HTML5 DnD, mirroring the mailbox sidebar
//      pattern from #52 (Sidebar.tsx). The drag-end POSTs the new order
//      to /api/calendar/calendars/reorder; optimistic UI before the
//      response.

// "all" = consolidated view (no mailbox filter). Distinct from the literal
// "personal" calendar id, which is a real selection.
const SCOPE_ALL = "all" as const;
type ScopeSelection = typeof SCOPE_ALL | string;

// 9-swatch palette (#78) — kept here rather than in a shared constant
// because it's only consumed by this component. The Custom… pill below
// the grid lets users pick anything outside this list (#97).
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

// Namespaced DnD MIME type so dragover / drop in this list can ignore
// drags that originated elsewhere (e.g. the Sidebar mailbox drag from
// #52, which uses its own MIME).
const DRAG_MIME_CALENDAR = "application/x-orange-calendar-id";

interface Props {
  calendars: CalendarSummary[];
  scope: ScopeSelection;
  onScopeChange: (s: ScopeSelection) => void;
  // Single-row PATCH for color/hidden flips. Pass-through to the
  // CalendarManager's existing optimistic-update logic.
  onUpdate: (id: string, patch: { color?: string; hidden?: boolean }) => void;
  // Refetch the calendar list after a reorder, since the list prop is
  // owned by CalendarManager and we drove the POST locally.
  onReordered?: () => void;
}

export default function CalendarSidebar(props: Props) {
  // Mobile drawer (#97). Closed on mount; opened by the hamburger button
  // we render at < md only. The same content renders inline at md+.
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Close on Escape — matches the modal/overlay convention used by the
  // event form and mini date picker. Only attached while open.
  useEffect(() => {
    if (!drawerOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setDrawerOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <>
      {/* Mobile hamburger — visible below md, anchored to the top-left
          of the calendar pane. Hidden when the drawer is open since the
          drawer's own header has a close affordance. */}
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        aria-label="Open calendar sidebar"
        aria-expanded={drawerOpen}
        className={`md:hidden fixed top-2 left-2 z-30 inline-flex h-8 w-8 items-center justify-center rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 ${
          drawerOpen ? "invisible" : ""
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <path d="M2 4h12M2 8h12M2 12h12" />
        </svg>
      </button>

      {/* Desktop rail — same as before #97, just lifted into its own
          file. `hidden md:flex` keeps it off mobile (the drawer takes
          over there). */}
      <aside className="hidden md:flex w-56 shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-800 bg-neutral-50/40 dark:bg-neutral-950/40 overflow-y-auto">
        <SidebarBody {...props} />
      </aside>

      {/* Mobile drawer — backdrop + sliding aside. Tailwind's transition
          on translate keeps the slide cheap. We always render the inner
          <aside> so the close transition can play; pointer-events get
          turned off when collapsed so taps fall through to the grid. */}
      <div
        className={`md:hidden fixed inset-0 z-40 ${drawerOpen ? "" : "pointer-events-none"}`}
        aria-hidden={!drawerOpen}
      >
        <div
          onClick={() => setDrawerOpen(false)}
          className={`absolute inset-0 bg-black/40 transition-opacity ${
            drawerOpen ? "opacity-100" : "opacity-0"
          }`}
        />
        <aside
          role="dialog"
          aria-label="Calendars"
          aria-modal="true"
          className={`relative z-10 h-full w-64 flex flex-col border-r border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-xl transition-transform duration-200 ${
            drawerOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-200 dark:border-neutral-800">
            <span className="text-sm font-semibold">Calendars</span>
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close calendar sidebar"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-900"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                <path d="M3 3l10 10M13 3L3 13" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            <SidebarBody
              {...props}
              onScopeChange={s => {
                props.onScopeChange(s);
                setDrawerOpen(false);
              }}
            />
          </div>
        </aside>
      </div>
    </>
  );
}

// Inner body — the calendar list + filter rows. Reused by both the
// desktop rail and the mobile drawer wrapper above.
function SidebarBody({
  calendars,
  scope,
  onScopeChange,
  onUpdate,
  onReordered,
}: Props) {
  const [openSwatchId, setOpenSwatchId] = useState<string | null>(null);
  // Local override of `calendars`'s order so a drag can reflect
  // immediately without waiting for the network round-trip + parent
  // refetch. Set on drop, cleared (via useMemo's set-comparison) the
  // moment the prop's id-set diverges from this override — that
  // happens whenever a calendar is granted / revoked, which is the
  // only time we need to drop optimistic state. We don't clear on
  // simple color/hidden changes because the id set is unchanged
  // there.
  const [orderedIds, setOrderedIds] = useState<string[] | null>(null);

  const ordered = useMemo<CalendarSummary[]>(() => {
    if (!orderedIds) return calendars;
    const byId = new Map(calendars.map(c => [c.id, c] as const));
    // If the override doesn't cover every current calendar (or covers
    // ones that no longer exist), bail — the parent's order wins.
    if (orderedIds.length !== calendars.length) return calendars;
    const out: CalendarSummary[] = [];
    for (const id of orderedIds) {
      const c = byId.get(id);
      if (!c) return calendars;
      out.push(c);
    }
    return out;
  }, [orderedIds, calendars]);

  // Drag state. `draggingId` tracks which row started the drag (so we
  // can ghost it); `overId` is the row currently under the pointer (so
  // we can outline it). Both are reset on dragend / drop.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  function persistOrder(nextIds: string[]) {
    // Bulk POST — one request per drag, mirrors the mailbox-order
    // pattern in /api/me/mailbox-order (#52).
    fetch("/api/calendar/calendars/reorder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        order: nextIds.map((id, idx) => ({ id, sort_order: idx + 1 })),
      }),
    })
      .then(res => {
        if (res.ok && onReordered) onReordered();
      })
      .catch(err => {
        console.error("calendars reorder failed", err);
      });
  }

  function moveCalendar(fromId: string, toId: string) {
    if (fromId === toId) return;
    const ids = ordered.map(c => c.id);
    const fromIdx = ids.indexOf(fromId);
    const toIdx = ids.indexOf(toId);
    if (fromIdx < 0 || toIdx < 0) return;
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, fromId);
    setOrderedIds(ids);
    persistOrder(ids);
  }

  return (
    <>
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
        {ordered.map(c => {
          const active = scope === c.id;
          const isDragging = draggingId === c.id;
          const isOver = overId === c.id && draggingId !== null && draggingId !== c.id;
          return (
            <li
              key={c.id}
              className={`relative ${isDragging ? "opacity-40" : ""} ${
                isOver ? "outline outline-2 -outline-offset-2 outline-[var(--color-brand)] rounded-md" : ""
              }`}
              draggable
              onDragStart={e => {
                e.dataTransfer.setData(DRAG_MIME_CALENDAR, c.id);
                e.dataTransfer.setData("text/plain", c.id);
                e.dataTransfer.effectAllowed = "move";
                setDraggingId(c.id);
              }}
              onDragOver={e => {
                if (!e.dataTransfer.types.includes(DRAG_MIME_CALENDAR)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (overId !== c.id) setOverId(c.id);
              }}
              onDragLeave={() => {
                if (overId === c.id) setOverId(null);
              }}
              onDrop={e => {
                if (!e.dataTransfer.types.includes(DRAG_MIME_CALENDAR)) return;
                e.preventDefault();
                const fromId = e.dataTransfer.getData(DRAG_MIME_CALENDAR);
                setOverId(null);
                if (fromId && fromId !== c.id) moveCalendar(fromId, c.id);
              }}
              onDragEnd={() => {
                setDraggingId(null);
                setOverId(null);
              }}
            >
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
                  {/* Free-form hex picker (#97). Native <input type="color">
                      gives us a system-level hex picker without pulling in
                      a UI lib. The PATCH /api/calendar/calendars endpoint
                      already accepts any 7-char hex; the swatch grid above
                      is just a curated subset. */}
                  <label
                    className="inline-flex items-center justify-center h-4 px-1.5 rounded-full border border-dashed border-neutral-300 dark:border-neutral-700 text-[10px] text-neutral-600 dark:text-neutral-300 cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-900"
                    title="Custom color"
                  >
                    Custom…
                    <input
                      type="color"
                      // Default the picker to the row's current color so
                      // the system dialog opens already on the user's
                      // existing pick — useful when they want to nudge
                      // it (lighten / darken) rather than start fresh.
                      value={normaliseHex(c.color)}
                      onChange={e => onUpdate(c.id, { color: e.target.value })}
                      // The native picker fires "change" on commit; we
                      // close the popover only on the explicit blur so
                      // the user can keep nudging without it dismissing.
                      onBlur={() => setOpenSwatchId(null)}
                      className="sr-only"
                    />
                  </label>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

// <input type="color"> demands a 7-char #rrggbb literal — values like
// "#3B82F6" (uppercase) work, but anything shorter or with an alpha
// channel makes the input default back to #000000. Snap unexpected
// shapes back to a sane default so the picker opens on the right tile.
function normaliseHex(input: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(input)) return input;
  return "#3b82f6";
}
