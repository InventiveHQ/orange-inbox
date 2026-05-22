"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import type { KanbanCard, KanbanColumn } from "@/lib/kanban";
import { formatThreadDate, senderLabel } from "@/lib/format";
import Avatar from "./Avatar";
import LabelChip from "./LabelChip";
import { useToast } from "./ToastProvider";

interface Props {
  mailboxId: string;
  columns: KanbanColumn[];
  cards: KanbanCard[];
  currentUserId: string;
}

// Assignment filter for the board. "unassigned" / "mine" cover the two cases
// the feature was asked for; "all" is the default escape hatch.
type Filter = "all" | "unassigned" | "mine";

// Namespaced DnD MIME types — one per draggable kind, so a card drag and a
// column drag never get confused for each other (same trick as Sidebar.tsx).
const CARD_MIME = "application/x-orange-kanban-card";
const COLUMN_MIME = "application/x-orange-kanban-column";

// Interactive Kanban board. Holds columns + cards as local state seeded from
// the server props and mutates optimistically — every action calls its API
// and reverts on failure. No router.refresh(): the board is the inbox index
// page, so navigating into a thread and back already gives a fresh render.
export default function KanbanBoardClient({
  mailboxId,
  columns: initialColumns,
  cards: initialCards,
  currentUserId,
}: Props) {
  const { toast } = useToast();
  const [columns, setColumns] = useState<KanbanColumn[]>(initialColumns);
  const [cards, setCards] = useState<KanbanCard[]>(initialCards);
  const [filter, setFilter] = useState<Filter>("all");

  // Drag state lives in the parent so a card can be dropped on any column and
  // a column header on any other column header.
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [draggingColumnId, setDraggingColumnId] = useState<string | null>(null);
  const [cardOverColumnId, setCardOverColumnId] = useState<string | null>(null);

  const [addingColumn, setAddingColumn] = useState(false);
  const [newColumnName, setNewColumnName] = useState("");

  const firstColumnId = columns[0]?.id ?? "";

  function matchesFilter(card: KanbanCard): boolean {
    if (filter === "unassigned") return card.assignee_id == null;
    if (filter === "mine") return card.assignee_id === currentUserId;
    return true;
  }

  const visibleCards = useMemo(
    () => cards.filter(matchesFilter),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cards, filter, currentUserId],
  );

  const cardsByColumn = useMemo(() => {
    const map = new Map<string, KanbanCard[]>();
    for (const col of columns) map.set(col.id, []);
    for (const card of visibleCards) {
      const colId = map.has(card.column_id) ? card.column_id : firstColumnId;
      const list = map.get(colId);
      if (list) list.push(card);
    }
    return map;
  }, [columns, visibleCards, firstColumnId]);

  // ─── Card move ─────────────────────────────────────────────────────────
  async function moveCard(threadId: string, toColumnId: string) {
    const card = cards.find(c => c.id === threadId);
    if (!card || card.column_id === toColumnId) return;
    const prevColumnId = card.column_id;
    setCards(cs =>
      cs.map(c => (c.id === threadId ? { ...c, column_id: toColumnId } : c)),
    );
    try {
      const res = await fetch(`/api/threads/${threadId}/kanban`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ column_id: toColumnId }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setCards(cs =>
        cs.map(c => (c.id === threadId ? { ...c, column_id: prevColumnId } : c)),
      );
      toast({ message: "Couldn't move that card" });
    }
  }

  // ─── Column add / rename / delete / reorder ────────────────────────────
  async function addColumn() {
    const name = newColumnName.trim();
    if (!name) {
      setAddingColumn(false);
      return;
    }
    try {
      const res = await fetch(`/api/mailboxes/${mailboxId}/kanban/columns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { column: KanbanColumn };
      setColumns(cs => [...cs, data.column]);
      setNewColumnName("");
      setAddingColumn(false);
    } catch {
      toast({ message: "Couldn't add that column" });
    }
  }

  async function renameColumn(columnId: string, name: string) {
    const clean = name.trim();
    const existing = columns.find(c => c.id === columnId);
    if (!clean || !existing || existing.name === clean) return;
    const prev = existing.name;
    setColumns(cs => cs.map(c => (c.id === columnId ? { ...c, name: clean } : c)));
    try {
      const res = await fetch(
        `/api/mailboxes/${mailboxId}/kanban/columns/${columnId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: clean }),
        },
      );
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setColumns(cs => cs.map(c => (c.id === columnId ? { ...c, name: prev } : c)));
      toast({ message: "Couldn't rename that column" });
    }
  }

  async function deleteColumn(columnId: string) {
    if (columns.length <= 1) return;
    const remaining = columns.filter(c => c.id !== columnId);
    const fallbackId = remaining[0]?.id ?? "";
    const prevColumns = columns;
    const prevCards = cards;
    setColumns(remaining);
    // Cards in the deleted column fall back to the first remaining column —
    // mirrors the server's ON DELETE CASCADE on thread_kanban.
    setCards(cs =>
      cs.map(c => (c.column_id === columnId ? { ...c, column_id: fallbackId } : c)),
    );
    try {
      const res = await fetch(
        `/api/mailboxes/${mailboxId}/kanban/columns/${columnId}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setColumns(prevColumns);
      setCards(prevCards);
      toast({ message: "Couldn't delete that column" });
    }
  }

  async function reorderColumn(fromId: string, toId: string) {
    if (fromId === toId) return;
    const order = columns.map(c => c.id);
    const fromIdx = order.indexOf(fromId);
    const toIdx = order.indexOf(toId);
    if (fromIdx < 0 || toIdx < 0) return;
    order.splice(fromIdx, 1);
    order.splice(toIdx, 0, fromId);
    const prevColumns = columns;
    const reordered = order
      .map(id => columns.find(c => c.id === id))
      .filter((c): c is KanbanColumn => !!c);
    setColumns(reordered);
    try {
      const res = await fetch(`/api/mailboxes/${mailboxId}/kanban/columns`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setColumns(prevColumns);
      toast({ message: "Couldn't reorder columns" });
    }
  }

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "unassigned", label: "Unassigned" },
    { id: "mine", label: "Assigned to me" },
  ];

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Filter chips */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-neutral-200 dark:border-neutral-800">
        {filters.map(f => {
          const active = f.id === filter;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              aria-pressed={active}
              className={`shrink-0 rounded-full px-3 py-1 text-xs ${
                active
                  ? "bg-[var(--color-brand)]/15 text-[var(--color-brand)] font-medium"
                  : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              }`}
            >
              {f.label}
            </button>
          );
        })}
        <span className="ml-auto text-xs text-neutral-500 tabular-nums">
          {visibleCards.length} card{visibleCards.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Columns */}
      <div className="flex-1 min-h-0 overflow-x-auto">
        <div className="flex h-full gap-3 p-3">
          {columns.map(col => (
            <ColumnView
              key={col.id}
              column={col}
              cards={cardsByColumn.get(col.id) ?? []}
              currentUserId={currentUserId}
              canDelete={columns.length > 1}
              isDragOver={cardOverColumnId === col.id}
              isColumnDragging={draggingColumnId === col.id}
              onRename={renameColumn}
              onDelete={deleteColumn}
              onCardDragStart={setDraggingCardId}
              onCardDragEnd={() => {
                setDraggingCardId(null);
                setCardOverColumnId(null);
              }}
              draggingCardId={draggingCardId}
              onCardEnterColumn={setCardOverColumnId}
              onCardDrop={moveCard}
              onColumnDragStart={setDraggingColumnId}
              onColumnDragEnd={() => setDraggingColumnId(null)}
              onColumnDrop={reorderColumn}
            />
          ))}

          {/* Add column */}
          <div className="w-72 shrink-0">
            {addingColumn ? (
              <div className="rounded-lg border border-neutral-300 dark:border-neutral-700 p-2">
                <input
                  autoFocus
                  value={newColumnName}
                  onChange={e => setNewColumnName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") void addColumn();
                    if (e.key === "Escape") {
                      setAddingColumn(false);
                      setNewColumnName("");
                    }
                  }}
                  placeholder="Column name"
                  maxLength={60}
                  className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-sm"
                />
                <div className="mt-2 flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void addColumn()}
                    className="rounded-md bg-[var(--color-brand)] px-2.5 py-1 text-xs font-medium text-white hover:brightness-95"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAddingColumn(false);
                      setNewColumnName("");
                    }}
                    className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAddingColumn(true)}
                className="w-full rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                + Add column
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface ColumnViewProps {
  column: KanbanColumn;
  cards: KanbanCard[];
  currentUserId: string;
  canDelete: boolean;
  isDragOver: boolean;
  isColumnDragging: boolean;
  draggingCardId: string | null;
  onRename: (columnId: string, name: string) => void;
  onDelete: (columnId: string) => void;
  onCardDragStart: (cardId: string) => void;
  onCardDragEnd: () => void;
  onCardEnterColumn: (columnId: string | null) => void;
  onCardDrop: (cardId: string, columnId: string) => void;
  onColumnDragStart: (columnId: string) => void;
  onColumnDragEnd: () => void;
  onColumnDrop: (fromColumnId: string, toColumnId: string) => void;
}

function ColumnView({
  column,
  cards,
  currentUserId,
  canDelete,
  isDragOver,
  isColumnDragging,
  draggingCardId,
  onRename,
  onDelete,
  onCardDragStart,
  onCardDragEnd,
  onCardEnterColumn,
  onCardDrop,
  onColumnDragStart,
  onColumnDragEnd,
  onColumnDrop,
}: ColumnViewProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(column.name);

  function commitRename() {
    setEditing(false);
    onRename(column.id, editName);
  }

  return (
    <section
      aria-label={column.name}
      className={`flex h-full w-72 shrink-0 flex-col rounded-lg border bg-neutral-50/60 dark:bg-neutral-900/30 ${
        isColumnDragging
          ? "opacity-40"
          : isDragOver
            ? "border-[var(--color-brand)]"
            : "border-neutral-200 dark:border-neutral-800"
      }`}
    >
      {/* Column header — drag handle for column reorder */}
      <header
        draggable={!editing}
        onDragStart={e => {
          if (editing) return;
          e.dataTransfer.setData(COLUMN_MIME, column.id);
          e.dataTransfer.effectAllowed = "move";
          onColumnDragStart(column.id);
        }}
        onDragEnd={onColumnDragEnd}
        onDragOver={e => {
          if (!e.dataTransfer.types.includes(COLUMN_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={e => {
          if (!e.dataTransfer.types.includes(COLUMN_MIME)) return;
          e.preventDefault();
          const fromId = e.dataTransfer.getData(COLUMN_MIME);
          if (fromId) onColumnDrop(fromId, column.id);
        }}
        className={`flex items-center gap-2 px-3 py-2 ${
          editing ? "" : "cursor-grab active:cursor-grabbing"
        }`}
      >
        {editing ? (
          <input
            autoFocus
            value={editName}
            onChange={e => setEditName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setEditName(column.name);
                setEditing(false);
              }
            }}
            maxLength={60}
            className="min-w-0 flex-1 rounded border border-neutral-300 dark:border-neutral-700 bg-transparent px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wider"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wider text-neutral-700 dark:text-neutral-300">
            {column.name}
          </span>
        )}
        <span className="shrink-0 text-[11px] text-neutral-500 tabular-nums">
          {cards.length}
        </span>
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen(o => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`${column.name} options`}
            className="rounded px-1 text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-800"
          >
            ⋯
          </button>
          {menuOpen && (
            <>
              {/* Click-away backdrop */}
              <div
                className="fixed inset-0 z-10"
                aria-hidden
                onClick={() => setMenuOpen(false)}
              />
              <div
                role="menu"
                className="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setEditName(column.name);
                    setEditing(true);
                  }}
                  className="block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canDelete}
                  onClick={() => {
                    setMenuOpen(false);
                    if (
                      confirm(
                        `Delete "${column.name}"? Cards in it move to the first column.`,
                      )
                    ) {
                      onDelete(column.id);
                    }
                  }}
                  className="block w-full px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent"
                  title={canDelete ? undefined : "A board needs at least one column"}
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      {/* Card list — drop target for card drags */}
      <div
        onDragOver={e => {
          if (!e.dataTransfer.types.includes(CARD_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          onCardEnterColumn(column.id);
        }}
        onDragLeave={e => {
          // Only clear when the pointer actually left the column box, not when
          // it crossed onto a child card.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            onCardEnterColumn(null);
          }
        }}
        onDrop={e => {
          if (!e.dataTransfer.types.includes(CARD_MIME)) return;
          e.preventDefault();
          const cardId = e.dataTransfer.getData(CARD_MIME);
          onCardEnterColumn(null);
          if (cardId) onCardDrop(cardId, column.id);
        }}
        className="flex-1 min-h-0 space-y-2 overflow-y-auto p-2"
      >
        {cards.length === 0 ? (
          <div className="rounded-md border border-dashed border-neutral-200 dark:border-neutral-800 px-3 py-6 text-center text-xs text-neutral-400">
            No cards
          </div>
        ) : (
          cards.map(card => (
            <CardView
              key={card.id}
              card={card}
              currentUserId={currentUserId}
              isDragging={draggingCardId === card.id}
              onDragStart={() => onCardDragStart(card.id)}
              onDragEnd={onCardDragEnd}
            />
          ))
        )}
      </div>
    </section>
  );
}

interface CardViewProps {
  card: KanbanCard;
  currentUserId: string;
  isDragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}

function CardView({
  card,
  currentUserId,
  isDragging,
  onDragStart,
  onDragEnd,
}: CardViewProps) {
  // Distinguish a click (open the thread) from a drag: a pointermove past a
  // small threshold while pressed marks the gesture as a drag and suppresses
  // the navigation click.
  const draggedRef = useRef(false);

  const sender = senderLabel(card.last_from_addr, card.last_from_name);
  const subject = card.last_subject || "(no subject)";
  const isUnread = card.unread_count > 0;
  const assigneeName = card.assignee_id
    ? card.assignee_id === currentUserId
      ? "You"
      : card.assignee_display_name?.trim() || card.assignee_email || "Assigned"
    : null;

  return (
    <Link
      href={`/inbox/${encodeURIComponent(card.mailbox_id)}/${card.id}?view=board`}
      draggable
      onDragStart={e => {
        draggedRef.current = true;
        e.dataTransfer.setData(CARD_MIME, card.id);
        e.dataTransfer.setData("text/plain", card.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={() => {
        onDragEnd();
        // Reset shortly after so the click that may follow the drag is still
        // suppressed, but a genuine later click navigates.
        setTimeout(() => {
          draggedRef.current = false;
        }, 0);
      }}
      onClick={e => {
        if (draggedRef.current) e.preventDefault();
      }}
      className={`block rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-2.5 shadow-sm hover:border-neutral-300 dark:hover:border-neutral-700 ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <div className="flex items-start gap-2">
        <Avatar seed={card.last_from_addr || sender} label={sender} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span
              className={`min-w-0 flex-1 truncate text-xs ${
                isUnread
                  ? "font-semibold text-neutral-900 dark:text-neutral-100"
                  : "text-neutral-700 dark:text-neutral-300"
              }`}
            >
              {sender}
            </span>
            {card.starred === 1 && (
              <span className="shrink-0 text-[10px] text-yellow-500" aria-label="Starred">
                ★
              </span>
            )}
            <span className="shrink-0 text-[10px] text-neutral-500">
              {formatThreadDate(card.last_message_at)}
            </span>
          </div>
          <div
            className={`truncate text-xs ${
              isUnread
                ? "font-medium text-neutral-800 dark:text-neutral-200"
                : "text-neutral-600 dark:text-neutral-400"
            }`}
          >
            {subject}
            {card.message_count > 1 && (
              <span className="ml-1 text-[10px] text-neutral-500">
                ({card.message_count})
              </span>
            )}
          </div>
          {card.last_snippet && (
            <div className="truncate text-[11px] text-neutral-500">
              {card.last_snippet}
            </div>
          )}
        </div>
      </div>
      {(card.labels.length > 0 || assigneeName) && (
        <div className="mt-2 flex items-center gap-1.5">
          {card.labels.map(l => (
            <LabelChip key={l.id} name={l.name} color={l.color} />
          ))}
          {assigneeName && (
            <span
              className="ml-auto inline-flex items-center gap-1 rounded-full bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:text-neutral-300"
              title={`Assigned to ${assigneeName}`}
            >
              <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 5.5C3 11.6 5.2 10 8 10s5 1.6 5 3.5V14H3v-.5Z" />
              </svg>
              <span className="truncate max-w-[12ch]">{assigneeName}</span>
            </span>
          )}
        </div>
      )}
    </Link>
  );
}
