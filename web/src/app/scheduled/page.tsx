import { getCurrentUser } from "@/lib/auth";
import { listScheduledForUser } from "@/lib/scheduled";
import { formatFullDate } from "@/lib/format";
import CancelScheduledButton from "@/components/CancelScheduledButton";
import Link from "next/link";

export default async function ScheduledPage() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-neutral-500">
        Sign-in required.
      </div>
    );
  }

  const items = await listScheduledForUser(user.id, { includeFinal: true });
  const pending = items.filter(i => i.status === "pending");
  const finished = items.filter(i => i.status !== "pending");

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      <header className="border-b border-neutral-200 dark:border-neutral-800 px-6 py-4 flex items-center justify-between">
        <div>
          <Link
            href="/inbox/all"
            className="text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            ← All inboxes
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Scheduled</h1>
          <p className="text-sm text-neutral-500">
            Messages queued to go out later. The cron dispatcher runs every minute.
          </p>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-6 space-y-8">
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
      </main>
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
