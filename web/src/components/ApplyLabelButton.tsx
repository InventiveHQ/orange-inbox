"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Label {
  id: string;
  name: string;
  color: string | null;
  mailbox_id: string | null;
}

// Header-button + popover for applying labels to a single thread. Loads the
// user's accessible labels (and the thread's currently-applied set) on first
// open, then POSTs/DELETEs against /api/threads/{id}/labels to toggle.
export default function ApplyLabelButton({ threadId }: { threadId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [available, setAvailable] = useState<Label[] | null>(null);
  const [appliedIds, setAppliedIds] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setError(null);
      const [allRes, threadRes] = await Promise.all([
        fetch("/api/labels"),
        fetch(`/api/threads/${threadId}/labels`),
      ]);
      if (cancelled) return;
      if (!allRes.ok || !threadRes.ok) {
        setError("Failed to load labels");
        return;
      }
      const all = (await allRes.json()) as { labels: Label[] };
      const applied = (await threadRes.json()) as { labels: { id: string }[] };
      setAvailable(all.labels);
      setAppliedIds(new Set(applied.labels.map(l => l.id)));
    })();
    return () => {
      cancelled = true;
    };
  }, [open, threadId]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Once the labels render, focus the first item so arrow keys can drive
  // the menu without the user having to click anything.
  useEffect(() => {
    if (!open || !available || available.length === 0) return;
    const first = popoverRef.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"]');
    first?.focus();
  }, [open, available]);

  function focusItem(delta: 1 | -1 | "first" | "last") {
    const items = Array.from(
      popoverRef.current?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]') ?? [],
    );
    if (items.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? items.indexOf(active) : -1;
    let next: number;
    if (delta === "first") next = 0;
    else if (delta === "last") next = items.length - 1;
    else if (idx === -1) next = delta === 1 ? 0 : items.length - 1;
    else next = (idx + delta + items.length) % items.length;
    items[next].focus();
  }

  function onPopoverKey(e: React.KeyboardEvent) {
    // Don't hijack arrow keys while typing into the new-label input.
    const inInput = (e.target as HTMLElement).tagName === "INPUT";
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (inInput) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusItem(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        focusItem(-1);
        return;
      case "Home":
        e.preventDefault();
        focusItem("first");
        return;
      case "End":
        e.preventDefault();
        focusItem("last");
        return;
    }
  }

  function onTriggerKey(e: React.KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setOpen(true);
    }
  }

  function toggle(label: Label) {
    if (!appliedIds) return;
    const isApplied = appliedIds.has(label.id);
    // Optimistic UI; revert on failure.
    const next = new Set(appliedIds);
    if (isApplied) next.delete(label.id);
    else next.add(label.id);
    setAppliedIds(next);
    setError(null);
    startTransition(async () => {
      const res = isApplied
        ? await fetch(`/api/threads/${threadId}/labels/${label.id}`, { method: "DELETE" })
        : await fetch(`/api/threads/${threadId}/labels`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ label_id: label.id }),
          });
      if (!res.ok) {
        setAppliedIds(appliedIds);
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      router.refresh();
    });
  }

  async function createAndApply() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const createRes = await fetch("/api/labels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color: null }),
      });
      const createJson = (await createRes.json().catch(() => ({}))) as {
        label?: Label;
        error?: string;
      };
      if (!createRes.ok || !createJson.label) {
        setError(createJson.error ?? `Failed (${createRes.status})`);
        return;
      }
      const label = createJson.label;
      const applyRes = await fetch(`/api/threads/${threadId}/labels`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label_id: label.id }),
      });
      if (!applyRes.ok) {
        const b = (await applyRes.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${applyRes.status})`);
        return;
      }
      setAvailable(prev => (prev ? [...prev, label] : [label]));
      setAppliedIds(prev => {
        const next = new Set(prev ?? []);
        next.add(label.id);
        return next;
      });
      setNewName("");
      router.refresh();
    } finally {
      setCreating(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-action="label"
        onClick={() => setOpen(o => !o)}
        onKeyDown={onTriggerKey}
        title="Apply label"
        aria-label="Apply label"
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h4.379a1.5 1.5 0 0 1 1.06.44l5.122 5.12a1.5 1.5 0 0 1 0 2.122l-4.379 4.378a1.5 1.5 0 0 1-2.121 0L2.44 8.94A1.5 1.5 0 0 1 2 7.879V3.5Zm3.25 2.25a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Z" />
        </svg>
      </button>

      {open && (
        <div
          ref={popoverRef}
          onKeyDown={onPopoverKey}
          className="absolute right-0 top-full mt-1 z-30 w-64 max-h-72 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg"
          role="menu"
          aria-label="Apply label"
        >
          {available === null && !error && (
            <div className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">Loading…</div>
          )}
          {error && (
            <div role="alert" className="px-3 py-2 text-xs text-red-700 dark:text-red-400">{error}</div>
          )}
          {available && available.length === 0 && (
            <div className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">
              No labels yet. Create one below.
            </div>
          )}
          {available && available.length > 0 && (
            <ul className="py-1">
              {available.map(l => {
                const checked = appliedIds?.has(l.id) ?? false;
                return (
                  <li key={l.id}>
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={checked}
                      onClick={() => toggle(l)}
                      disabled={isPending}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 focus:bg-neutral-100 dark:focus:bg-neutral-900 focus:outline-none disabled:opacity-60"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        readOnly
                        tabIndex={-1}
                        aria-hidden
                        className="pointer-events-none"
                      />
                      <span
                        aria-hidden
                        className="inline-block w-2.5 h-2.5 rounded-full"
                        style={{ backgroundColor: l.color ?? "#9ca3af" }}
                      />
                      <span className="truncate">{l.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {available !== null && (
            <div className="border-t border-neutral-200 dark:border-neutral-800 p-2 flex items-center gap-1.5">
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void createAndApply();
                  }
                }}
                placeholder="New label"
                aria-label="New label name"
                maxLength={64}
                disabled={creating}
                className="flex-1 min-w-0 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm focus:outline-none focus:border-[var(--color-brand)] disabled:opacity-60"
              />
              <button
                type="button"
                onClick={() => void createAndApply()}
                disabled={creating || !newName.trim()}
                className="rounded-md bg-[var(--color-brand)] px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
              >
                Create
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
