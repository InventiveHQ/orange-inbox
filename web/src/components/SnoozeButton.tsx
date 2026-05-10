"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "./ToastProvider";

interface Props {
  threadId: string;
  initialSnoozedUntil?: number | null;
}

// Today at 17:00, or tomorrow 09:00 if it's already past 17:00.
function laterToday(now = new Date()): Date {
  const d = new Date(now);
  if (now.getHours() < 17) {
    d.setHours(17, 0, 0, 0);
  } else {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  }
  return d;
}

// Tomorrow at 09:00.
function tomorrowMorning(now = new Date()): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

// Next Saturday at 09:00. If today is Sat before 09:00, use today.
function thisWeekend(now = new Date()): Date {
  const d = new Date(now);
  const day = d.getDay(); // 0=Sun..6=Sat
  if (day === 6 && now.getHours() < 9) {
    d.setHours(9, 0, 0, 0);
    return d;
  }
  const daysToSat = (6 - day + 7) % 7 || 7;
  d.setDate(d.getDate() + daysToSat);
  d.setHours(9, 0, 0, 0);
  return d;
}

// Next Monday at 09:00 (always at least one day out).
function nextWeek(now = new Date()): Date {
  const d = new Date(now);
  const day = d.getDay();
  const daysToMon = day === 1 ? 7 : (8 - day) % 7 || 7;
  d.setDate(d.getDate() + daysToMon);
  d.setHours(9, 0, 0, 0);
  return d;
}

// "Sun 9:00 AM" / "Tue 5:00 PM" — short subtitle for the resolved time.
function formatPresetSubtitle(d: Date): string {
  const weekday = d.toLocaleDateString(undefined, { weekday: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${weekday} ${time}`;
}

// "Mon, May 12 at 5:00 PM" — long format for the snoozed-until banner.
function formatSnoozedUntil(secs: number): string {
  const d = new Date(secs * 1000);
  const date = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} at ${time}`;
}

export default function SnoozeButton({ threadId, initialSnoozedUntil }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const isSnoozed = !!initialSnoozedUntil && initialSnoozedUntil > Math.floor(Date.now() / 1000);
  const containerRef = useRef<HTMLDivElement>(null);

  function closePopover() {
    setOpen(false);
    setShowCustom(false);
    setCustomValue("");
    setError(null);
  }

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closePopover();
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Recompute presets each time the popover opens so subtitles stay accurate.
  const presets = useMemo(() => {
    if (!open) return [];
    const now = new Date();
    return [
      { key: "later", label: "Later today", date: laterToday(now) },
      { key: "tomorrow", label: "Tomorrow morning", date: tomorrowMorning(now) },
      { key: "weekend", label: "This weekend", date: thisWeekend(now) },
      { key: "nextweek", label: "Next week", date: nextWeek(now) },
    ];
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
      closePopover();
      toast({
        message: `Snoozed until ${new Date(seconds * 1000).toLocaleString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}`,
        action: {
          label: "Undo",
          onClick: async () => {
            await fetch(`/api/threads/${threadId}/snooze`, { method: "DELETE" });
            router.refresh();
          },
        },
      });
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
      closePopover();
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

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        data-action="snooze"
        onClick={() => (open ? closePopover() : setOpen(true))}
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
          className="absolute right-0 top-full mt-1 z-30 w-72 overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg"
        >
          {isSnoozed && initialSnoozedUntil && (
            <div className="border-b border-neutral-200 dark:border-neutral-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2">
              <div className="text-xs text-amber-700 dark:text-amber-200">
                Snoozed until {formatSnoozedUntil(initialSnoozedUntil)}
              </div>
              <button
                type="button"
                onClick={unsnooze}
                disabled={isPending}
                className="mt-1 text-sm font-medium text-amber-800 dark:text-amber-100 hover:underline disabled:opacity-50"
              >
                Unsnooze now
              </button>
            </div>
          )}
          <div className="py-1">
            {presets.map(p => (
              <button
                key={p.key}
                type="button"
                onClick={() => snoozeUntil(Math.floor(p.date.getTime() / 1000))}
                disabled={isPending}
                className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
              >
                <span className="text-sm">{p.label}</span>
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  {formatPresetSubtitle(p.date)}
                </span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setShowCustom(s => !s)}
              className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900"
              aria-expanded={showCustom}
            >
              <span className="text-sm">Custom…</span>
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                {showCustom ? "Hide" : "Pick a time"}
              </span>
            </button>
          </div>
          {showCustom && (
            <div className="border-t border-neutral-200 dark:border-neutral-800 px-3 py-2 space-y-2">
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
            </div>
          )}
          {error && (
            <div className="border-t border-neutral-200 dark:border-neutral-800 px-3 py-2 text-xs text-red-600">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
