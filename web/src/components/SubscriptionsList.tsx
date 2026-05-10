"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SubscriptionRow } from "@/lib/queries";
import { formatFullDate } from "@/lib/format";

interface Props {
  subscriptions: SubscriptionRow[];
}

// Aggregated newsletter sender list. One row per (mailbox, sender). The
// "Unsubscribe + archive" button POSTs to the per-message unsubscribe API
// with `bulk=1`, targeting the most recent message that still has an
// actionable unsubscribe header — that drives the unsub action AND
// archives every thread from that sender (see
// `bulkUnsubscribeAndArchiveSender` in `lib/list-unsubscribe`).
export default function SubscriptionsList({ subscriptions }: Props) {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-4 py-4 sm:px-6 border-b border-neutral-200 dark:border-neutral-800">
        <div>
          <h1 className="text-base font-semibold">Subscriptions</h1>
          <p className="text-xs text-neutral-500 mt-0.5">
            Senders that advertised an unsubscribe header. One-click where
            available; otherwise we&apos;ll open the sender&apos;s unsubscribe
            page or send a no-op email on your behalf.
          </p>
        </div>
      </header>

      {subscriptions.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-neutral-500 px-6 text-center">
          No mailing-list senders detected yet. Newsletters that include the
          standard List-Unsubscribe header will appear here.
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto divide-y divide-neutral-200 dark:divide-neutral-800">
          {subscriptions.map(s => (
            <SubscriptionRowItem key={`${s.mailbox_id}|${s.from_addr}`} row={s} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SubscriptionRowItem({ row }: { row: SubscriptionRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // We mirror `unsubscribed_count` locally so a successful bulk action
  // immediately flips the chip without waiting on the server round-trip
  // in router.refresh().
  const [unsubbed, setUnsubbed] = useState(
    row.unsubscribed_count >= row.message_count,
  );
  const allDone = unsubbed || !row.latest_actionable_message_id;

  const senderLabel = row.from_name?.trim() || row.from_addr;

  function onClick() {
    if (!row.latest_actionable_message_id) return;
    if (
      !confirm(
        `Unsubscribe from ${row.from_addr} and archive ${row.message_count} message${row.message_count === 1 ? "" : "s"}?`,
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await fetch(
        `/api/messages/${row.latest_actionable_message_id}/unsubscribe?bulk=1`,
        { method: "POST" },
      );
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
        // Sender doesn't support one-click — open the destination page so
        // the user can complete the flow there. The bulk archive HAS still
        // happened server-side; we show a hint and refresh.
        window.open(body.url, "_blank", "noopener,noreferrer");
      }
      setUnsubbed(true);
      router.refresh();
    });
  }

  return (
    <li className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3 sm:px-6 hover:bg-neutral-50 dark:hover:bg-neutral-900/40">
      <div className="min-w-0">
        <div className="font-medium truncate">{senderLabel}</div>
        <div className="text-xs text-neutral-500 truncate">
          {row.from_name && row.from_name.trim() ? `<${row.from_addr}> · ` : ""}
          {row.mailbox_local_part}@{row.domain_name}
        </div>
        <div className="text-xs text-neutral-500 mt-0.5">
          {row.message_count} message{row.message_count === 1 ? "" : "s"} · last{" "}
          {formatFullDate(row.last_message_at)}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {error && (
          <span role="alert" className="text-xs text-red-700 dark:text-red-400">
            {error}
          </span>
        )}
        {allDone ? (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:text-emerald-300"
            title="Unsubscribed"
          >
            Unsubscribed
          </span>
        ) : (
          <button
            type="button"
            onClick={onClick}
            disabled={pending}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-1.5 text-xs font-medium hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
          >
            {pending ? "Unsubscribing…" : "Unsubscribe + archive"}
          </button>
        )}
      </div>
    </li>
  );
}
