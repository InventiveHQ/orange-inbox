"use client";

import type { DraftListItem } from "@/lib/drafts";
import { htmlToText } from "@/lib/html-text";
import { useCompose } from "./ComposeProvider";
import EmptyState from "./EmptyState";

interface Props {
  drafts: DraftListItem[];
}

// Drafts middle-column list. Clicking a row opens the compose modal pre-filled
// with that draft; the modal carries the draft id so save/send updates the
// existing row instead of creating a duplicate.
export default function DraftsList({ drafts }: Props) {
  const compose = useCompose();

  if (drafts.length === 0) {
    return <EmptyState variant="drafts" />;
  }

  return (
    <ul className="flex-1 overflow-y-auto">
      {drafts.map(d => {
        const to = parseList(d.to_json);
        const cc = parseList(d.cc_json);
        return (
          <li key={d.id}>
            <button
              type="button"
              onClick={() =>
                compose.open({
                  draftId: d.id,
                  preferredMailboxId: d.mailbox_id,
                  toAddrs: to,
                  ccAddrs: cc,
                  subject: d.subject ?? "",
                  bodyPrefill: d.body ?? "",
                })
              }
              className="w-full text-left px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-900"
            >
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate font-medium">
                  {to.length > 0 ? to.join(", ") : <em className="text-neutral-500 not-italic">No recipient</em>}
                </span>
                <span className="shrink-0 text-xs text-neutral-500">
                  {formatDate(d.updated_at)}
                </span>
              </div>
              <div className="text-sm truncate text-neutral-700 dark:text-neutral-300">
                {d.subject || <em className="text-neutral-500 not-italic">(no subject)</em>}
              </div>
              {d.body && (
                <div className="text-xs truncate text-neutral-500">
                  {htmlToText(d.body).slice(0, 200)}
                </div>
              )}
              <div className="text-[10px] uppercase tracking-wider text-neutral-500 mt-0.5">
                from {d.local_part}@{d.domain_name}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function formatDate(unix: number): string {
  const d = new Date(unix * 1000);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
