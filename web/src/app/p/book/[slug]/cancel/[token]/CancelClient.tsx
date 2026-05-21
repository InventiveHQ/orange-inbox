"use client";

import { useState } from "react";

interface Props {
  token: string;
  eventName: string;
  startsAt: number;
  alreadyCancelled: boolean;
}

export default function CancelClient(props: Props) {
  const [done, setDone] = useState(props.alreadyCancelled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const when = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(props.startsAt * 1000));

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/p/api/book/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: props.token }),
      });
      if (!r.ok) throw new Error(`status ${r.status}`);
      setDone(true);
    } catch {
      setError("Could not cancel. Please try again or contact the host.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm sm:p-8 dark:border-neutral-800 dark:bg-neutral-900">
      {done ? (
        <div className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-neutral-200 text-2xl dark:bg-neutral-800">
            ✕
          </div>
          <h1 className="mt-4 text-lg font-semibold">Booking cancelled</h1>
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            Your booking for &ldquo;{props.eventName}&rdquo; has been cancelled.
            The host has been notified.
          </p>
        </div>
      ) : (
        <div>
          <h1 className="text-lg font-semibold">Cancel this booking?</h1>
          <div className="mt-4 rounded-lg bg-neutral-100 p-4 text-sm dark:bg-neutral-800">
            <div className="font-medium">{props.eventName}</div>
            <div className="text-neutral-500">{when}</div>
          </div>
          {error && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          <button
            onClick={cancel}
            disabled={busy}
            className="mt-4 w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
          >
            {busy ? "Cancelling…" : "Cancel booking"}
          </button>
        </div>
      )}
    </div>
  );
}
