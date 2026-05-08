"use client";

import Link from "next/link";
import { useState } from "react";
import type { DomainRow, MailboxRow } from "@/lib/queries";
import AddDomainButton from "./AddDomainButton";
import AddMailboxButton from "./AddMailboxButton";
import ComposeButton from "./ComposeButton";
import ManageLabelsButton from "./ManageLabelsButton";
import ManageMailboxButton from "./ManageMailboxButton";
import SearchBar from "./SearchBar";

const COLLAPSED_COOKIE = "sidebar-collapsed";

interface Props {
  domains: DomainRow[];
  mailboxes: MailboxRow[];
  scope: string;
  initialCollapsed?: boolean;
}

export default function Sidebar({ domains, mailboxes, scope, initialCollapsed = false }: Props) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${COLLAPSED_COOKIE}=${next ? "1" : "0"};path=/;max-age=31536000;samesite=lax`;
  }

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
    <aside
      className={`shrink-0 border-r border-neutral-200 dark:border-neutral-800 flex flex-col transition-[width] duration-150 ${
        collapsed ? "w-14" : "w-64"
      }`}
    >
      <div className={`p-3 flex items-center ${collapsed ? "justify-center" : "gap-2"}`}>
        {!collapsed && (
          <>
            <span className="inline-block w-3 h-3 rounded-full bg-[var(--color-brand)]" />
            <span className="font-semibold tracking-tight truncate">orange mail</span>
          </>
        )}
        <button
          type="button"
          onClick={toggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={`${
            collapsed ? "" : "ml-auto"
          } rounded p-1 text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-800`}
        >
          {collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
        </button>
      </div>

      {!collapsed && (
        <div className="px-3 pb-2">
          <SearchBar />
        </div>
      )}

      <div className={`pb-3 ${collapsed ? "px-2" : "px-3"}`}>
        <ComposeButton scope={scope} collapsed={collapsed} />
      </div>

      <nav className={`flex-1 overflow-y-auto pb-2 ${collapsed ? "px-2" : "px-2"}`}>
        {collapsed && (
          <SpecialLink
            href="/search"
            label="Search"
            active={false}
            icon={<SearchIcon />}
            collapsed={collapsed}
          />
        )}
        <SpecialLink
          href="/inbox/all"
          label="All inboxes"
          active={scope === "all"}
          icon={<InboxIcon />}
          collapsed={collapsed}
        />
        <SpecialLink
          href="/inbox/drafts"
          label="Drafts"
          active={scope === "drafts"}
          icon={<DraftIcon />}
          collapsed={collapsed}
        />
        <SpecialLink
          href="/inbox/contacts"
          label="Contacts"
          active={scope === "contacts"}
          icon={<ContactsIcon />}
          collapsed={collapsed}
        />
        <SpecialLink
          href="/inbox/templates"
          label="Templates"
          active={scope === "templates"}
          icon={<TemplatesIcon />}
          collapsed={collapsed}
        />

        {domains.map(d => {
          const list = byDomain.get(d.name) ?? [];
          return (
            <div key={d.id} className="mt-4">
              {collapsed ? (
                <div
                  className="mx-2 mb-1 h-px bg-neutral-200 dark:bg-neutral-800"
                  aria-hidden
                />
              ) : (
                <div className="flex items-center justify-between gap-1 px-3 pb-1 text-xs uppercase tracking-wider text-neutral-500">
                  <span className="truncate">{d.name}</span>
                  {d.is_admin === 1 && (
                    <AddMailboxButton domainId={d.id} domainName={d.name} />
                  )}
                </div>
              )}
              {list.map(mb => (
                <SidebarMailbox
                  key={mb.id}
                  mb={mb}
                  active={scope === mb.id}
                  collapsed={collapsed}
                />
              ))}
            </div>
          );
        })}
      </nav>

      {!collapsed && (
        <div className="p-2 border-t border-neutral-200 dark:border-neutral-800 space-y-1">
          <ManageLabelsButton />
          <AddDomainButton />
        </div>
      )}
    </aside>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.099.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.099Zm-5.242.656a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z" />
    </svg>
  );
}

function SpecialLink({
  href,
  label,
  active,
  icon,
  collapsed,
}: {
  href: string;
  label: string;
  active: boolean;
  icon: React.ReactNode;
  collapsed: boolean;
}) {
  if (collapsed) {
    return (
      <Link
        href={href}
        title={label}
        aria-label={label}
        className={`flex items-center justify-center w-10 h-10 mx-auto my-0.5 rounded-md ${
          active
            ? "bg-[var(--color-brand)]/15 text-[var(--color-brand)]"
            : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900"
        }`}
      >
        {icon}
      </Link>
    );
  }
  return (
    <Link
      href={href}
      className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm ${
        active
          ? "bg-[var(--color-brand)]/15 text-[var(--color-brand)] font-medium"
          : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900"
      }`}
    >
      <span className="truncate">{label}</span>
    </Link>
  );
}

