"use client";

/* eslint-disable react-hooks/set-state-in-effect -- mount-time browser-API
   reads and data loads are the intended use of these effects. */

import { useCallback, useEffect, useMemo, useState } from "react";

interface Props {
  slug: string;
  token: string;
  eventName: string;
  durationMinutes: number;
  bookingWindowDays: number;
  currentStart: number;
  reschedulable: boolean;
}

interface Slot {
  start: number;
  end: number;
}

const BRAND = "#f38020";

export default function RescheduleClient(props: Props) {
  const [tz, setTz] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Slot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneAt, setDoneAt] = useState<number | null>(null);

  useEffect(() => {
    setTz(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    if (!props.reschedulable) {
      setLoading(false);
      return;
    }
    const from = Math.floor(Date.now() / 1000);
    const to = from + Math.min(props.bookingWindowDays || 60, 60) * 86400;
    fetch(`/p/api/book/${props.slug}/availability?from=${from}&to=${to}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((j) => setSlots((j as { slots?: Slot[] }).slots ?? []))
      .catch(() => setError("Couldn't load available times."))
      .finally(() => setLoading(false));
  }, [props.slug, props.bookingWindowDays, props.reschedulable]);

  const fmtDayKey = useCallback(
    (e: number) =>
      tz
        ? new Intl.DateTimeFormat("en-CA", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(e * 1000))
        : "",
    [tz],
  );
  const fmtDay = useCallback(
    (e: number) =>
      new Intl.DateTimeFormat(undefined, {
        timeZone: tz || "UTC",
        weekday: "long",
        month: "short",
        day: "numeric",
      }).format(new Date(e * 1000)),
    [tz],
  );
  const fmtTime = useCallback(
    (e: number) =>
      new Intl.DateTimeFormat(undefined, {
        timeZone: tz || "UTC",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(e * 1000)),
    [tz],
  );

  const days = useMemo(() => {
    const g = new Map<string, Slot[]>();
    for (const s of slots) {
      const k = fmtDayKey(s.start);
      (g.get(k) ?? g.set(k, []).get(k)!).push(s);
    }
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [slots, fmtDayKey]);

  async function confirm() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/p/api/book/reschedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: props.token, start: selected.start }),
      });
      const j = (await r.json().catch(() => null)) as
        | { ok?: boolean; startsAt?: number; message?: string }
        | null;
      if (!r.ok || !j?.ok) {
        setError(j?.message ?? "Could not reschedule. Please try again.");
        return;
      }
      setDoneAt(j.startsAt ?? selected.start);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  const card =
    "rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm sm:p-8 dark:border-neutral-800 dark:bg-neutral-900";

  if (!props.reschedulable) {
    return (
      <div className={card}>
        <h1 className="text-lg font-semibold">Can&apos;t reschedule</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          This booking has been cancelled or already changed. Please book a new
          time or contact the host.
        </p>
      </div>
    );
  }

  if (doneAt) {
    return (
      <div className={card}>
        <div className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-2xl dark:bg-green-900/30">
            ✓
          </div>
          <h1 className="mt-4 text-lg font-semibold">Booking rescheduled</h1>
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            &ldquo;{props.eventName}&rdquo; is now {fmtDay(doneAt)} at{" "}
            {fmtTime(doneAt)} ({tz}). An updated invite is on its way.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={card}>
      <h1 className="text-xl font-semibold">Reschedule: {props.eventName}</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Currently {fmtDay(props.currentStart)} at {fmtTime(props.currentStart)}.
        Pick a new time below.
      </p>
      {selected ? (
        <div className="mt-5">
          <div className="rounded-lg bg-neutral-100 p-4 text-sm dark:bg-neutral-800">
            New time: <span className="font-medium">{fmtDay(selected.start)}</span> at{" "}
            {fmtTime(selected.start)} ({tz})
          </div>
          {error && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          <div className="mt-4 flex gap-3">
            <button
              onClick={() => setSelected(null)}
              className="rounded-lg border border-neutral-300 px-4 py-2.5 text-sm font-medium dark:border-neutral-700"
            >
              Pick another
            </button>
            <button
              onClick={confirm}
              disabled={busy}
              className="flex-1 rounded-lg px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60"
              style={{ backgroundColor: BRAND }}
            >
              {busy ? "Rescheduling…" : "Confirm new time"}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-5">
          {loading && <p className="text-sm text-neutral-500">Loading times…</p>}
          {error && !loading && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          {!loading && !error && days.length === 0 && (
            <p className="text-sm text-neutral-500">No open times available.</p>
          )}
          {!loading && days.length > 0 && (
            <>
              <p className="mb-3 text-xs text-neutral-400">Times shown in {tz}</p>
              <div className="space-y-5">
                {days.map(([key, ds]) => (
                  <div key={key}>
                    <div className="mb-2 text-sm font-medium">
                      {fmtDay(ds[0].start)}
                    </div>
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {ds.map((s) => (
                        <button
                          key={s.start}
                          onClick={() => setSelected(s)}
                          className="rounded-lg border border-neutral-300 px-2 py-2 text-sm font-medium hover:border-orange-500 hover:text-orange-600 dark:border-neutral-700"
                        >
                          {fmtTime(s.start)}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
