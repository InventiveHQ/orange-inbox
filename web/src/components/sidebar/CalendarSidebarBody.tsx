"use client";

import { useMemo, useState } from "react";
import {
  SCOPE_ALL,
  useCalendarUI,
  type ScopeSelection,
} from "../CalendarUIContext";
import type { CalendarSummary } from "../CalendarManager";

// Drawer body for /inbox/calendar — the calendar list (with visibility
// checkboxes, color swatches, free-form hex picker, and drag-to-reorder).
// Mounted by the global Sidebar's `sectionBody` slot when scope is
// "calendar". Reads/writes via CalendarUIContext so the page body
// (CalendarManager) shares the same data without duplicate fetches.
//
// History note: this content used to live in CalendarSidebar.tsx, which
// owned its own desktop-rail + mobile-drawer chrome (the calendar route
// rendered it as a sibling of the global Sidebar). Now the global
// Sidebar/MobileShell own that chrome — this file is the inner content
// only.

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

const DRAG_MIME_CALENDAR = "application/x-orange-calendar-id";

export default function CalendarSidebarBody() {
  const { calendars, scope, setScope, updateCalendar, refetch } = useCalendarUI();
  const [openSwatchId, setOpenSwatchId] = useState<string | null>(null);
  const [orderedIds, setOrderedIds] = useState<string[] | null>(null);

  const ordered = useMemo<CalendarSummary[]>(() => {
    if (!orderedIds) return calendars;
    const byId = new Map(calendars.map(c => [c.id, c] as const));
    if (orderedIds.length !== calendars.length) return calendars;
    const out: CalendarSummary[] = [];
    for (const id of orderedIds) {
      const c = byId.get(id);
      if (!c) return calendars;
      out.push(c);
    }
    return out;
  }, [orderedIds, calendars]);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  function persistOrder(nextIds: string[]) {
    fetch("/api/calendar/calendars/reorder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        order: nextIds.map((id, idx) => ({ id, sort_order: idx + 1 })),
      }),
    })
      .then(res => {
        if (res.ok) refetch();
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
    <div className="flex flex-col">
      <div className="px-3 py-2 text-[11px] uppercase tracking-wider font-medium text-neutral-500">
        Calendars
      </div>
      <button
        type="button"
        onClick={() => setScope(SCOPE_ALL)}
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
      <ul className="px-1 pb-2 space-y-0.5">
        {ordered.map(c => (
          <CalendarRow
            key={c.id}
            calendar={c}
            active={scope === c.id}
            isDragging={draggingId === c.id}
            isOver={overId === c.id && draggingId !== null && draggingId !== c.id}
            openSwatch={openSwatchId === c.id}
            onSelect={() => setScope(c.id as ScopeSelection)}
            onToggleSwatch={() => setOpenSwatchId(openSwatchId === c.id ? null : c.id)}
            onCloseSwatch={() => setOpenSwatchId(null)}
            onPatch={patch => updateCalendar(c.id, patch)}
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
          />
        ))}
      </ul>
    </div>
  );
}

interface RowProps {
  calendar: CalendarSummary;
  active: boolean;
  isDragging: boolean;
  isOver: boolean;
  openSwatch: boolean;
  onSelect: () => void;
  onToggleSwatch: () => void;
  onCloseSwatch: () => void;
  onPatch: (patch: { color?: string; hidden?: boolean }) => void;
  onDragStart: (e: React.DragEvent<HTMLLIElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLLIElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLLIElement>) => void;
  onDrop: (e: React.DragEvent<HTMLLIElement>) => void;
  onDragEnd: (e: React.DragEvent<HTMLLIElement>) => void;
}

function CalendarRow({
  calendar: c,
  active,
  isDragging,
  isOver,
  openSwatch,
  onSelect,
  onToggleSwatch,
  onCloseSwatch,
  onPatch,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: RowProps) {
  return (
    <li
      className={`relative ${isDragging ? "opacity-40" : ""} ${
        isOver ? "outline outline-2 -outline-offset-2 outline-[var(--color-brand)] rounded-md" : ""
      }`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
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
          onChange={e => onPatch({ hidden: !e.target.checked })}
          aria-label={`Show ${c.name}`}
          className="h-3 w-3 cursor-pointer"
        />
        <button
          type="button"
          onClick={onToggleSwatch}
          aria-label={`Recolor ${c.name}`}
          className="h-3 w-3 rounded-full ring-1 ring-black/10 dark:ring-white/10 cursor-pointer shrink-0"
          style={{ backgroundColor: c.color }}
        />
        <button
          type="button"
          onClick={onSelect}
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
      {openSwatch && (
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
                onPatch({ color: hex });
                onCloseSwatch();
              }}
              className={`h-4 w-4 rounded-full ring-1 ring-black/10 dark:ring-white/10 ${
                c.color.toLowerCase() === hex
                  ? "outline outline-2 outline-offset-1 outline-[var(--color-brand)]"
                  : ""
              }`}
              style={{ backgroundColor: hex }}
            />
          ))}
          <label
            className="inline-flex items-center justify-center h-4 px-1.5 rounded-full border border-dashed border-neutral-300 dark:border-neutral-700 text-[10px] text-neutral-600 dark:text-neutral-300 cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-900"
            title="Custom color"
          >
            Custom…
            <input
              type="color"
              value={normaliseHex(c.color)}
              onChange={e => onPatch({ color: e.target.value })}
              onBlur={onCloseSwatch}
              className="sr-only"
            />
          </label>
        </div>
      )}
    </li>
  );
}

function normaliseHex(input: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(input)) return input;
  return "#3b82f6";
}