function SidebarMailbox({
  mb,
  active,
  collapsed,
}: {
  mb: MailboxRow;
  active: boolean;
  collapsed: boolean;
}) {
  const fullAddress = `${mb.local_part}@${mb.domain_name}`;
  const label = mb.is_catch_all ? `${mb.local_part}@ (catch-all)` : fullAddress;
  const tooltip = mb.is_catch_all ? `${fullAddress} (catch-all)` : fullAddress;

  if (collapsed) {
    return (
      <Link
        href={`/inbox/${mb.id}`}
        title={tooltip}
        aria-label={label}
        className={`flex items-center justify-center w-10 h-10 mx-auto my-0.5 rounded-md ${
          active ? "bg-[var(--color-brand)]/15" : "hover:bg-neutral-100 dark:hover:bg-neutral-900"
        }`}
      >
        <MailboxAvatar
          localPart={mb.local_part}
          domainName={mb.domain_name}
          active={active}
        />
      </Link>
    );
  }

  return (
    <div className="group flex items-center gap-1">
      <Link
        href={`/inbox/${mb.id}`}
        className={`flex-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm min-w-0 ${
          active
            ? "bg-[var(--color-brand)]/15 text-[var(--color-brand)] font-medium"
            : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900"
        }`}
      >
        <MailboxAvatar
          localPart={mb.local_part}
          domainName={mb.domain_name}
          active={active}
        />
        <span className="truncate flex-1">{label}</span>
        {mb.is_shared === 1 && (
          <span
            title={`${mb.member_count} members`}
            className="ml-1 shrink-0 text-[10px] uppercase tracking-wider text-neutral-500"
          >
            shared
          </span>
        )}
      </Link>
      {mb.role === "owner" && <ManageMailboxButton mailbox={mb} />}
    </div>
  );
}

function MailboxAvatar({
  localPart,
  domainName,
  active,
}: {
  localPart: string;
  domainName: string;
  active: boolean;
}) {
  const initials = ((localPart[0] ?? "?") + (domainName[0] ?? "?")).toUpperCase();
  const palette = colorForDomain(domainName);
  return (
    <span
      aria-hidden
      className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold ${palette} ${
        active ? "ring-1 ring-[var(--color-brand)]" : ""
      }`}
    >
      {initials}
    </span>
  );
}

const AVATAR_PALETTE = [
  "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200",
  "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200",
  "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-200",
  "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200",
  "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-200",
  "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-200",
  "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-200",
];

function colorForDomain(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M10.78 3.22a.75.75 0 0 1 0 1.06L7.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L5.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M5.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L8.94 8 5.22 4.28a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M3 2a1 1 0 0 0-1 1v6h3.07a1 1 0 0 1 .98.81 2 2 0 0 0 3.9 0 1 1 0 0 1 .98-.81H14V3a1 1 0 0 0-1-1H3Zm-1 8v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3h-2.18a3.5 3.5 0 0 1-5.64 0H2Z" />
    </svg>
  );
}

function DraftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M11.06 1.94a1.5 1.5 0 0 1 2.12 0l.88.88a1.5 1.5 0 0 1 0 2.12l-7.94 7.94a2 2 0 0 1-.88.5l-2.62.7a.5.5 0 0 1-.62-.62l.7-2.62a2 2 0 0 1 .5-.88l7.86-7.94Z" />
    </svg>
  );
}

function ContactsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M5.5 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm5.25-.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM2 13c0-1.93 1.57-3.5 3.5-3.5S9 11.07 9 13v.5H2V13Zm8 .5V13c0-1-.27-1.94-.74-2.74A4.7 4.7 0 0 1 10.75 10c1.79 0 3.25 1.46 3.25 3.25v.25H10Z" />
    </svg>
  );
}

function TemplatesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M5 1.5A1.5 1.5 0 0 1 6.5 0h6A1.5 1.5 0 0 1 14 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 5 9.5v-8Zm-2.5 3a.5.5 0 0 1 .5.5v9.5h7.5a.5.5 0 0 1 0 1H3a1 1 0 0 1-1-1V5a.5.5 0 0 1 .5-.5Z" />
    </svg>
  );
}
