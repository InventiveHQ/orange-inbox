"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

// Per-message Unsubscribe chip rendered in the message header. Server-side
// renders only when the message advertises a mechanism (RFC 2369 URL or
// mailto) and hasn't already been unsubscribed; flips to "Unsubscribed"
// once `unsubscribed_at` is stamped.
//
// On click:
//   - one-click branch (server-decided) → POST to /api/.../unsubscribe and
//     show a "Unsubscribed" pill on success.
//   - "open" branch (no one-click) → server returns the URL; we open in a
//     new tab. We *don't* stamp unsubscribed_at — the destination owns
//     confirmation.
interface Props {
  messageId: string;
  // Snapshot of the row at render time. The component re-fetches /
  // re-navigates after a successful POST so server state catches up; this
  // is just the initial state the server tells us.
  alreadyUnsubscribed: boolean;
}

export default function UnsubscribeButton({
  messageId,
  alreadyUnsubscribed,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(alreadyUnsubscribed);

  if (done) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:text-emerald-300"
        title="You've unsubscribed from this sender"
      >
        Unsubscribed
      </span>
    );
  }

  function onClick() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/messages/${messageId}/unsubscribe`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        status?: string;
        url?: string;
        error?: string;
        message?: string;
      };
      if (!res.ok || !body.ok) {
        setError(body.message || body.error || `Failed (${res.status})`);
        return;
      }
      if (body.status === "open" && body.url) {
        // Hand off to the destination page; don't flip our state — the
        // remote owns confirmation, and the next time the user opens
        // this message we'll just show the chip again unless they
        // confirm via the bulk Subscriptions flow.
        window.open(body.url, "_blank", "noopener,noreferrer");
        return;
      }
      setDone(true);
      router.refresh();
    });
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        title="Unsubscribe from this sender"
        className="inline-flex items-center gap-1 rounded-full border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-0.5 text-[11px] font-medium text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
      >
        {pending ? "Unsubscribing…" : "Unsubscribe"}
      </button>
      {error && (
        <span
          role="alert"
          className="text-[11px] text-red-700 dark:text-red-400"
        >
          {error}
        </span>
      )}
    </span>
  );
}
