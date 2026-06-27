"use client";

import { useEffect, useState } from "react";

// One-line AI summary shown above a thread (0056). Fetched lazily after the
// thread paints so it never blocks the reader; the server generates + caches
// on first open (Workers AI) and returns the cached line thereafter. Renders
// nothing when there's no summary (short thread, or AI unavailable).
export default function ThreadSummary({ threadId }: { threadId: string }) {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // Thread changed: clear the previous summary and show loading. This is an
    // external-sync reset driven by the threadId prop, not derived state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setSummary(null);
    void (async () => {
      try {
        const res = await fetch(`/api/threads/${threadId}/summary`);
        if (!cancelled && res.ok) {
          const j = (await res.json()) as { summary: string | null };
          setSummary(j.summary ?? null);
        }
      } catch {
        // Network/AI hiccup — just show no summary.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  if (loading) {
    return (
      <div className="border-b border-neutral-200 dark:border-neutral-800 bg-[var(--color-brand)]/5 px-4 py-2 sm:px-6 text-xs text-neutral-400">
        <span className="animate-pulse">Summarising…</span>
      </div>
    );
  }
  if (!summary) return null;

  return (
    <div className="flex items-start gap-2 border-b border-neutral-200 dark:border-neutral-800 bg-[var(--color-brand)]/5 px-4 py-2 sm:px-6 text-xs text-neutral-600 dark:text-neutral-300">
      <span aria-hidden className="select-none">✨</span>
      <p className="flex-1 leading-relaxed">{summary}</p>
    </div>
  );
}
