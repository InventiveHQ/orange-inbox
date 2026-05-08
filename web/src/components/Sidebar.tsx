import Link from "next/link";
import type { DomainRow, MailboxRow } from "@/lib/queries";
import AddDomainButton from "./AddDomainButton";
import AddMailboxButton from "./AddMailboxButton";
import ComposeButton from "./ComposeButton";
import ManageMailboxButton from "./ManageMailboxButton";

interface Props {
  domains: DomainRow[];
  mailboxes: MailboxRow[];
  scope: string;
}

export default function Sidebar({ domains, mailboxes, scope }: Props) {
  // Group mailboxes by domain. Iterating `domains` (not the mailbox map) so a
  // domain you administer but have no mailboxes in still appears with a "+"
  // button, instead of disappearing from the sidebar.
  const byDomain = new Map<string, MailboxRow[]>();
  for (const mb of mailboxes) {
    const list = byDomain.get(mb.domain_name) ?? [];
    list.push(mb);
    byDomain.set(mb.domain_name, list);
  }

  return (
    <aside className="w-64 shrink-0 border-r border-neutral-200 dark:border-neutral-800 flex flex-col">
      <div className="p-4 flex items-center gap-2">
        <span className="inline-block w-3 h-3 rounded-full bg-[var(--color-brand)]" />
        <span className="font-semibold tracking-tight">orange-inbox</span>
      </div>

      <div className="px-3 pb-3">
        <ComposeButton scope={scope} />
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        <SidebarLink href="/inbox/all" label="All inboxes" active={scope === "all"} />

        {domains.map(d => {
          const list = byDomain.get(d.name) ?? [];
          return (
            <div key={d.id} className="mt-4">
              <div className="flex items-center justify-between gap-1 px-3 pb-1 text-xs uppercase tracking-wider text-neutral-500">
                <span className="truncate">{d.name}</span>
                {d.is_admin === 1 && <AddMailboxButton domainId={d.id} domainName={d.name} />}
              </div>
              {list.map(mb => (
                <SidebarMailbox key={mb.id} mb={mb} active={scope === mb.id} />
              ))}
            </div>
          );
        })}
      </nav>

      <div className="p-2 border-t border-neutral-200 dark:border-neutral-800">
        <AddDomainButton />
      </div>
    </aside>
  );
}

function SidebarLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center justify-between rounded-md px-3 py-1.5 text-sm ${
        active
          ? "bg-[var(--color-brand)]/15 text-[var(--color-brand)] font-medium"
          : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900"
      }`}
    >
      <span className="truncate">{label}</span>
    </Link>
  );
}

function SidebarMailbox({ mb, active }: { mb: MailboxRow; active: boolean }) {
  const label = mb.is_catch_all
    ? `${mb.local_part}@ (catch-all)`
    : `${mb.local_part}@${mb.domain_name}`;
  return (
    <div className="group flex items-center gap-1">
      <Link
        href={`/inbox/${mb.id}`}
        className={`flex-1 flex items-center justify-between rounded-md px-3 py-1.5 text-sm min-w-0 ${
          active
            ? "bg-[var(--color-brand)]/15 text-[var(--color-brand)] font-medium"
            : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900"
        }`}
      >
        <span className="truncate">{label}</span>
        {mb.is_shared === 1 && (
          <span
            title={`${mb.member_count} members`}
            className="ml-2 shrink-0 text-[10px] uppercase tracking-wider text-neutral-500"
          >
            shared
          </span>
        )}
      </Link>
      {mb.role === "owner" && <ManageMailboxButton mailboxId={mb.id} mailboxLabel={label} />}
    </div>
  );
}
