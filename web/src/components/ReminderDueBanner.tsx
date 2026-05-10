"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

interface Props {
  threadId: string;
  remindAt: number;
}

// Banner rendered at the top of a thread when its reminder timestamp has
// elapsed (server-side check in ThreadView). The user can either dismiss
// (clears remind_at) or snooze for an hour.
//
// TODO: cron should also clear remind_at when the user replies to the
// thread — that mutation lives in the email-worker / reply path and is
// out of scope for the UI patch.
export default function ReminderDueBanner({ threadId, remindAt }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function clear() {
    startTransition(async () => {
      await fetch(`/api/threads/${threadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ remind_at: null }),
      });
      router.refresh();
    });
  }

  function snoozeAnHour() {
    const next = Math.floor(Date.now() / 1000) + 60 * 60;
    startTransition(async () => {
      await fetch(`/api/threads/${threadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ remind_at: next }),
      });
      router.refresh();
    });
  }

  const when = new Date(remindAt * 1000).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-sky-200 dark:border-sky-900 bg-sky-50 dark:bg-sky-950/40 px-4 py-2 sm:px-6 text-sm text-sky-800 dark:text-sky-200"
    >
      <div>
        <span className="font-medium">Reminder due</span>
        <span className="ml-2 text-xs text-sky-700 dark:text-sky-300">set for {when}</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={snoozeAnHour}
          disabled={isPending}
          className="rounded border border-sky-300 dark:border-sky-700 px-2 py-1 text-xs font-medium hover:bg-sky-100 dark:hover:bg-sky-900/60 disabled:opacity-50"
        >
          Remind in 1h
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={isPending}
          className="rounded bg-sky-700 dark:bg-sky-600 px-2 py-1 text-xs font-medium text-white hover:bg-sky-800 disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
