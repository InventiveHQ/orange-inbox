import Link from "next/link";
import type { ThreadListItem } from "@/lib/queries";
import { formatThreadDate, senderLabel } from "@/lib/format";

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
              <div className="flex items-baseline gap-2">
                <span
                  className={`truncate flex-1 text-sm ${
                    isUnread ? "font-semibold text-neutral-900 dark:text-neutral-100" : "text-neutral-700 dark:text-neutral-300"
                  }`}
                >
                  {sender}
                </span>
                <span className="shrink-0 text-xs text-neutral-500">{formatThreadDate(t.last_message_at)}</span>
              </div>
              <div className={`truncate text-sm ${isUnread ? "font-medium" : "text-neutral-700 dark:text-neutral-300"}`}>
                {subject}
                {t.message_count > 1 && (
                  <span className="ml-1 text-xs text-neutral-500">({t.message_count})</span>
                )}
              </div>
              <div className="truncate text-xs text-neutral-500">{t.last_snippet || ""}</div>
              {showDomain && (
                <div className="mt-1 text-[10px] uppercase tracking-wider text-neutral-400">
                  {t.domain_name}
                </div>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
