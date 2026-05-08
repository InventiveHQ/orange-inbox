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
  const containerRef = useRef<HTMLDivElement>(null);

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

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="Apply label"
        aria-label="Apply label"
        className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h4.379a1.5 1.5 0 0 1 1.06.44l5.122 5.12a1.5 1.5 0 0 1 0 2.122l-4.379 4.378a1.5 1.5 0 0 1-2.121 0L2.44 8.94A1.5 1.5 0 0 1 2 7.879V3.5Zm3.25 2.25a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Z" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-30 w-64 max-h-72 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg"
          role="menu"
        >
          {available === null && !error && (
            <div className="px-3 py-2 text-xs text-neutral-500">Loading…</div>
          )}
          {error && (
            <div className="px-3 py-2 text-xs text-red-600">{error}</div>
          )}
          {available && available.length === 0 && (
            <div className="px-3 py-2 text-xs text-neutral-500">
              No labels yet. Create one from the sidebar.
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
                      onClick={() => toggle(l)}
                      disabled={isPending}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-60"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        readOnly
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
        </div>
      )}
    </div>
  );
}
