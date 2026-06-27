"use client";

import { useState } from "react";
import {
  useEventComposer,
  type EventComposerPrefill,
} from "./EventComposerProvider";

// "Add to calendar" from a thread (the Superhuman favourite: a date in an
// email → one action → a prefilled event). Asks the server to extract the
// event with Workers AI (resolving relative dates against the browser's local
// clock + zone), then opens the event composer prefilled for review. Always
// opens the composer — if no date is found it falls back to the subject as
// title and the next top-of-the-hour, so the action is never a dead end.
//
// Carries data-action="add-event" so the keyboard handler can trigger it.

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Browser-local "YYYY-MM-DDTHH:MM" — the anchor the model resolves relative
// dates against.
function localNow(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

// "YYYY-MM-DDTHH:MM" (no offset) parses as LOCAL time per spec — matches how
// the event form's datetime-local inputs are interpreted.
function localToUnix(s: string): number | null {
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function nextHourUnix(): number {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return Math.floor(d.getTime() / 1000);
}

interface Suggestion {
  found: boolean;
  title: string | null;
  start_local: string | null;
  end_local: string | null;
  all_day: boolean;
  location: string | null;
}

export default function AddToCalendarButton({
  threadId,
  subject,
}: {
  threadId: string;
  subject: string;
}) {
  const composer = useEventComposer();
  const [loading, setLoading] = useState(false);

  async function run() {
    if (loading) return;
    setLoading(true);
    const start = nextHourUnix();
    let prefill: EventComposerPrefill = {
      summary: subject || "Event",
      startsAt: start,
      endsAt: start + 3600,
    };
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const res = await fetch(`/api/threads/${threadId}/event-suggestion`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ now: localNow(), tz }),
      });
      if (res.ok) {
        const s = (await res.json()) as Suggestion;
        const startUnix = s.found && s.start_local ? localToUnix(s.start_local) : null;
        if (startUnix) {
          const endUnix = s.end_local ? localToUnix(s.end_local) : null;
          prefill = {
            summary: s.title || subject || "Event",
            startsAt: startUnix,
            endsAt: s.all_day ? undefined : endUnix ?? startUnix + 3600,
            allDay: s.all_day,
            location: s.location ?? undefined,
          };
        }
      }
    } catch {
      // Network/AI hiccup — fall through with the default prefill.
    } finally {
      setLoading(false);
    }
    composer.open(prefill);
  }

  return (
    <button
      type="button"
      data-action="add-event"
      onClick={run}
      disabled={loading}
      aria-label="Add to calendar"
      title="Add to calendar (t)"
      className="rounded-md p-1.5 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900 disabled:opacity-50"
    >
      {loading ? (
        <span className="inline-block h-4 w-4 animate-pulse text-center leading-4">…</span>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
          <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="1.5" />
          <path d="M2.25 6.25h11.5M5 1.75v2.5M11 1.75v2.5M8 8.25v3.25M6.375 9.875h3.25" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}
