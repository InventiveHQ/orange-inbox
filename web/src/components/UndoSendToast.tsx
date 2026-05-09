"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  scheduledId: string;
  delaySeconds: number;
  onUndone: (draftId: string) => void;
  onDismiss: () => void;
}

// Bottom-of-screen toast shown right after Send when Undo Send is enabled.
// The countdown is purely informational — the cancel window stays open as
// long as the row is still 'pending' on the server, which in practice
// extends past the displayed countdown (cron only ticks once a minute).
export default function UndoSendToast({ scheduledId, delaySeconds, onUndone, onDismiss }: Props) {
  const [secsLeft, setSecsLeft] = useState(delaySeconds);
  const [error, setError] = useState<string | null>(null);
  const [isUndoing, setIsUndoing] = useState(false);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    const handle = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt.current) / 1000);
      const remaining = Math.max(0, delaySeconds - elapsed);
      setSecsLeft(remaining);
      if (remaining <= 0) {
        clearInterval(handle);
        // Linger briefly at 0 so the user sees the final state, then dismiss.
        setTimeout(onDismiss, 800);
      }
    }, 250);
    return () => clearInterval(handle);
  }, [delaySeconds, onDismiss]);

  async function undo() {
    if (isUndoing) return;
    setIsUndoing(true);
    setError(null);
    try {
      const res = await fetch(`/api/scheduled/${scheduledId}/undo`, { method: "POST" });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error === "already_finalised" ? "Too late — message already sent." : (b.error ?? "Undo failed"));
        setIsUndoing(false);
        return;
      }
      const b = (await res.json()) as { draft_id?: string };
      if (b.draft_id) onUndone(b.draft_id);
      else onDismiss();
    } catch {
      setError("Undo failed");
      setIsUndoing(false);
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 shadow-xl px-4 py-2.5 text-sm"
    >
      <span>
        {secsLeft > 0 ? `Sending in ${secsLeft}s` : "Sending…"}
      </span>
      {error ? (
        <span className="text-red-400 dark:text-red-600">{error}</span>
      ) : (
        <button
          type="button"
          onClick={undo}
          disabled={isUndoing || secsLeft <= 0}
          className="font-medium text-[var(--color-brand)] hover:underline disabled:opacity-50 disabled:no-underline"
        >
          {isUndoing ? "Undoing…" : "Undo"}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-neutral-400 hover:text-white dark:text-neutral-500 dark:hover:text-neutral-900 leading-none px-1"
      >
        ×
      </button>
    </div>
  );
}
