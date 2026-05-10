"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ResolvedAssignmentItem } from "@/lib/assignments";
import { formatRelativeTime, formatThreadDate, senderLabel } from "@/lib/format";
import Avatar from "./Avatar";
import EmptyState from "./EmptyState";
import LabelChip from "./LabelChip";
import { useToast } from "./ToastProvider";

interface Props {
  items: ResolvedAssignmentItem[];
}

// Resolved-history list (#99). Renders past assignments that the current
// user was the assignee on, with strikethrough/muted styling so the row is
// visually distinct from the active list, plus a "Resolved by … N ago"
// annotation and an inline Reopen button.
//
// Kept as a separate component (rather than a flag on ThreadList) because:
//   - the row affordances are different (Reopen button instead of swipe-to-
//     archive / checkbox bulk-select)
//   - the resolved view doesn't need the date-bucket section dividers,
//     scroll memory, or category strip ThreadList layers in
//   - a flag-laden ThreadList was already getting unwieldy; a tight 100-line
//     resolved variant is easier to reason about than the alternative

export default function ResolvedAssignmentsList({ items }: Props) {
  if (items.length === 0) {
    return (
      <EmptyState
        variant="inbox"
        title="No resolved assignments"
        body="Threads you've assigned to yourself and resolved show up here. Resolve one from /inbox/assigned to see it land in the history."
      />
    );
  }
  return (
    <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
      {items.map(item => (
        <ResolvedRow key={item.id} item={item} />
      ))}
    </ul>
  );
}

function ResolvedRow({ item }: { item: ResolvedAssignmentItem }) {
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [reopened, setReopened] = useState(false);

  const sender = senderLabel(item.last_from_addr, item.last_from_name);
  const subject = item.last_subject || item.subject_normalized || "(no subject)";
  const resolvedByName =
    item.resolved_by_display_name?.trim() ||
    item.resolved_by_email?.trim() ||
    (item.resolved_by_id ? "someone" : "deleted user");

  async function onReopen(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (isPending || reopened) return;
    try {
      const res = await fetch(`/api/threads/${encodeURIComponent(item.id)}/assignment/resolve`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast({ message: `Reopen failed: ${body.error ?? res.statusText}` });
        return;
      }
      // Optimistically grey the row — the next router.refresh() will drop it
      // from the list since `?status=resolved` filters on resolved_at NOT NULL.
      setReopened(true);
      toast({ message: "Assignment reopened" });
      // router.refresh() needs to be inside a transition so React doesn't
      // suspend the row mid-fetch.
      startTransition(() => router.refresh());
    } catch (err) {
      console.error(err);
      toast({ message: "Reopen failed: network error" });
    }
  }

  // Muted styling: lighter text, strikethrough on subject. The link stays
  // clickable so the user can still pop into the thread to read context.
  return (
    <li
      className={`relative ${reopened ? "opacity-40 pointer-events-none" : "opacity-75"}`}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <Link
          href={`/inbox/assigned/${item.id}`}
          className="flex-1 min-w-0 block hover:bg-neutral-100 dark:hover:bg-neutral-900 rounded-md px-1 py-1 -mx-1 -my-1"
        >
          <div className="flex items-start gap-3">
            <Avatar seed={item.last_from_addr ?? sender} label={sender} size="md" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate flex-1 text-sm text-neutral-500 dark:text-neutral-400">
                  {sender}
                </span>
                <span className="shrink-0 text-xs text-neutral-400 dark:text-neutral-500">
                  {formatThreadDate(item.last_message_at)}
                </span>
              </div>
              <div className="flex items-center gap-1.5 min-w-0 text-sm text-neutral-500 dark:text-neutral-400 line-through">
                {item.labels.length > 0 && (
                  <span className="flex items-center gap-1 shrink-0 no-underline">
                    {item.labels.map(l => (
                      <LabelChip key={l.id} name={l.name} color={l.color} />
                    ))}
                  </span>
                )}
                <span className="truncate min-w-0">
                  {subject}
                  {item.message_count > 1 && (
                    <span className="ml-1 text-xs">({item.message_count})</span>
                  )}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
                <span>
                  Resolved by{" "}
                  <span className="font-medium text-neutral-600 dark:text-neutral-300">
                    {resolvedByName}
                  </span>{" "}
                  {formatRelativeTime(item.resolved_at)}
                </span>
                <span className="text-[10px] uppercase tracking-wider text-neutral-400">
                  {item.mailbox_local_part}@{item.domain_name}
                </span>
              </div>
            </div>
          </div>
        </Link>
        <button
          type="button"
          onClick={onReopen}
          disabled={isPending || reopened}
          className="shrink-0 self-center rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1 text-xs font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
          aria-label={`Reopen assignment for ${subject}`}
        >
          {reopened ? "Reopened" : isPending ? "Reopening…" : "Reopen"}
        </button>
      </div>
    </li>
  );
}
