"use client";

import Link from "next/link";
import { useState } from "react";
import type { DomainRow, MailboxRow } from "@/lib/queries";
import AddMailboxButton from "./AddMailboxButton";
import Avatar from "./Avatar";
import CapacityIndicator from "./CapacityIndicator";
import ComposeButton from "./ComposeButton";
import ManageMailboxButton from "./ManageMailboxButton";

const COLLAPSED_COOKIE = "sidebar-collapsed";

interface Props {
  domains: DomainRow[];
  mailboxes: MailboxRow[];
  scope: string;
  initialCollapsed?: boolean;
  isAdmin: boolean;
}

export default function Sidebar({ domains, mailboxes, scope, initialCollapsed = false, isAdmin }: Props) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${COLLAPSED_COOKIE}=${next ? "1" : "0"};path=/;max-age=31536000;samesite=lax`;
  }

  // Group mailboxes by domain. Iterating `domains` (not the mailbox map) so a
  // domain with no accessible mailboxes still appears (admins use the "+" to
  // create one).
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
            <span className="font-semibold tracking-tight truncate">orange inbox</span>
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

      <div className={`pb-3 ${collapsed ? "px-2" : "px-3"}`}>
        <ComposeButton scope={scope} collapsed={collapsed} />
      </div>

      <nav className={`flex-1 overflow-y-auto pb-2 ${collapsed ? "px-2" : "px-2"}`}>
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
        <SpecialLink
          href="/scheduled"
          label="Scheduled"
          active={false}
          icon={<ScheduledIcon />}
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
                  {isAdmin && (
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
                  isAdmin={isAdmin}
                />
              ))}
            </div>
          );
        })}
      </nav>

      <div className="border-t border-neutral-200 dark:border-neutral-800">
        <CapacityIndicator collapsed={collapsed} />
      </div>

      {/*
        Settings + Help sit at the bottom of the drawer — common Gmail/Slack
        pattern, and an out-of-the-way home for things you only touch
        occasionally (mailbox access, signatures, labels, domains, install
        instructions).
      */}
      <div className="border-t border-neutral-200 dark:border-neutral-800 p-2 space-y-0.5">
        <BottomLink
          href="/inbox/settings"
          label="Settings"
          active={scope === "settings"}
          icon={<SettingsIcon />}
          collapsed={collapsed}
        />
        <BottomLink
          href="/inbox/help"
          label="Help"
          active={scope === "help"}
          icon={<HelpIcon />}
          collapsed={collapsed}
        />
      </div>
    </aside>
  );
}

function BottomLink({
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
        className={`flex items-center justify-center w-10 h-10 mx-auto rounded-md ${
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
      {icon}
      <span className="truncate">{label}</span>
    </Link>
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
  isAdmin,
}: {
  mb: MailboxRow;
  active: boolean;
  collapsed: boolean;
  isAdmin: boolean;
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
      {isAdmin && <ManageMailboxButton mailbox={mb} />}
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
  // Domain seeds the color (so all mailboxes on the same domain share a tint),
  // initials show local+domain letters.
  const initials = ((localPart[0] ?? "?") + (domainName[0] ?? "?")).toUpperCase();
  return <Avatar seed={domainName} label={initials} size="sm" ringed={active} />;
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

function ScheduledIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm.75 3.5v3.69l2.53 1.46a.75.75 0 1 1-.75 1.3L7.625 9.16A.75.75 0 0 1 7.25 8.5v-4a.75.75 0 0 1 1.5 0Z" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm.05 11.25a.95.95 0 1 1 0-1.9.95.95 0 0 1 0 1.9Zm1.6-4.41c-.59.36-.85.61-.85 1.06v.35a.75.75 0 0 1-1.5 0v-.35c0-1.18.78-1.79 1.42-2.18.55-.34.83-.6.83-1.07 0-.66-.55-1.15-1.32-1.15-.86 0-1.27.49-1.5 1.06a.75.75 0 1 1-1.39-.56C5.62 4.18 6.55 3 8.23 3c1.6 0 2.82 1.06 2.82 2.65 0 1.18-.78 1.79-1.4 2.19Z" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M9.405 1.05a.75.75 0 0 0-.81 0l-.97.583a.75.75 0 0 1-.69.045l-1.05-.45a.75.75 0 0 0-.79.146l-.834.835a.75.75 0 0 1-.598.218l-1.13-.084a.75.75 0 0 0-.79.554l-.314 1.087a.75.75 0 0 1-.45.5l-1.04.42a.75.75 0 0 0-.45.79l.187 1.115a.75.75 0 0 1-.146.62l-.69.89a.75.75 0 0 0 0 .91l.69.89a.75.75 0 0 1 .146.62l-.187 1.115a.75.75 0 0 0 .45.79l1.04.42a.75.75 0 0 1 .45.5l.314 1.087a.75.75 0 0 0 .79.554l1.13-.084a.75.75 0 0 1 .598.218l.834.835a.75.75 0 0 0 .79.146l1.05-.45a.75.75 0 0 1 .69.045l.97.583a.75.75 0 0 0 .81 0l.97-.583a.75.75 0 0 1 .69-.045l1.05.45a.75.75 0 0 0 .79-.146l.834-.835a.75.75 0 0 1 .598-.218l1.13.084a.75.75 0 0 0 .79-.554l.314-1.087a.75.75 0 0 1 .45-.5l1.04-.42a.75.75 0 0 0 .45-.79l-.187-1.115a.75.75 0 0 1 .146-.62l.69-.89a.75.75 0 0 0 0-.91l-.69-.89a.75.75 0 0 1-.146-.62l.187-1.115a.75.75 0 0 0-.45-.79l-1.04-.42a.75.75 0 0 1-.45-.5l-.314-1.087a.75.75 0 0 0-.79-.554l-1.13.084a.75.75 0 0 1-.598-.218l-.834-.835a.75.75 0 0 0-.79-.146l-1.05.45a.75.75 0 0 1-.69-.045l-.97-.583ZM8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z" />
    </svg>
  );
}
