"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

interface Props {
  // Either a static label, or a function called every tick with the seconds
  // remaining (use this when the countdown should be embedded mid-sentence,
  // e.g. "Sending in 4s").
  message: string | ((secsLeft: number) => string);
  // Window the user has to hit Undo, in seconds. The displayed countdown is
  // anchored at mount; once it hits zero we wait briefly then call onCommit.
  delaySeconds: number;
  // Fired when the user clicks Undo. The toast dismisses itself on resolve.
  onUndo: () => void | Promise<void>;
  // Fired exactly once if the timer expires without an undo. Use this for the
  // deferred-action pattern (e.g. perform the actual hard delete here).
  // Optional — the existing UndoSendToast doesn't need it since the real
  // commit happens server-side via cron.
  onCommit?: () => void | Promise<void>;
  onDismiss: () => void;
  // Label shown after the user clicks Undo (and while the undo is in flight).
  // Defaults to a generic "Undoing…".
  undoingLabel?: string;
  // Static error replacing the Undo button when the undo call fails. Provided
  // by the caller because the friendliest copy depends on the action.
  errorMessage?: string | null;
}

// Reusable bottom-of-screen toast for optimistic actions: shows a countdown,
// an Undo button, and a dismiss control. Two distinct flows:
//
//   - "fire-then-reverse" (archive, send): the action has already happened on
//     the server when the toast appears; clicking Undo asks the server to
//     reverse it.
//   - "defer-then-fire"  (delete): the action hasn't run yet. The toast
//     waits out the timer, then `onCommit` runs the irreversible call.
//     Clicking Undo just cancels the timer.
//
// Both flows look identical to the user.
export default function UndoToast({
  message,
  delaySeconds,
  onUndo,
  onCommit,
  onDismiss,
  undoingLabel = "Undoing…",
  errorMessage = null,
}: Props) {
  const [secsLeft, setSecsLeft] = useState(delaySeconds);
  const [isUndoing, setIsUndoing] = useState(false);
  // Once the user has clicked Undo or the timer has expired, the toast is in
  // a terminal phase — we suppress further timer ticks and the auto-commit so
  // we don't double-fire onCommit or race onUndo.
  const settledRef = useRef(false);
  // Pin the callbacks behind refs so the timer effect can ignore them in its
  // dependency array. Otherwise every parent re-render hands us new function
  // identities, the effect tears down and remounts, and the countdown restarts
  // mid-flight — making "Undo" effectively unreachable while the parent keeps
  // re-rendering.
  const onUndoRef = useRef(onUndo);
  const onCommitRef = useRef(onCommit);
  const onDismissRef = useRef(onDismiss);
  useLayoutEffect(() => {
    onUndoRef.current = onUndo;
    onCommitRef.current = onCommit;
    onDismissRef.current = onDismiss;
  });

  useEffect(() => {
    // Anchor the countdown on mount, not at first render — render-phase calls
    // to Date.now() trip react-hooks/purity (the value would change across
    // re-renders before the effect ran).
    const startedAt = Date.now();
    const handle = setInterval(() => {
      if (settledRef.current) {
        clearInterval(handle);
        return;
      }
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const remaining = Math.max(0, delaySeconds - elapsed);
      setSecsLeft(remaining);
      if (remaining <= 0) {
        clearInterval(handle);
        if (settledRef.current) return;
        settledRef.current = true;
        // Fire the commit (if any), then linger briefly so the user sees the
        // final state before the toast disappears.
        void Promise.resolve(onCommitRef.current?.()).finally(() => {
          setTimeout(() => onDismissRef.current(), 800);
        });
      }
    }, 250);
    return () => clearInterval(handle);
  }, [delaySeconds]);

  async function undo() {
    if (isUndoing || settledRef.current) return;
    settledRef.current = true;
    setIsUndoing(true);
    try {
      await onUndoRef.current();
    } finally {
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
        {typeof message === "function"
          ? message(secsLeft)
          : secsLeft > 0
            ? `${message} (${secsLeft}s)`
            : message}
      </span>
      {errorMessage ? (
        <span className="text-red-400 dark:text-red-600">{errorMessage}</span>
      ) : (
        <button
          type="button"
          onClick={undo}
          disabled={isUndoing || secsLeft <= 0}
          className="font-medium text-[var(--color-brand)] hover:underline disabled:opacity-50 disabled:no-underline"
        >
          {isUndoing ? undoingLabel : "Undo"}
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
