"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import LabelChip from "./LabelChip";

interface LabelRow {
  id: string;
  name: string;
  color: string | null;
  mailbox_id: string | null;
}

// Eight presets cover the visual range we need for chip-on-list legibility.
// `null` means "no color" — chip falls back to neutral tint.
const PRESET_COLORS: (string | null)[] = [
  null,
  "#ef4444",
  "#f59e0b",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#a855f7",
  "#ec4899",
];

export default function ManageLabelsDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const router = useRouter();
  const [labels, setLabels] = useState<LabelRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Create form state.
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string | null>(null);

  // Inline edit state. Keyed by label id; only one row in edit mode at a
  // time keeps the UI legible.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState<string | null>(null);

  async function refresh() {
    setLoadError(null);
    const res = await fetch("/api/labels");
    if (!res.ok) {
      setLoadError(`Failed to load labels (${res.status})`);
      return;
    }
    const json = (await res.json()) as { labels: LabelRow[] };
    setLabels(json.labels);
  }

  useEffect(() => {
    refresh();
  }, []);

  function create() {
    setActionError(null);
    const name = newName.trim();
    if (!name) {
      setActionError("Enter a name");
      return;
    }
    startTransition(async () => {
      const res = await fetch("/api/labels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color: newColor }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(b.error ?? `Failed (${res.status})`);
        return;
      }
      setNewName("");
      setNewColor(null);
      await refresh();
      router.refresh();
    });
  }

  function startEdit(l: LabelRow) {
    setActionError(null);
    setEditingId(l.id);
    setEditName(l.name);
    setEditColor(l.color);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName("");
    setEditColor(null);
  }

  function saveEdit(id: string) {
    setActionError(null);
    const name = editName.trim();
    if (!name) {
      setActionError("Name required");
      return;
    }
    startTransition(async () => {
      const res = await fetch(`/api/labels/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color: editColor }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(b.error ?? `Failed (${res.status})`);
        return;
      }
      cancelEdit();
      await refresh();
      router.refresh();
    });
  }

  function remove(l: LabelRow) {
    if (!confirm(`Delete label "${l.name}"? It will be removed from all threads.`)) {
      return;
    }
    setActionError(null);
    startTransition(async () => {
      const res = await fetch(`/api/labels/${l.id}`, { method: "DELETE" });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(b.error ?? `Failed (${res.status})`);
        return;
      }
      await refresh();
      router.refresh();
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-md max-h-[85vh] flex flex-col rounded-lg bg-white dark:bg-neutral-950 shadow-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden"
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
          <div>
            <div className="text-sm font-medium">Manage labels</div>
            <div className="text-xs text-neutral-500">
              Tags you can apply to conversations
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="overflow-y-auto divide-y divide-neutral-200 dark:divide-neutral-800">
          {/* Existing labels */}
          <section className="px-4 py-3">
            <div className="text-xs uppercase tracking-wider text-neutral-500 mb-1">
              Your labels
            </div>
            {loadError && <div className="text-sm text-red-600">{loadError}</div>}
            {labels === null && !loadError && (
              <div className="text-sm text-neutral-500">Loading…</div>
            )}
            {labels && labels.length === 0 && (
              <div className="text-sm text-neutral-500">No labels yet.</div>
            )}
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {labels?.map(l =>
                editingId === l.id ? (
                  <li key={l.id} className="py-2 space-y-2">
                    <input
                      type="text"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") saveEdit(l.id);
                        if (e.key === "Escape") cancelEdit();
                      }}
                      className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)]"
                    />
                    <ColorPicker value={editColor} onChange={setEditColor} />
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="rounded-md px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => saveEdit(l.id)}
                        disabled={isPending}
                        className="rounded-md bg-[var(--color-brand)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                      >
                        Save
                      </button>
                    </div>
                  </li>
                ) : (
                  <li
                    key={l.id}
                    className="py-2 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0 flex items-center gap-2">
                      <LabelChip name={l.name} color={l.color} size="sm" />
                      {l.mailbox_id && (
                        <span className="text-[10px] uppercase tracking-wider text-neutral-500">
                          mailbox
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => startEdit(l)}
                        disabled={isPending}
                        className="text-xs text-neutral-600 hover:underline disabled:opacity-50 dark:text-neutral-400"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(l)}
                        disabled={isPending}
                        className="text-xs text-red-600 hover:underline disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ),
              )}
            </ul>
            {actionError && (
              <div className="mt-2 text-xs text-red-600">{actionError}</div>
            )}
          </section>

          {/* Create form */}
          <section className="px-4 py-3 space-y-2">
            <div className="text-xs uppercase tracking-wider text-neutral-500">
              New label
            </div>
            <input
              type="text"
              placeholder="e.g. Receipts"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") create();
              }}
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)]"
            />
            <ColorPicker value={newColor} onChange={setNewColor} />
            <div className="flex items-center justify-end">
              <button
                type="button"
                onClick={create}
                disabled={isPending}
                className="rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {isPending ? "Creating…" : "Create label"}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function ColorPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {PRESET_COLORS.map((c, i) => {
        const isSelected = value === c;
        return (
          <button
            key={c ?? "none"}
            type="button"
            onClick={() => onChange(c)}
            aria-label={c ?? "no color"}
            title={c ?? "no color"}
            className={`h-6 w-6 rounded-full border transition-all ${
              isSelected
                ? "border-neutral-900 dark:border-neutral-100 scale-110"
                : "border-neutral-300 dark:border-neutral-700"
            }`}
            style={{
              backgroundColor: c ?? "transparent",
              backgroundImage: c
                ? undefined
                : "linear-gradient(45deg, transparent 45%, #d4d4d4 45% 55%, transparent 55%)",
            }}
          >
            {i === 0 && !c && (
              <span className="sr-only">no color</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
