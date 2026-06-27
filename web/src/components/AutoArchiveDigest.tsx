"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// Reassurance banner for the opt-in auto-archive (0055). Shown above the
// unified inbox when the sweep has filed marketing/quiet threads to Archive
// recently. The whole point of the feature is trust — "you didn't lose mail" —
// so we surface a running count with a one-tap Review link to the Archived
// view, rather than silently hiding things.
//
// Dismissal is per-day and client-only (sessionStorage keyed by count bucket
// is overkill): we stash the dismissal in localStorage with today's date so
// it stays hidden for the rest of the day but returns tomorrow with the fresh
// count. The count itself is computed server-side (countRecentAutoArchived).

const DISMISS_KEY = "orange-inbox:auto-archive-digest-dismissed";

function todayStamp(): string {
  // Local calendar day. We only need day-granularity bucketing; the exact
  // boundary doesn't matter for a soft reassurance banner.
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export default function AutoArchiveDigest({ count }: { count: number }) {
  // Start hidden; reveal after the mount-time dismissal check so we never
  // flash the banner for a user who already dismissed it today.
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (count <= 0) return;
    let dismissedToday = false;
    try {
      dismissedToday = window.localStorage.getItem(DISMISS_KEY) === todayStamp();
    } catch {
      dismissedToday = false;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!dismissedToday) setShow(true);
  }, [count]);

  if (!show || count <= 0) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(DISMISS_KEY, todayStamp());
    } catch {
      // Private mode / storage disabled — just hide for this render.
    }
    setShow(false);
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2 text-xs border-b border-neutral-200 dark:border-neutral-800 bg-[var(--color-brand)]/5 text-neutral-700 dark:text-neutral-300">
      <span className="flex-1">
        <span className="font-medium">{count}</span>{" "}
        {count === 1 ? "newsletter was" : "newsletters & promotions were"}{" "}
        auto-archived in the last day.
      </span>
      <Link
        href="/inbox/archived"
        className="shrink-0 font-medium text-[var(--color-brand)] hover:underline"
      >
        Review
      </Link>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded px-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
      >
        ✕
      </button>
    </div>
  );
}
