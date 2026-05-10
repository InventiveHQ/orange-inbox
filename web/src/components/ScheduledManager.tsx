import { requireUser } from "@/lib/auth";
import { listScheduledForUser } from "@/lib/scheduled";
import { formatFullDate } from "@/lib/format";
import CancelScheduledButton from "./CancelScheduledButton";

// Scheduled-sends view, rendered inside the inbox shell (sidebar + topbar
// stay visible). The standalone /scheduled route still works for
// deep-links / older bookmarks; this is the in-app entry from the
// sidebar.
export default async function ScheduledManager() {
  const user = await requireUser();
  const items = await listScheduledForUser(user.id, { includeFinal: true });
  const pending = items.filter(i => i.status === "pending");
  const finished = items.filter(i => i.status !== "pending");

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="px-4 py-4 sm:px-6 border-b border-neutral-200 dark:border-neutral-800">
        <h1 className="text-base font-semibold">Scheduled</h1>
        <p className="mt-1 text-xs text-neutral-500">
          Messages queued to go out later. The cron dispatcher runs every minute.
        </p>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 space-y-8">
          <Section title={`Pending (${pending.length})`} empty="No scheduled sends.">
            {pending.map(item => (
              <li
                key={item.id}
                className="flex items-start justify-between gap-3 rounded-md border border-neutral-200 dark:border-neutral-800 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">
                    {item.subject || "(no subject)"}
                  </div>
                  <div className="text-xs text-neutral-500 truncate">
                    to {item.to_summary || "—"} · sends at {formatFullDate(item.scheduled_for)}
                  </div>
                </div>
                <CancelScheduledButton id={item.id} />
              </li>
            ))}
          </Section>

          <Section title={`History (${finished.length})`} empty="No finalised scheduled sends yet.">
            {finished.map(item => (
              <li
                key={item.id}
                className="flex items-start justify-between gap-3 rounded-md border border-neutral-200 dark:border-neutral-800 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">
                    {item.subject || "(no subject)"}
                  </div>
                  <div className="text-xs text-neutral-500 truncate">
                    to {item.to_summary || "—"} · scheduled for {formatFullDate(item.scheduled_for)}
                  </div>
                  {item.error_message && (
                    <div className="text-xs text-red-600 truncate">{item.error_message}</div>
                  )}
                </div>
                <span
                  className={`shrink-0 text-xs uppercase tracking-wider ${
                    item.status === "sent"
                      ? "text-emerald-600"
                      : item.status === "cancelled"
                        ? "text-neutral-500"
                        : "text-red-600"
                  }`}
                >
                  {item.status}
                </span>
              </li>
            ))}
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  const hasItems = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <section>
      <h2 className="text-xs uppercase tracking-wider text-neutral-500 mb-2">{title}</h2>
      {hasItems ? (
        <ul className="space-y-2">{children}</ul>
      ) : (
        <div className="text-sm text-neutral-500">{empty}</div>
      )}
    </section>
  );
}
