"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  query: string;
}

// Small affordance shown on the /search results header that turns the active
// query into a Smart Mailbox the user can pin to the sidebar.
//
// V1 UX: a browser `prompt()` for the name. It's deliberately lightweight —
// no extra modal infrastructure for a one-input flow, and matches how the
// rest of the inbox surfaces quick destructive/creating dialogs (e.g.
// label rename). Pre-fills with the raw query so the user can hit Enter to
// confirm a sensible default.
export default function SaveSearchButton({ query }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    if (busy) return;
    setError(null);
    const trimmed = query.trim();
    if (!trimmed) return;

    const suggested = trimmed.length > 40 ? trimmed.slice(0, 40) + "…" : trimmed;
    const name = window.prompt("Name this saved search", suggested);
    if (name == null) return; // user cancelled
    const cleaned = name.trim();
    if (!cleaned) return;

    setBusy(true);
    try {
      const res = await fetch("/api/saved-searches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: cleaned, query: trimmed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Save failed (${res.status})`);
        return;
      }
      // Refresh so the layout-level Sidebar picks up the new entry.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="inline-flex items-center gap-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1 text-xs font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
        title="Save this search as a Smart Mailbox"
      >
        <BookmarkIcon />
        {busy ? "Saving…" : "Save this search"}
      </button>
      {error && (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      )}
    </div>
  );
}

function BookmarkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M4 2a1 1 0 0 0-1 1v11.5a.5.5 0 0 0 .79.41L8 11.96l4.21 2.95a.5.5 0 0 0 .79-.41V3a1 1 0 0 0-1-1H4Z" />
    </svg>
  );
}
