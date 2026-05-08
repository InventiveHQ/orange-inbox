"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Props {
  threadId: string;
  initialSnoozedUntil?: number | null;
}

// Tomorrow at 8am. Used by the "Tomorrow" preset.
function tomorrowMorning(now = new Date()): number {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// Next Monday at 8am.
function nextMondayMorning(now = new Date()): number {
  const d = new Date(now);
  const day = d.getDay(); // 0=Sun..6=Sat
  const daysToMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
  d.setDate(d.getDate() + daysToMonday);
  d.setHours(8, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export default function SnoozeButton({ threadId, initialSnoozedUntil }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const isSnoozed = !!initialSnoozedUntil && initialSnoozedUntil > Math.floor(Date.now() / 1000);
  const containerRef = useRef<HTMLDivElement>(null);

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

  function snoozeUntil(seconds: number) {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/threads/${threadId}/snooze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snoozed_until: seconds }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      setOpen(false);
      router.refresh();
      router.push("/inbox/all");
    });
  }

  function unsnooze() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/threads/${threadId}/snooze`, { method: "DELETE" });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  function snoozeCustom() {
    if (!customValue) return;
    const ms = Date.parse(customValue);
    if (isNaN(ms)) {
      setError("Invalid date");
      return;
    }
    const seconds = Math.floor(ms / 1000);
    if (seconds <= Math.floor(Date.now() / 1000)) {
      setError("Pick a future time");
      return;
    }
    snoozeUntil(seconds);
  }

  const presets = [
    { label: "1 hour", seconds: () => Math.floor(Date.now() / 1000) + 3600 },
    { label: "Tomorrow 8am", seconds: tomorrowMorning },
    { label: "Next Monday", seconds: nextMondayMorning },
  ];

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title={isSnoozed ? "Snoozed (click to manage)" : "Snooze"}
        aria-label="Snooze"
        className={`rounded-md border px-2 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 ${
          isSnoozed
            ? "border-amber-300 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:border-amber-700/60 dark:text-amber-200"
            : "border-neutral-300 dark:border-neutral-700"
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm.75 3.5v3.69l2.53 1.46a.75.75 0 1 1-.75 1.3L7.625 9.16A.75.75 0 0 1 7.25 8.5v-4a.75.75 0 0 1 1.5 0Z" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-30 w-64 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg"
        >
          {isSnoozed && (
            <button
              type="button"
              onClick={unsnooze}
              disabled={isPending}
              className="w-full text-left px-3 py-2 text-sm text-amber-700 dark:text-amber-200 hover:bg-amber-50 dark:hover:bg-amber-950/40"
            >
              Un-snooze now
            </button>
          )}
          <div className="border-t border-neutral-200 dark:border-neutral-800" aria-hidden />
          {presets.map(p => (
            <button
              key={p.label}
              type="button"
              onClick={() => snoozeUntil(p.seconds())}
              disabled={isPending}
              className="w-full text-left px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900"
            >
              {p.label}
            </button>
          ))}
          <div className="border-t border-neutral-200 dark:border-neutral-800 px-3 py-2 space-y-1">
            <label className="text-xs uppercase tracking-wider text-neutral-500">Custom</label>
            <input
              type="datetime-local"
              value={customValue}
              onChange={e => setCustomValue(e.target.value)}
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm focus:outline-none focus:border-[var(--color-brand)]"
            />
            <button
              type="button"
              onClick={snoozeCustom}
              disabled={isPending || !customValue}
              className="w-full rounded-md bg-[var(--color-brand)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              Snooze until
            </button>
            {error && <div className="text-xs text-red-600">{error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
