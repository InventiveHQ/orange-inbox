import Link from "next/link";
import type { DomainRow } from "@/lib/queries";
import AddDomainButton from "./AddDomainButton";

interface Props {
  domains: DomainRow[];
  scope: string;
}

export default function Sidebar({ domains, scope }: Props) {
  return (
    <aside className="w-60 shrink-0 border-r border-neutral-200 dark:border-neutral-800 flex flex-col">
      <div className="p-4 flex items-center gap-2">
        <span className="inline-block w-3 h-3 rounded-full bg-[var(--color-brand)]" />
        <span className="font-semibold tracking-tight">orange-inbox</span>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        <SidebarLink href="/inbox/all" label="All inboxes" active={scope === "all"} />
        {domains.length > 0 && (
          <div className="mt-4 mb-1 px-3 text-xs uppercase tracking-wider text-neutral-500">
            Mail domains
          </div>
        )}
        {domains.map(d => (
          <SidebarLink
            key={d.id}
            href={`/inbox/${encodeURIComponent(d.name)}`}
            label={d.name}
            active={scope === d.name}
            secondary={d.role === "admin" ? undefined : d.role}
          />
        ))}
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
  secondary,
}: {
  href: string;
  label: string;
  active: boolean;
  secondary?: string;
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
      {secondary && <span className="text-[10px] uppercase text-neutral-500">{secondary}</span>}
    </Link>
  );
}
