"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { InboxLayoutPane, InboxLayoutRow } from "@/lib/inbox-layouts";
import type { SavedSearchRow } from "@/lib/saved-searches";

interface Props {
  initialLayouts: InboxLayoutRow[];
  savedSearches: SavedSearchRow[];
}

// Settings panel for inbox layouts — list, create, edit, delete, drag-to-
// reorder panes. Native HTML5 drag-and-drop only (per the brief: no new deps).
//
// State strategy: keep the server's snapshot in `layouts`, but when an edit
// session is active we hold a working draft in `draft`. Saving PATCHes the
// row, refreshes the route (so other consumers like the sidebar pick up the
// rename / new default flag), and merges the response back into `layouts`.
export default function InboxLayoutEditor({ initialLayouts, savedSearches }: Props) {
  const router = useRouter();
  const [layouts, setLayouts] = useState<InboxLayoutRow[]>(initialLayouts);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refreshLocal(next: InboxLayoutRow[]) {
    // Re-sort to match the server: default first, then by name.
    next.sort((a, b) => {
      if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    setLayouts(next);
  }

  function onSaved(saved: InboxLayoutRow) {
    const idx = layouts.findIndex(l => l.id === saved.id);
    let next = [...layouts];
    if (idx >= 0) next[idx] = saved;
    else next.push(saved);
    // If saved is now default, clear is_default on every other row — the API
    // already enforces this in the DB, but the client cache needs to mirror it.
    if (saved.is_default) {
      next = next.map(l => (l.id === saved.id ? l : { ...l, is_default: false }));
    }
    refreshLocal(next);
    setEditingId(null);
    setCreating(false);
    setError(null);
    // Sidebar / scope routes consume layouts list — bump them.
    router.refresh();
  }

  function onDeleted(id: string) {
    refreshLocal(layouts.filter(l => l.id !== id));
    setEditingId(null);
    router.refresh();
  }

  const editing = useMemo(
    () => (editingId ? layouts.find(l => l.id === editingId) ?? null : null),
    [editingId, layouts],
  );

  return (
    <section id="inbox-layouts" className="scroll-mt-4">
      <header className="mb-4">
        <h2 className="text-base font-semibold">Inbox layouts</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Show several thread lists side-by-side. Each pane is driven by a saved
          search or a raw search query. Pick one to be the default and it shows
          up first in the sidebar.
        </p>
      </header>

      {error && (
        <div className="mb-3 rounded-md border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {!creating && !editing && (
        <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
          {layouts.length === 0 ? (
            <div className="px-4 py-8 text-sm text-neutral-500 text-center">
              No layouts yet.
            </div>
          ) : (
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {layouts.map(l => (
                <LayoutRow
                  key={l.id}
                  layout={l}
                  onEdit={() => setEditingId(l.id)}
                  onSetDefault={async () => {
                    setError(null);
                    try {
                      const res = await fetch(`/api/inbox-layouts/${l.id}`, {
                        method: "PATCH",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ is_default: true }),
                      });
                      const body = (await res.json().catch(() => ({}))) as {
                        layout?: InboxLayoutRow;
                        error?: string;
                      };
                      if (!res.ok || !body.layout) {
                        setError(body.error ?? `Failed (${res.status})`);
                        return;
                      }
                      onSaved(body.layout);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "Failed");
                    }
                  }}
                  onDelete={async () => {
                    if (!confirm(`Delete layout "${l.name}"?`)) return;
                    setError(null);
                    const res = await fetch(`/api/inbox-layouts/${l.id}`, {
                      method: "DELETE",
                    });
                    if (!res.ok) {
                      const body = (await res.json().catch(() => ({}))) as {
                        error?: string;
                      };
                      setError(body.error ?? `Failed (${res.status})`);
                      return;
                    }
                    onDeleted(l.id);
                  }}
                />
              ))}
            </ul>
          )}
          <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-950/40 px-4 py-3 flex items-center justify-end">
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-white"
            >
              New layout
            </button>
          </div>
        </div>
      )}

      {(creating || editing) && (
        <LayoutForm
          initial={editing ?? undefined}
          savedSearches={savedSearches}
          onCancel={() => {
            setCreating(false);
            setEditingId(null);
            setError(null);
          }}
          onSaved={onSaved}
          setError={setError}
        />
      )}
    </section>
  );
}

