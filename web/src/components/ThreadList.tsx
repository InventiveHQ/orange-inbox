import Link from "next/link";
import type { ThreadListItem } from "@/lib/queries";
import { formatThreadDate, senderLabel } from "@/lib/format";
import Avatar from "./Avatar";
import LabelChip from "./LabelChip";

interface Props {
  threads: ThreadListItem[];
  scope: string;
  activeThreadId?: string;
  showDomain: boolean;
}

export default function ThreadList({ threads, scope, activeThreadId, showDomain }: Props) {
  if (threads.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-neutral-500 px-6 text-center">
        No mail in this view yet. New messages appear here as they arrive.
      </div>
    );
  }

  return (
    <ul className="flex-1 overflow-y-auto divide-y divide-neutral-200 dark:divide-neutral-800">
      {threads.map(t => {
        const sender = senderLabel(t.last_from_addr, t.last_from_name);
        const subject = t.last_subject || "(no subject)";
        const isUnread = t.unread_count > 0;
        const isActive = activeThreadId === t.id;
        // Seed color on the address (stable) but show first letter of the
        // display label (what the user actually sees in the row).
        const avatarSeed = t.last_from_addr || sender;
        return (
          <li key={t.id}>
            <Link
              href={`/inbox/${encodeURIComponent(scope)}/${t.id}`}
              className={`block px-4 py-3 transition-colors ${
                isActive
                  ? "bg-[var(--color-brand)]/10"
                  : "hover:bg-neutral-100 dark:hover:bg-neutral-900"
              }`}
            >
              <div className="flex items-start gap-3">
                <Avatar seed={avatarSeed} label={sender} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span
                      className={`truncate flex-1 text-sm ${
                        isUnread ? "font-semibold text-neutral-900 dark:text-neutral-100" : "text-neutral-700 dark:text-neutral-300"
                      }`}
                    >
                      {sender}
                    </span>
                    {t.starred === 1 && (
                      <span
                        className="shrink-0 text-xs text-yellow-500"
                        aria-label="Starred"
                        title="Starred"
                      >
                        ★
                      </span>
                    )}
                    <span className="shrink-0 text-xs text-neutral-500">{formatThreadDate(t.last_message_at)}</span>
                  </div>
                  <div className={`flex items-center gap-1.5 min-w-0 text-sm ${isUnread ? "font-medium" : "text-neutral-700 dark:text-neutral-300"}`}>
                    {t.labels.length > 0 && (
                      <span className="flex items-center gap-1 shrink-0">
                        {t.labels.map(l => (
                          <LabelChip key={l.id} name={l.name} color={l.color} />
                        ))}
                      </span>
                    )}
                    <span className="truncate min-w-0">
                      {subject}
                      {t.message_count > 1 && (
                        <span className="ml-1 text-xs text-neutral-500">({t.message_count})</span>
                      )}
                    </span>
                  </div>
                  <div className="truncate text-xs text-neutral-500">{t.last_snippet || ""}</div>
                  {showDomain && (
                    <div className="mt-1 text-[10px] uppercase tracking-wider text-neutral-400">
                      {t.domain_name}
                    </div>
                  )}
                </div>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
