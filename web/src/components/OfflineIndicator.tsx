"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { flushOutbox, onOutboxEvent } from "@/lib/sw-client";

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

// Status pill rendered in the inbox top bar. Three visual states:
//
//   • Online + no queue   → renders nothing (don't take chrome space when
//                           there's nothing to say).
//   • Offline             → grey "Offline" pill.
//   • Flushing            → blue "Sending {N} queued…" pill, updates as the
//                           SW broadcasts progress.
//   • Stuck failures      → red "{N} send(s) failed" pill that stays until
//                           the user acts (clicking dismisses for the
//                           session; the queued rows remain in IndexedDB
//                           for follow-up).
//
// The component is purely presentational on top of `navigator.onLine` plus
// `outbox-flush-*` messages broadcast by the service worker.
export default function OfflineIndicator() {
  // useSyncExternalStore handles SSR (returns `true`) and gives us the
  // initial-read-on-mount semantics without a setState-in-effect.
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  const [flushing, setFlushing] = useState<{ total: number; done: number } | null>(null);
  const [failed, setFailed] = useState(0);
  const [dismissedFailed, setDismissedFailed] = useState(false);

  // Kick off a flush whenever connectivity returns. The SW also runs its own
  // 'online' listener, but that doesn't always fire on Safari/iOS so do it
  // from the page side too.
  useEffect(() => {
    if (online) flushOutbox("online");
  }, [online]);

  useEffect(() => {
    const unsub = onOutboxEvent(ev => {
      if (ev.type === "outbox-flush-start") {
        if (ev.total > 0) setFlushing({ total: ev.total, done: 0 });
        return;
      }
      if (ev.type === "outbox-flush-progress") {
        setFlushing(prev => (prev ? { ...prev, done: prev.done + 1 } : prev));
        if (ev.status === "failed") {
          setFailed(f => f + 1);
          setDismissedFailed(false);
        }
        return;
      }
      if (ev.type === "outbox-flush-done") {
        setFlushing(null);
        // If the flush ended with remaining 'pending' rows we'll learn about
        // them on the next online/sync cycle; nothing for this pill to show.
        if (ev.failed === 0) {
          // Reset the failed counter once a clean flush completes — the user
          // has either retried, or the failed rows are now history.
        }
      }
    });
    return unsub;
  }, []);

  if (!online) {
    return (
      <span
        role="status"
        aria-live="polite"
        className="inline-flex items-center gap-1.5 rounded-full bg-neutral-200 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 text-xs px-2 py-0.5 select-none"
        title="You're offline. Cached threads are available; messages you send will be queued."
      >
        <Dot className="text-neutral-500" />
        Offline
      </span>
    );
  }

  if (flushing) {
    return (
      <span
        role="status"
        aria-live="polite"
        className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 text-xs px-2 py-0.5 select-none"
      >
        <Spinner />
        Sending {flushing.total - flushing.done}/{flushing.total} queued…
      </span>
    );
  }

  if (failed > 0 && !dismissedFailed) {
    return (
      <button
        type="button"
        onClick={() => setDismissedFailed(true)}
        className="inline-flex items-center gap-1.5 rounded-full bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-200 text-xs px-2 py-0.5"
        title="One or more queued messages couldn't be sent. Re-open compose to retry."
      >
        <Dot className="text-red-500" />
        {failed} send{failed === 1 ? "" : "s"} failed
        <span aria-hidden className="opacity-60 ml-1">
          ×
        </span>
      </button>
    );
  }

  return null;
}

function Dot({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 8 8"
      width="6"
      height="6"
      aria-hidden
      className={className}
      fill="currentColor"
    >
      <circle cx="4" cy="4" r="4" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      aria-hidden
      className="animate-spin"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="8" cy="8" r="6" strokeOpacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" strokeLinecap="round" />
    </svg>
  );
}