function LayoutRow({
  layout,
  onEdit,
  onSetDefault,
  onDelete,
}: {
  layout: InboxLayoutRow;
  onEdit: () => void;
  onSetDefault: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm truncate">{layout.name}</span>
          {layout.is_default && (
            <span className="rounded-full bg-[var(--color-brand)]/15 text-[var(--color-brand)] text-[10px] font-medium uppercase tracking-wider px-2 py-0.5">
              default
            </span>
          )}
        </div>
        <div className="mt-0.5 text-xs text-neutral-500 truncate">
          {layout.panes.length} pane{layout.panes.length === 1 ? "" : "s"}:{" "}
          {layout.panes.map(p => p.label).join(", ")}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {!layout.is_default && (
          <button
            type="button"
            onClick={() => void onSetDefault()}
            className="text-xs text-neutral-600 dark:text-neutral-400 hover:underline"
          >
            Set default
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          className="text-xs text-neutral-600 dark:text-neutral-400 hover:underline"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => void onDelete()}
          className="text-xs text-red-600 hover:underline"
        >
          Delete
        </button>
      </div>
    </li>
  );
}

interface FormDraft {
  name: string;
  is_default: boolean;
  panes: InboxLayoutPane[];
}

function paneFromSaved(s: SavedSearchRow): InboxLayoutPane {
  return { saved_search_id: s.id, label: s.name };
}

function LayoutForm({
  initial,
  savedSearches,
  onCancel,
  onSaved,
  setError,
}: {
  initial?: InboxLayoutRow;
  savedSearches: SavedSearchRow[];
  onCancel: () => void;
  onSaved: (saved: InboxLayoutRow) => void;
  setError: (msg: string | null) => void;
}) {
  const [draft, setDraft] = useState<FormDraft>(() => ({
    name: initial?.name ?? "",
    is_default: initial?.is_default ?? false,
    panes:
      initial?.panes && initial.panes.length > 0
        ? initial.panes.map(p => ({ ...p }))
        : [{ label: "Inbox", query: "" }],
  }));
  const [isPending, startTransition] = useTransition();

  // Drag state for native HTML5 reorder. dragIndex tracks which pane the user
  // started on; dropIndex shows where the released drop would land. We don't
  // mutate the array until drop, so cancelled drags leave order intact. Both
  // values are clamped at use time against draft.panes.length so an Add Pane
  // mid-flight (which shouldn't normally collide with a drag) never points
  // into nowhere — no reset effect needed.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const safeDragIndex =
    dragIndex !== null && dragIndex < draft.panes.length ? dragIndex : null;
  const safeDropIndex =
    dropIndex !== null && dropIndex < draft.panes.length ? dropIndex : null;

  function updatePane(idx: number, patch: Partial<InboxLayoutPane>) {
    setDraft(d => {
      const next = d.panes.map((p, i) => (i === idx ? { ...p, ...patch } : p));
      return { ...d, panes: next };
    });
  }

  function removePane(idx: number) {
    setDraft(d => ({ ...d, panes: d.panes.filter((_, i) => i !== idx) }));
  }

  function addPane(template?: InboxLayoutPane) {
    setDraft(d => ({
      ...d,
      panes: [...d.panes, template ?? { label: `Pane ${d.panes.length + 1}`, query: "" }],
    }));
  }

  function reorder(from: number, to: number) {
    setDraft(d => {
      if (from === to) return d;
      const copy = [...d.panes];
      const [moved] = copy.splice(from, 1);
      // Adjust insertion target when removing earlier shifts later indices left.
      const insertAt = from < to ? to - 1 : to;
      copy.splice(insertAt, 0, moved);
      return { ...d, panes: copy };
    });
  }

  function save() {
    setError(null);
    const cleanName = draft.name.trim();
    if (!cleanName) {
      setError("Name required");
      return;
    }
    if (draft.panes.length === 0) {
      setError("Add at least one pane");
      return;
    }
    // Strip empty fields the API would reject. saved_search_id wins; query
    // only goes through when no saved-search reference is set.
    const cleanPanes: InboxLayoutPane[] = [];
    for (const p of draft.panes) {
      const label = p.label.trim();
      const savedId = p.saved_search_id?.trim() ?? "";
      const q = p.query?.trim() ?? "";
      if (!label) {
        setError("Every pane needs a label");
        return;
      }
      if (!savedId && !q) {
        setError(`Pane "${label}" needs a saved search or a query`);
        return;
      }
      const out: InboxLayoutPane = { label };
      if (savedId) out.saved_search_id = savedId;
      else if (q) out.query = q;
      cleanPanes.push(out);
    }

    startTransition(async () => {
      const body = JSON.stringify({
        name: cleanName,
        panes: cleanPanes,
        is_default: draft.is_default,
      });
      const url = initial ? `/api/inbox-layouts/${initial.id}` : `/api/inbox-layouts`;
      const method = initial ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body,
      });
      const responseBody = (await res.json().catch(() => ({}))) as {
        layout?: InboxLayoutRow;
        error?: string;
      };
      if (!res.ok || !responseBody.layout) {
        setError(responseBody.error ?? `Failed (${res.status})`);
        return;
      }
      onSaved(responseBody.layout);
    });
  }

  return (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-4 py-4 space-y-4">
      <div>
        <label className="block text-xs font-medium uppercase tracking-wider text-neutral-500 mb-1">
          Name
        </label>
        <input
          type="text"
          value={draft.name}
          onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
          placeholder="e.g. Triage"
          className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)]"
        />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.is_default}
          onChange={e => setDraft(d => ({ ...d, is_default: e.target.checked }))}
        />
        <span>Open this layout by default</span>
      </label>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Panes
          </span>
          <span className="text-[11px] text-neutral-500">
            Drag the handle to reorder
          </span>
        </div>
        <ul className="space-y-2">
          {draft.panes.map((pane, idx) => (
            <li
              key={idx}
              draggable
              onDragStart={e => {
                setDragIndex(idx);
                e.dataTransfer.effectAllowed = "move";
                // Required by Firefox to actually start a drag.
                e.dataTransfer.setData("text/plain", String(idx));
              }}
              onDragOver={e => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (safeDropIndex !== idx) setDropIndex(idx);
              }}
              onDragLeave={() => {
                if (safeDropIndex === idx) setDropIndex(null);
              }}
              onDrop={e => {
                e.preventDefault();
                if (safeDragIndex !== null && safeDragIndex !== idx) {
                  reorder(safeDragIndex, idx);
                }
                setDragIndex(null);
                setDropIndex(null);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setDropIndex(null);
              }}
              className={`rounded-md border px-3 py-2 ${
                safeDragIndex === idx
                  ? "opacity-50 border-neutral-300 dark:border-neutral-700"
                  : safeDropIndex === idx
                    ? "border-[var(--color-brand)] bg-[var(--color-brand)]/5"
                    : "border-neutral-200 dark:border-neutral-800"
              }`}
            >
              <PaneEditor
                pane={pane}
                savedSearches={savedSearches}
                onChange={patch => updatePane(idx, patch)}
                onRemove={() => removePane(idx)}
                canRemove={draft.panes.length > 1}
              />
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => addPane()}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2.5 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900"
          >
            Add pane
          </button>
          {savedSearches.length > 0 && (
            <SavedSearchAddMenu
              savedSearches={savedSearches}
              onPick={s => addPane(paneFromSaved(s))}
            />
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-neutral-200 dark:border-neutral-800">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-sm text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={isPending}
          className="rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {isPending ? "Saving…" : initial ? "Save changes" : "Create layout"}
        </button>
      </div>
    </div>
  );
}

function PaneEditor({
  pane,
  savedSearches,
  onChange,
  onRemove,
  canRemove,
}: {
  pane: InboxLayoutPane;
  savedSearches: SavedSearchRow[];
  onChange: (patch: Partial<InboxLayoutPane>) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  // A pane is either "use this saved search" (saved_search_id set) or "use
  // this raw query" (query set). The select's "" value clears the saved-search
  // binding and switches to the inline-query path.
  const usingSaved = Boolean(pane.saved_search_id);

  return (
    <div className="flex items-start gap-2">
      <span
        aria-hidden
        className="mt-1.5 cursor-grab select-none text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
        title="Drag to reorder"
      >
        ::
      </span>
      <div className="flex-1 min-w-0 space-y-2">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input
            type="text"
            value={pane.label}
            onChange={e => onChange({ label: e.target.value })}
            placeholder="Pane label"
            className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2.5 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)]"
          />
          <select
            value={pane.saved_search_id ?? ""}
            onChange={e => {
              const id = e.target.value || undefined;
              onChange({
                saved_search_id: id,
                // When linking to a saved search, drop the inline query so the
                // saved row is the single source of truth — switching back to
                // "raw query" gives the user a blank slate.
                query: id ? undefined : pane.query ?? "",
              });
            }}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2.5 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)]"
          >
            <option value="">Raw query…</option>
            {savedSearches.map(s => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        {!usingSaved && (
          <input
            type="text"
            value={pane.query ?? ""}
            onChange={e => onChange({ query: e.target.value })}
            placeholder="e.g. is:unread from:alice"
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2.5 py-1.5 text-sm font-mono focus:outline-none focus:border-[var(--color-brand)]"
          />
        )}
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={!canRemove}
        title="Remove pane"
        className="text-xs text-red-600 hover:underline disabled:opacity-30 disabled:no-underline"
      >
        Remove
      </button>
    </div>
  );
}

function SavedSearchAddMenu({
  savedSearches,
  onPick,
}: {
  savedSearches: SavedSearchRow[];
  onPick: (s: SavedSearchRow) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2.5 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900"
      >
        Add from saved searches
      </button>
      {open && (
        <div className="absolute z-10 left-0 top-full mt-1 w-64 max-h-56 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg">
          <ul className="py-1">
            {savedSearches.map(s => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(s);
                    setOpen(false);
                  }}
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900"
                >
                  <div className="truncate">{s.name}</div>
                  <div className="truncate text-xs text-neutral-500 font-mono">
                    {s.query}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
