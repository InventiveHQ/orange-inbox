"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { DomainRow, MailboxRow } from "@/lib/queries";
import type { SavedSearchRow } from "@/lib/saved-searches";
import type { InboxLayoutRow } from "@/lib/inbox-layouts";
import Avatar from "./Avatar";
import ComposeButton from "./ComposeButton";

const COLLAPSED_COOKIE = "sidebar-collapsed";
const SMART_MAILBOXES_COOKIE = "smart-mailboxes-open";
const LAYOUTS_OPEN_COOKIE = "inbox-layouts-open";
const DOMAIN_EXPANDED_PREFIX = "sidebar-domain-expanded:";

// Read the persisted collapse state from the cookie on the client.
// Navigating to /inbox/calendar or /inbox/contacts swaps the layout's
// SectionDrawerWrap between a Fragment and a context Provider, which
// changes the element type above this component and forces React to
// remount it. A plain useState(initialCollapsed) would then reset from
// the layout's *cached* RSC prop (captured at first load, before the
// user collapsed the rail) and the drawer would spring back open. By
// seeding from the live cookie we keep the user's choice across that
// remount. Returns null during SSR (no document) so the initializer
// falls back to the server-provided prop and hydration stays stable.
function readCollapsedCookie(): boolean | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${COLLAPSED_COOKIE}=([^;]*)`),
  );
  return match ? match[1] === "1" : null;
}

// MIME types used by the native HTML5 DnD payload. We carry only an opaque
// id string; the actual reorder logic reads it from React state, not from
// the DataTransfer object (the browser strips data on dragover in some
// engines). The MIME type tag is namespaced so we can ignore drops that
// originated outside the sidebar.
const DRAG_MIME_DOMAIN = "application/x-orange-domain-id";
const DRAG_MIME_MAILBOX = "application/x-orange-mailbox-id";

// Public shape of the drag-handlers bundle produced by useRowDrag, passed
// into row components so the row's <Link>/<div> can attach them. We type
// the event handlers loosely (HTMLElement) because they're shared across
// <Link>, <div>, and child elements with different concrete event types.
type RowDragHandler = (e: React.DragEvent<HTMLElement>) => void;
interface RowDrag {
  onDragStart: RowDragHandler;
  onDragOver: RowDragHandler;
  onDragLeave: RowDragHandler;
  onDrop: RowDragHandler;
  onDragEnd: RowDragHandler;
  // Tailwind classes for the row's visual state: "" most of the time,
  // "opacity-40" while this row is the one being dragged, or
  // "outline outline-2 outline-[var(--color-brand)]" while a compatible
  // drag is hovering over it.
  dragClass: string;
}

// Shared HTML5 DnD plumbing for both "drag a whole domain entry at the
// top level" and "drag a child mailbox within its expanded group".
//
// Each row has one of two `kind`s ("domain" or "mailbox") which doubles as
// a drop-compatibility filter — drops only fire when the dragged row's
// kind matches the drop target's kind. That stops users from accidentally
// dragging an alias out from under its domain header (which the data
// model doesn't support), and stops a domain row from landing inside
// another domain's child list.
//
// The DataTransfer payload also carries the row id, but we keep a
// matching React state copy because Safari and some Chromium versions
// strip the payload during `dragover` (only `drop` can read it). Without
// the React-side cache, we couldn't decide compatibility on hover, which
// in turn would break the drop-indicator highlight.
function useRowDrag(
  kind: "domain" | "mailbox",
  id: string,
  onMove: (fromId: string, toId: string) => void,
): RowDrag {
  const [isDragging, setIsDragging] = useState(false);
  const [isOver, setIsOver] = useState(false);
  const mime = kind === "domain" ? DRAG_MIME_DOMAIN : DRAG_MIME_MAILBOX;

  const onDragStart: RowDragHandler = e => {
    e.dataTransfer.setData(mime, id);
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
    // Stop the event from bubbling to an ancestor row (a child mailbox
    // sits inside an ExpandableDomainGroup which is itself draggable).
    // Without this, dragging an alias would pick up the whole domain.
    e.stopPropagation();
    setIsDragging(true);
  };

  const onDragOver: RowDragHandler = e => {
    // Reject drops from a different kind (mailbox vs domain). Without
    // this check, dropping a domain row onto a child mailbox would
    // silently no-op and look like a UI bug.
    if (!e.dataTransfer.types.includes(mime)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    e.stopPropagation();
    if (!isOver) setIsOver(true);
  };

  const onDragLeave: RowDragHandler = () => {
    if (isOver) setIsOver(false);
  };

  const onDrop: RowDragHandler = e => {
    if (!e.dataTransfer.types.includes(mime)) return;
    e.preventDefault();
    e.stopPropagation();
    const fromId = e.dataTransfer.getData(mime);
    setIsOver(false);
    if (fromId && fromId !== id) {
      onMove(fromId, id);
    }
  };

  const onDragEnd: RowDragHandler = () => {
    setIsDragging(false);
    setIsOver(false);
  };

  // Ghost the dragged row, outline the drop target. The outline is
  // applied at the wrapper level (not on the inner Link) so it works
  // for both the row-as-<Link> case and the group-as-<div> case.
  const dragClass = isDragging
    ? "opacity-40"
    : isOver
      ? "outline outline-2 -outline-offset-2 outline-[var(--color-brand)] rounded-md"
      : "";

  return { onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd, dragClass };
}

interface Props {
  domains: DomainRow[];
  mailboxes: MailboxRow[];
  scope: string;
  initialCollapsed?: boolean;
  isAdmin: boolean;
  savedSearches?: SavedSearchRow[];
  inboxLayouts?: InboxLayoutRow[];
  initialSmartOpen?: boolean;
  initialLayoutsOpen?: boolean;
  // "Assigned to me" badge (#27). Optional so existing call sites stay
  // compatible; defaults to 0 = no badge rendered.
  assignedCount?: number;
  // Context-aware drawer slot. When provided, this replaces the default
  // mail-nav block (All inboxes / Mailboxes / Layouts / Smart Mailboxes)
  // — the layout passes a section-specific body for /inbox/calendar,
  // /inbox/contacts, /inbox/settings. Top (logo + Compose) and bottom
  // utility row stay constant either way so users can always switch
  // sections from the bottom row.
  sectionBody?: React.ReactNode;
}

export default function Sidebar({
  domains,
  mailboxes,
  scope,
  initialCollapsed = false,
  isAdmin,
  savedSearches = [],
  inboxLayouts = [],
  initialSmartOpen = true,
  initialLayoutsOpen = true,
  assignedCount = 0,
  sectionBody,
}: Props) {
  const [collapsed, setCollapsed] = useState(
    () => readCollapsedCookie() ?? initialCollapsed,
  );
  const [smartOpen, setSmartOpen] = useState(initialSmartOpen);
  // Layouts section open/closed pref. Same cookie-driven SSR hydration as
  // the Smart Mailboxes section above; default open so empty-state
  // discoverability isn't hidden behind a chevron click for new users.
  const [layoutsOpen, setLayoutsOpen] = useState(initialLayoutsOpen);

  // Locally-mirrored mailbox order so drag-to-reorder (issue #52) can
  // optimistically update the sidebar before the PATCH lands. Server is
  // the source of truth, but we don't want to wait a round-trip for the
  // row to settle into its new spot.
  //
  // We resync whenever the prop changes (e.g. mailbox added/removed via
  // Settings) by comparing the prop reference against a stash. Updating
  // state during render — rather than via useEffect — is the React-19
  // recommended pattern for "derive state from props but allow it to
  // diverge": it avoids the cascading-renders lint and runs in the same
  // commit as the prop change instead of one render late.
  const [orderedMailboxes, setOrderedMailboxes] = useState<MailboxRow[]>(mailboxes);
  const [lastMailboxesRef, setLastMailboxesRef] = useState(mailboxes);
  if (lastMailboxesRef !== mailboxes) {
    setLastMailboxesRef(mailboxes);
    setOrderedMailboxes(mailboxes);
  }

  function toggleSmart() {
    const next = !smartOpen;
    setSmartOpen(next);
    document.cookie = `${SMART_MAILBOXES_COOKIE}=${next ? "1" : "0"};path=/;max-age=31536000;samesite=lax`;
  }

  function toggleLayouts() {
    const next = !layoutsOpen;
    setLayoutsOpen(next);
    document.cookie = `${LAYOUTS_OPEN_COOKIE}=${next ? "1" : "0"};path=/;max-age=31536000;samesite=lax`;
  }

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${COLLAPSED_COOKIE}=${next ? "1" : "0"};path=/;max-age=31536000;samesite=lax`;
  }

  // Group mailboxes by domain so we can render single-mailbox domains as a flat
  // row and multi-mailbox domains as expandable groups. Domains with no
  // accessible mailboxes are dropped — admins should add a mailbox via Settings.
  //
  // Domain ordering follows the user-defined mailbox order (issue #52): a
  // domain's slot is the position of its first child in `orderedMailboxes`.
  // That way reordering the underlying mailbox array via drag-and-drop also
  // moves the domain header it belongs to, without us needing a parallel
  // "domain sort_order" column. Mailboxes inside a group preserve their
  // own relative order from the array.
  const { domainEntries, totalUnread } = useMemo(() => {
    const byDomain = new Map<string, MailboxRow[]>();
    const firstIndex = new Map<string, number>();
    orderedMailboxes.forEach((mb, idx) => {
      const list = byDomain.get(mb.domain_id) ?? [];
      list.push(mb);
      byDomain.set(mb.domain_id, list);
      if (!firstIndex.has(mb.domain_id)) firstIndex.set(mb.domain_id, idx);
    });

    const entries = domains
      .map(d => ({ domain: d, list: byDomain.get(d.id) ?? [] }))
      .filter(e => e.list.length > 0)
      .sort((a, b) => {
        const ai = firstIndex.get(a.domain.id) ?? Number.MAX_SAFE_INTEGER;
        const bi = firstIndex.get(b.domain.id) ?? Number.MAX_SAFE_INTEGER;
        return ai - bi;
      });

    const total = orderedMailboxes.reduce((sum, mb) => sum + (mb.unread_count ?? 0), 0);
    return { domainEntries: entries, totalUnread: total };
  }, [orderedMailboxes, domains]);

  // Persist the new order to the server. Fire-and-forget — the optimistic
  // local state has already moved the row; if the PATCH fails we log it
  // (and the next page load will resync from the server anyway).
  function persistOrder(next: MailboxRow[]) {
    const order = next.map(mb => mb.id);
    fetch("/api/me/mailbox-order", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order }),
    }).catch(err => {
      // Keep the optimistic UI; log so it shows up in devtools.
      console.error("mailbox-order PATCH failed", err);
    });
  }

  // Move a whole domain entry (and the mailboxes it contains) from one
  // position to another in the top-level domain list. Single-mailbox
  // domains move just one row; multi-mailbox domains move all their
  // children as a contiguous block, preserving their internal order.
  function moveDomain(fromDomainId: string, toDomainId: string) {
    if (fromDomainId === toDomainId) return;
    const groups = new Map<string, MailboxRow[]>();
    const order: string[] = [];
    for (const mb of orderedMailboxes) {
      if (!groups.has(mb.domain_id)) {
        groups.set(mb.domain_id, []);
        order.push(mb.domain_id);
      }
      groups.get(mb.domain_id)!.push(mb);
    }
    const fromIdx = order.indexOf(fromDomainId);
    const toIdx = order.indexOf(toDomainId);
    if (fromIdx < 0 || toIdx < 0) return;
    order.splice(fromIdx, 1);
    order.splice(toIdx, 0, fromDomainId);
    const next = order.flatMap(id => groups.get(id) ?? []);
    setOrderedMailboxes(next);
    persistOrder(next);
  }

  // Move a single mailbox within its parent domain (intra-group drag).
  // Cross-domain drags are not supported — a mailbox belongs to its
  // domain, and rendering a mailbox under the wrong domain group would
  // be confusing.
  function moveMailboxWithinDomain(fromId: string, toId: string) {
    if (fromId === toId) return;
    const from = orderedMailboxes.find(mb => mb.id === fromId);
    const to = orderedMailboxes.find(mb => mb.id === toId);
    if (!from || !to || from.domain_id !== to.domain_id) return;
    const next = [...orderedMailboxes];
    const fromIdx = next.indexOf(from);
    next.splice(fromIdx, 1);
    const toIdx = next.indexOf(to);
    next.splice(toIdx, 0, from);
    setOrderedMailboxes(next);
    persistOrder(next);
  }

  return (
    <aside
      data-no-print
      className={`sidebar shrink-0 border-r border-neutral-200 dark:border-neutral-800 flex flex-col transition-[width] duration-150 ${
        collapsed ? "w-16" : "w-64"
      }`}
    >
      <div className={`p-3 flex items-center ${collapsed ? "justify-center" : "gap-2"}`}>
        {!collapsed && (
          <>
            <span className="inline-block w-3 h-3 rounded-full bg-[var(--color-brand)]" />
            <span className="font-display text-[1.0625rem] font-semibold tracking-tight truncate">
              Orange Inbox
            </span>
          </>
        )}
        <button
          type="button"
          onClick={toggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          aria-controls="orange-sidebar-nav"
          className={`${
            collapsed ? "" : "ml-auto"
          } rounded p-1 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-800 hover:text-neutral-900 dark:hover:text-neutral-100`}
        >
          {collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
        </button>
      </div>

      <div className={`pb-3 ${collapsed ? "px-2" : "px-3"}`}>
        <SectionPrimaryAction scope={scope} collapsed={collapsed} />
      </div>

      {/*
        Extra right-padding so the WebKit scrollbar doesn't overlap row content
        in the collapsed rail (the icons are nearly the column's full width).
      */}
      <nav
        id="orange-sidebar-nav"
        aria-label={sectionBody ? sectionLabel(scope) : "Mailboxes"}
        className={`flex-1 overflow-y-auto overflow-x-hidden pb-2 ${collapsed ? "px-1.5 pr-2.5" : "px-2"}`}
      >
        {sectionBody ? sectionBody : (
          <MailNavBody
            scope={scope}
            collapsed={collapsed}
            totalUnread={totalUnread}
            assignedCount={assignedCount}
            domainEntries={domainEntries}
            moveDomain={moveDomain}
            moveMailboxWithinDomain={moveMailboxWithinDomain}
            layoutsOpen={layoutsOpen}
            toggleLayouts={toggleLayouts}
            inboxLayouts={inboxLayouts}
            smartOpen={smartOpen}
            toggleSmart={toggleSmart}
            savedSearches={savedSearches}
          />
        )}
      </nav>

      {!collapsed && <QuickSearchHint />}

      {/*
        Settings + Help sit at the bottom of the drawer — common Gmail/Slack
        pattern, and an out-of-the-way home for things you only touch
        occasionally (mailbox access, signatures, labels, domains, install
        instructions, storage usage).
      */}
      <div className="border-t border-neutral-200 dark:border-neutral-800 p-2">
        <div
          className={
            collapsed
              ? "flex flex-col items-center gap-1"
              : "flex items-center justify-around"
          }
        >
          <UtilityIcon
            href="/inbox/all"
            label="Mail"
            active={isMailScope(scope)}
            icon={<MailNavIcon />}
          />
          <UtilityIcon
            href="/inbox/calendar"
            label="Calendar"
            active={scope === "calendar"}
            icon={<CalendarIcon />}
          />
          <UtilityIcon
            href="/inbox/contacts"
            label="Contacts"
            active={scope === "contacts"}
            icon={<ContactsIcon />}
          />
          <UtilityIcon
            href="/inbox/settings"
            label="Settings"
            active={scope === "settings"}
            icon={<SettingsIcon />}
          />
          <UtilityIcon
            href="/inbox/help"
            label="Help"
            active={scope === "help"}
            icon={<HelpIcon />}
          />
        </div>
      </div>
    </aside>
  );
}

// Scope-aware primary CTA. Mail scopes get the standard Compose button
// (which opens the global compose modal). Calendar / contacts dispatch
// a CustomEvent that the page's manager component listens for and uses
// to open its own create modal — that keeps modal state colocated with
// the form it controls. Settings has nothing to "create", so we render
// nothing there.
function SectionPrimaryAction({ scope, collapsed }: { scope: string; collapsed: boolean }) {
  if (scope === "calendar") {
    return (
      <SectionEventButton
        collapsed={collapsed}
        eventName="orange:calendar:new-event"
        label="New event"
      />
    );
  }
  if (scope === "contacts") {
    return (
      <SectionEventButton
        collapsed={collapsed}
        eventName="orange:contacts:new-contact"
        label="New contact"
      />
    );
  }
  if (scope === "settings" || scope === "help") {
    // Nothing meaningful to create from a Settings/Help drawer; suppress
    // the slot rather than render an inactive shell.
    return null;
  }
  return <ComposeButton scope={scope} collapsed={collapsed} />;
}

function SectionEventButton({
  collapsed,
  eventName,
  label,
}: {
  collapsed: boolean;
  eventName: string;
  label: string;
}) {
  function fire() {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(eventName));
  }
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={fire}
        title={label}
        aria-label={label}
        className="w-full h-10 flex items-center justify-center rounded-md bg-[var(--color-brand)] text-white hover:brightness-95"
      >
        <PlusIcon />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={fire}
      className="w-full inline-flex items-center justify-center gap-1 rounded-md bg-[var(--color-brand)] px-3 py-2 text-sm font-medium text-white hover:brightness-95"
    >
      <PlusIcon /> {label}
    </button>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 2.5a.75.75 0 0 1 .75.75v4h4a.75.75 0 0 1 0 1.5h-4v4a.75.75 0 0 1-1.5 0v-4h-4a.75.75 0 0 1 0-1.5h4v-4A.75.75 0 0 1 8 2.5Z" />
    </svg>
  );
}

function sectionLabel(scope: string): string {
  if (scope === "calendar") return "Calendars";
  if (scope === "contacts") return "Contact filters";
  if (scope === "settings") return "Settings sections";
  if (scope === "help") return "Help sections";
  return "Section";
}

interface MailNavBodyProps {
  scope: string;
  collapsed: boolean;
  totalUnread: number;
  assignedCount: number;
  domainEntries: { domain: DomainRow; list: MailboxRow[] }[];
  moveDomain: (fromDomainId: string, toDomainId: string) => void;
  moveMailboxWithinDomain: (fromId: string, toId: string) => void;
  layoutsOpen: boolean;
  toggleLayouts: () => void;
  inboxLayouts: InboxLayoutRow[];
  smartOpen: boolean;
  toggleSmart: () => void;
  savedSearches: SavedSearchRow[];
}

function MailNavBody({
  scope,
  collapsed,
  totalUnread,
  assignedCount,
  domainEntries,
  moveDomain,
  moveMailboxWithinDomain,
  layoutsOpen,
  toggleLayouts,
  inboxLayouts,
  smartOpen,
  toggleSmart,
  savedSearches,
}: MailNavBodyProps) {
  return (
    <>
      <SpecialLink
        href="/inbox/all"
        label="All inboxes"
        active={scope === "all"}
        icon={<InboxIcon />}
        collapsed={collapsed}
        unreadCount={totalUnread}
      />
        <SpecialLink
          href="/inbox/vips"
          label="VIPs"
          active={scope === "vips"}
          icon={<VipIcon />}
          collapsed={collapsed}
        />
        <SpecialLink
          href="/inbox/starred"
          label="Starred"
          active={scope === "starred"}
          icon={<StarredIcon />}
          collapsed={collapsed}
        />
        <SpecialLink
          href="/inbox/followups"
          label="Follow-ups"
          active={scope === "followups"}
          icon={<FollowUpsIcon />}
          collapsed={collapsed}
        />
        <SpecialLink
          href="/inbox/assigned"
          label="Assigned to me"
          active={scope === "assigned"}
          icon={<AssignedIcon />}
          collapsed={collapsed}
          unreadCount={assignedCount}
        />
        <SpecialLink
          href="/inbox/drafts"
          label="Drafts"
          active={scope === "drafts"}
          icon={<DraftIcon />}
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
          href="/inbox/subscriptions"
          label="Subscriptions"
          active={scope === "subscriptions"}
          icon={<SubscriptionsIcon />}
          collapsed={collapsed}
        />
        <SpecialLink
          href="/inbox/aliases"
          label="Aliases"
          active={scope === "aliases"}
          icon={<AliasesIcon />}
          collapsed={collapsed}
        />
        <SpecialLink
          href="/inbox/scheduled"
          label="Scheduled"
          active={scope === "scheduled"}
          icon={<ScheduledIcon />}
          collapsed={collapsed}
        />
        <SpecialLink
          href="/inbox/spam"
          label="Spam"
          active={scope === "spam"}
          icon={<SpamIcon />}
          collapsed={collapsed}
        />
        <SpecialLink
          href="/inbox/archived"
          label="Archived"
          active={scope === "archived"}
          icon={<ArchivedIcon />}
          collapsed={collapsed}
        />

        {!collapsed && domainEntries.length > 0 && (
          <div className="mt-5 mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Mailboxes
          </div>
        )}

        {domainEntries.map(({ domain, list }) => (
          <DomainEntry
            key={domain.id}
            domain={domain}
            mailboxes={list}
            scope={scope}
            collapsed={collapsed}
            onMoveDomain={moveDomain}
            onMoveMailbox={moveMailboxWithinDomain}
          />
        ))}

        <Layouts
          collapsed={collapsed}
          open={layoutsOpen}
          onToggle={toggleLayouts}
          inboxLayouts={inboxLayouts}
          scope={scope}
        />

        <SmartMailboxes
          collapsed={collapsed}
          open={smartOpen}
          onToggle={toggleSmart}
          savedSearches={savedSearches}
        />
    </>
  );
}

function UtilityIcon({
  href,
  label,
  active,
  icon,
}: {
  href: string;
  label: string;
  active: boolean;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      title={label}
      aria-label={label}
      className={`flex items-center justify-center w-9 h-9 rounded-md ${
        active
          ? "bg-[var(--color-brand)]/15 text-[var(--color-brand)]"
          : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900 hover:text-neutral-900 dark:hover:text-neutral-100"
      }`}
    >
      {icon}
    </Link>
  );
}

function SpecialLink({
  href,
  label,
  active,
  icon,
  collapsed,
  unreadCount,
}: {
  href: string;
  label: string;
  active: boolean;
  icon: React.ReactNode;
  collapsed: boolean;
  unreadCount?: number;
}) {
  const hasUnread = (unreadCount ?? 0) > 0;
  if (collapsed) {
    return (
      <Link
        href={href}
        title={hasUnread ? `${label} (${unreadCount} unread)` : label}
        aria-label={hasUnread ? `${label}, ${unreadCount} unread` : label}
        className={`relative flex items-center justify-center w-10 h-10 mx-auto my-0.5 rounded-md ${
          active
            ? "bg-[var(--color-brand)]/15 text-[var(--color-brand)]"
            : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900"
        }`}
      >
        {icon}
        {hasUnread && (
          <span
            aria-hidden
            className="absolute top-1 right-1 inline-block h-2 w-2 rounded-full bg-[var(--color-brand)]"
          />
        )}
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
      <span className={`truncate flex-1 ${hasUnread && !active ? "font-semibold text-neutral-900 dark:text-neutral-100" : ""}`}>
        {label}
      </span>
      {hasUnread && <UnreadBadge count={unreadCount ?? 0} active={active} />}
    </Link>
  );
}

// Renders one domain's worth of sidebar entries.
//
// Single mailbox → render the mailbox row directly (no domain wrapper).
//
// Multiple mailboxes → render an expandable group: the header itself links to
// `/inbox/domain:<id>` (a unified view across the domain's mailboxes) and a
// chevron toggles the children. Expansion is persisted per domain in
// localStorage, and auto-opens when the active scope is one of its children.
function DomainEntry({
  domain,
  mailboxes,
  scope,
  collapsed,
  onMoveDomain,
  onMoveMailbox,
}: {
  domain: DomainRow;
  mailboxes: MailboxRow[];
  scope: string;
  collapsed: boolean;
  onMoveDomain: (fromDomainId: string, toDomainId: string) => void;
  onMoveMailbox: (fromMailboxId: string, toMailboxId: string) => void;
}) {
  const domainScope = `domain:${domain.id}`;
  const domainActive = scope === domainScope;
  const childActive = mailboxes.some(mb => mb.id === scope);
  const totalUnread = mailboxes.reduce((s, mb) => s + (mb.unread_count ?? 0), 0);
  const domainDrag = useRowDrag("domain", domain.id, onMoveDomain);

  if (mailboxes.length === 1) {
    // Single-mailbox domain: drag/drop is for the *whole entry*, not the
    // mailbox-within-a-group. We tag the drag with the domain MIME so
    // top-level rows only swap with other top-level rows (not children
    // of an expanded group). The mailbox row component itself doesn't
    // accept drops in this case — the wrapper handles them.
    return (
      <SidebarMailbox
        mb={mailboxes[0]}
        active={scope === mailboxes[0].id}
        collapsed={collapsed}
        drag={domainDrag}
      />
    );
  }

  if (collapsed) {
    // Collapsed sidebar: one icon per multi-mailbox domain (clickable to the
    // unified view). Drilling into individual mailboxes requires expanding.
    return (
      <Link
        href={`/inbox/${domainScope}`}
        title={domain.name}
        aria-label={domain.name}
        aria-current={domainActive ? "page" : undefined}
        className={`relative flex items-center justify-center w-10 h-10 mx-auto my-0.5 rounded-md ${
          domainActive || childActive
            ? "bg-[var(--color-brand)]/15"
            : "hover:bg-neutral-100 dark:hover:bg-neutral-900"
        } ${domainDrag.dragClass}`}
        draggable
        onDragStart={domainDrag.onDragStart}
        onDragOver={domainDrag.onDragOver}
        onDragLeave={domainDrag.onDragLeave}
        onDrop={domainDrag.onDrop}
        onDragEnd={domainDrag.onDragEnd}
      >
        <DomainAvatar domain={domain} active={domainActive || childActive} />
        {totalUnread > 0 && (
          <span
            aria-hidden
            className="absolute top-1 right-1 inline-block h-2 w-2 rounded-full bg-[var(--color-brand)]"
          />
        )}
      </Link>
    );
  }

  return (
    <ExpandableDomainGroup
      domain={domain}
      mailboxes={mailboxes}
      scope={scope}
      domainScope={domainScope}
      domainActive={domainActive}
      childActive={childActive}
      totalUnread={totalUnread}
      domainDrag={domainDrag}
      onMoveMailbox={onMoveMailbox}
    />
  );
}

function ExpandableDomainGroup({
  domain,
  mailboxes,
  scope,
  domainScope,
  domainActive,
  childActive,
  totalUnread,
  domainDrag,
  onMoveMailbox,
}: {
  domain: DomainRow;
  mailboxes: MailboxRow[];
  scope: string;
  domainScope: string;
  domainActive: boolean;
  childActive: boolean;
  totalUnread: number;
  domainDrag: RowDrag;
  onMoveMailbox: (fromMailboxId: string, toMailboxId: string) => void;
}) {
  const storageKey = `${DOMAIN_EXPANDED_PREFIX}${domain.id}`;
  // Default expanded if a child is active (so users can see where they are).
  // Otherwise, defer to the persisted preference (read after mount).
  const [expanded, setExpanded] = useState(() => childActive);
  useEffect(() => {
    if (childActive) {
      setExpanded(true);
      return;
    }
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved === "1") setExpanded(true);
      else if (saved === "0") setExpanded(false);
    } catch {
      // localStorage may be unavailable (private mode / quota); keep default.
    }
  }, [storageKey, childActive]);

  function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setExpanded(prev => {
      const next = !prev;
      try {
        window.localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        // best-effort
      }
      return next;
    });
  }

  return (
    <div
      className={`mt-1 ${domainDrag.dragClass}`}
      draggable
      onDragStart={domainDrag.onDragStart}
      onDragOver={domainDrag.onDragOver}
      onDragLeave={domainDrag.onDragLeave}
      onDrop={domainDrag.onDrop}
      onDragEnd={domainDrag.onDragEnd}
    >
      <div className="group flex items-stretch">
        <Link
          href={`/inbox/${domainScope}`}
          aria-current={domainActive ? "page" : undefined}
          className={`flex-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm min-w-0 ${
            domainActive
              ? "bg-[var(--color-brand)]/15 text-[var(--color-brand)] font-medium"
              : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900"
          }`}
        >
          <DomainAvatar domain={domain} active={domainActive} />
          <span className="truncate flex-1">{domain.name}</span>
          {totalUnread > 0 && <UnreadBadge count={totalUnread} active={domainActive} />}
        </Link>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${domain.name}` : `Expand ${domain.name}`}
          className="ml-0.5 px-1 rounded text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900"
        >
          <ChevronToggle expanded={expanded} />
        </button>
      </div>
      {expanded && (
        <ul className="mt-0.5 space-y-0.5">
          {mailboxes.map(mb => (
            <ChildMailboxRow
              key={mb.id}
              mb={mb}
              active={scope === mb.id}
              onMoveMailbox={onMoveMailbox}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// Wraps SidebarMailbox so each child gets its own `useRowDrag` hook —
// React requires hooks at a stable position, so we can't call the hook
// inside the parent's `.map`. The component is intentionally minimal;
// it exists purely to give each row an independent drag-state slot.
function ChildMailboxRow({
  mb,
  active,
  onMoveMailbox,
}: {
  mb: MailboxRow;
  active: boolean;
  onMoveMailbox: (fromMailboxId: string, toMailboxId: string) => void;
}) {
  const drag = useRowDrag("mailbox", mb.id, onMoveMailbox);
  return (
    <li>
      <SidebarMailbox mb={mb} active={active} collapsed={false} indent drag={drag} />
    </li>
  );
}

function SidebarMailbox({
  mb,
  active,
  collapsed,
  indent = false,
  drag,
}: {
  mb: MailboxRow;
  active: boolean;
  collapsed: boolean;
  indent?: boolean;
  drag?: RowDrag;
}) {
  const fullAddress = `${mb.local_part}@${mb.domain_name}`;
  const customName = mb.display_name?.trim();
  // Display-name preference order:
  //   - When a custom display_name is set, use it verbatim and keep the email
  //     in the tooltip (full disambiguation is one hover away).
  //   - Otherwise fall back to the address: indented children show
  //     `local@` since the domain header is right above them; top-level rows
  //     show the full `local@domain`.
  const fallback = indent
    ? mb.is_catch_all
      ? `${mb.local_part}@ (catch-all)`
      : `${mb.local_part}@`
    : mb.is_catch_all
      ? `${fullAddress} (catch-all)`
      : fullAddress;
  const label = customName || fallback;
  const tooltip = customName
    ? `${customName} — ${fullAddress}${mb.is_catch_all ? " (catch-all)" : ""}`
    : mb.is_catch_all
      ? `${fullAddress} (catch-all)`
      : fullAddress;
  const hasUnread = mb.unread_count > 0;
  const ariaLabel = hasUnread ? `${label}, ${mb.unread_count} unread` : label;
  const collapsedTitle = hasUnread ? `${tooltip} (${mb.unread_count} unread)` : tooltip;

  if (collapsed) {
    return (
      <Link
        href={`/inbox/${mb.id}`}
        title={collapsedTitle}
        aria-label={ariaLabel}
        aria-current={active ? "page" : undefined}
        draggable={drag ? true : undefined}
        onDragStart={drag?.onDragStart}
        onDragOver={drag?.onDragOver}
        onDragLeave={drag?.onDragLeave}
        onDrop={drag?.onDrop}
        onDragEnd={drag?.onDragEnd}
        className={`relative flex items-center justify-center w-10 h-10 mx-auto my-0.5 rounded-md ${
          active
            ? "bg-[var(--color-brand)]/15"
            : "hover:bg-neutral-100 dark:hover:bg-neutral-900"
        } ${drag?.dragClass ?? ""}`}
      >
        <MailboxAvatar mb={mb} active={active} />
        {hasUnread && (
          <span
            aria-hidden
            className="absolute top-1 right-1 inline-block h-2 w-2 rounded-full bg-[var(--color-brand)]"
          />
        )}
      </Link>
    );
  }

  return (
    <Link
      href={`/inbox/${mb.id}`}
      aria-label={ariaLabel}
      aria-current={active ? "page" : undefined}
      title={tooltip}
      draggable={drag ? true : undefined}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDragLeave={drag?.onDragLeave}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
      className={`flex items-center gap-2 rounded-md py-1.5 text-sm min-w-0 ${
        indent ? "pl-4 pr-2" : "px-2"
      } ${
        active
          ? "bg-[var(--color-brand)]/15 text-[var(--color-brand)] font-medium"
          : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900"
      } ${drag?.dragClass ?? ""}`}
    >
      <MailboxAvatar mb={mb} active={active} />
      <span
        className={`truncate flex-1 ${
          hasUnread && !active ? "font-semibold text-neutral-900 dark:text-neutral-100" : ""
        }`}
      >
        {label}
      </span>
      {mb.is_shared === 1 && (
        <span
          title={`${mb.member_count} members`}
          className="ml-1 shrink-0 text-[10px] uppercase tracking-wider text-neutral-500"
        >
          shared
        </span>
      )}
      {hasUnread && <UnreadBadge count={mb.unread_count} active={active} />}
    </Link>
  );
}

// Pill-style unread count, modelled on LabelChip's chip styling so the sidebar
// stays visually consistent. Caps at 99+ to keep the chip from blowing out the
// row width on busy mailboxes.
function UnreadBadge({ count, active }: { count: number; active: boolean }) {
  const display = count > 99 ? "99+" : String(count);
  const tone = active
    ? "bg-[var(--color-brand)] text-white"
    : "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200";
  return (
    <span
      aria-hidden
      className={`ml-1 shrink-0 inline-flex items-center justify-center rounded-full px-1.5 py-px text-[10px] font-medium tabular-nums min-w-[18px] ${tone}`}
    >
      {display}
    </span>
  );
}

// Mailbox avatar: 2-letter chip seeded by domain so all mailboxes on the same
// domain share a tint, with the local-part initial in front to differentiate
// siblings (e.g. hello@example.com → "HE", support@example.com → "SE").
function MailboxAvatar({ mb, active = false }: { mb: MailboxRow; active?: boolean }) {
  const initials = ((mb.local_part[0] ?? "?") + (mb.domain_name[0] ?? "?")).toUpperCase();
  return <Avatar seed={mb.domain_name} label={initials} size="sm" ringed={active} />;
}

// Domain avatar (used for multi-mailbox domain headers): 2-letter chip seeded
// by domain so its colour matches its child mailboxes.
function DomainAvatar({ domain, active = false }: { domain: DomainRow; active?: boolean }) {
  const initials = domain.name.slice(0, 2).toUpperCase();
  return <Avatar seed={domain.name} label={initials} size="sm" ringed={active} />;
}

// Smart Mailboxes — saved-search shortcuts. Collapsible header (state cookied
// so the open/closed pref survives reloads) with each entry linking back to
// /search?q=<encoded>. Hidden from the collapsed-rail layout because there's
// nothing meaningful to render in a 14px column for free-form names; users
// who rely on saved searches will keep the sidebar expanded.
// Multi-pane Inbox Layouts — like Smart Mailboxes but each entry routes to
// /inbox/layout:<id>, where MultiInboxLayout fans out the saved panes
// side-by-side. Empty state nudges the user to Settings to assemble one.
// Hidden in the collapsed rail for the same reason saved searches are: the
// names are free-form and don't fit a 14px column.
function Layouts({
  collapsed,
  open,
  onToggle,
  inboxLayouts,
  scope,
}: {
  collapsed: boolean;
  open: boolean;
  onToggle: () => void;
  inboxLayouts: InboxLayoutRow[];
  scope: string;
}) {
  if (collapsed) return null;

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1 px-3 pb-1 text-xs uppercase tracking-wider text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
      >
        <ChevronTwistyIcon open={open} />
        <span className="truncate">Layouts</span>
      </button>
      {open && (
        <>
          {inboxLayouts.length === 0 ? (
            <Link
              href="/inbox/settings"
              className="block px-3 py-1 text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
            >
              Create a layout in Settings →
            </Link>
          ) : (
            <>
              {inboxLayouts.map(l => (
                <LayoutLink
                  key={l.id}
                  layout={l}
                  active={scope === `layout:${l.id}`}
                />
              ))}
              <Link
                href="/inbox/settings"
                className="block px-3 py-1 text-[11px] text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
              >
                + Create layout
              </Link>
            </>
          )}
        </>
      )}
    </div>
  );
}

function LayoutLink({ layout, active }: { layout: InboxLayoutRow; active: boolean }) {
  return (
    <Link
      href={`/inbox/layout:${layout.id}`}
      title={
        layout.is_default
          ? `${layout.name} (default)`
          : layout.name
      }
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
        active
          ? "bg-[var(--color-brand)]/15 text-[var(--color-brand)] font-medium"
          : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900"
      }`}
    >
      <LayoutIcon />
      <span className="truncate flex-1">{layout.name}</span>
      {layout.is_default && (
        <span
          aria-hidden
          title="Default layout"
          className="shrink-0 text-[9px] uppercase tracking-wider text-neutral-500"
        >
          ★
        </span>
      )}
    </Link>
  );
}

function LayoutIcon() {
  // Two-column rectangle, signalling "split view".
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
      className="text-neutral-500"
    >
      <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h3A1.5 1.5 0 0 1 8 3.5v9A1.5 1.5 0 0 1 6.5 14h-3A1.5 1.5 0 0 1 2 12.5v-9Zm7 0A1.5 1.5 0 0 1 10.5 2h2A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-2A1.5 1.5 0 0 1 9 12.5v-9Z" />
    </svg>
  );
}

function SmartMailboxes({
  collapsed,
  open,
  onToggle,
  savedSearches,
}: {
  collapsed: boolean;
  open: boolean;
  onToggle: () => void;
  savedSearches: SavedSearchRow[];
}) {
  if (collapsed) return null;

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1 px-3 pb-1 text-xs uppercase tracking-wider text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
      >
        <ChevronTwistyIcon open={open} />
        <span className="truncate">Smart Mailboxes</span>
      </button>
      {open && (
        savedSearches.length === 0 ? (
          <p className="px-3 py-1 text-xs text-neutral-500">
            Save a search to see it here
          </p>
        ) : (
          savedSearches.map(s => <SmartMailboxLink key={s.id} saved={s} />)
        )
      )}
    </div>
  );
}

function SmartMailboxLink({ saved }: { saved: SavedSearchRow }) {
  const href = `/search?q=${encodeURIComponent(saved.query)}`;
  return (
    <Link
      href={href}
      title={saved.query}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900"
    >
      <SearchPinIcon />
      <span className="truncate flex-1">{saved.name}</span>
    </Link>
  );
}

// Tiny "⌘K Quick search" affordance above the utility row — text-only by
// design so it doesn't compete with the BottomLink icons. Renders the right
// modifier glyph for the visitor's platform (⌘ on macOS, Ctrl elsewhere)
// and stays visually quiet via muted text + no border / no background.
//
// We avoid a useEffect/setState dance for platform detection — the kbd
// glyph is purely cosmetic, so reading navigator.userAgent directly via
// useState's lazy initialiser (client-only since the parent is "use client")
// keeps the render single-pass. SSR can't reach this branch because the
// Sidebar is a client component.
function QuickSearchHint() {
  const isMac = useState(() => {
    if (typeof navigator === "undefined") return false;
    // userAgentData.platform is the modern source of truth, but Safari still
    // doesn't ship it; fall back to the user-agent string for now.
    const platform =
      (navigator as Navigator & { userAgentData?: { platform?: string } })
        .userAgentData?.platform ?? navigator.userAgent;
    return /mac/i.test(platform);
  })[0];
  const mod = isMac ? "⌘" : "Ctrl";
  return (
    <div className="px-3 pb-1.5 text-[11px] text-neutral-500 dark:text-neutral-500 select-none">
      <kbd className="font-mono">{mod}</kbd>
      <kbd className="ml-0.5 font-mono">K</kbd>
      <span className="ml-1.5">Quick search</span>
    </div>
  );
}

function ChevronTwistyIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
      className={`transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="M5.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L8.94 8 5.22 4.28a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

function ChevronToggle({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
      className={`transition-transform ${expanded ? "rotate-90" : ""}`}
    >
      <path d="M5.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L8.94 8 5.22 4.28a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

function SearchPinIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
      className="text-neutral-500"
    >
      <path d="M11 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm-.5 3.5 3 3a.75.75 0 1 1-1.06 1.06l-3-3a.75.75 0 0 1 1.06-1.06Z" />
    </svg>
  );
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

function SubscriptionsIcon() {
  // Mailing-list / "tag" icon — distinguishes from inbox/drafts/templates.
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M2.5 1.5A1.5 1.5 0 0 0 1 3v5.586a1.5 1.5 0 0 0 .44 1.06l4.914 4.915a1.5 1.5 0 0 0 2.121 0l5.586-5.586a1.5 1.5 0 0 0 0-2.121L9.146 1.94A1.5 1.5 0 0 0 8.086 1.5H2.5Zm2 4.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Z" />
    </svg>
  );
}

function AliasesIcon() {
  // Two overlapping name tags — visually distinct from Subscriptions / Vips
  // / Mailbox so the row is recognisable at a glance.
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h5A1.5 1.5 0 0 1 11 3.5v.75H4.5A1.5 1.5 0 0 0 3 5.75V3.5Z" />
      <path d="M5 5.75A1.5 1.5 0 0 1 6.5 4.25h5A1.5 1.5 0 0 1 13 5.75v6.75A1.5 1.5 0 0 1 11.5 14h-5A1.5 1.5 0 0 1 5 12.5V5.75Zm2.25 1.5a.75.75 0 1 0 0 1.5h3.5a.75.75 0 0 0 0-1.5h-3.5Zm0 2.5a.75.75 0 1 0 0 1.5h2a.75.75 0 0 0 0-1.5h-2Z" />
    </svg>
  );
}

function VipIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 1.25 9.86 5l4.14.6-3 2.93.71 4.13L8 10.71l-3.71 1.95.71-4.13-3-2.93L6.14 5 8 1.25Z" />
    </svg>
  );
}

// Starred glyph — same 5-point geometry as VipIcon but rendered as an
// outline so the two adjacent rows in the sidebar are distinguishable
// at a glance.
function StarredIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 1.6 9.86 5.35l4.14.6-3 2.93.71 4.13L8 11.06l-3.71 1.95.71-4.13-3-2.93L6.14 5.35 8 1.6Z" />
    </svg>
  );
}

// Follow-ups icon — clock face with a small "out" arrow, visually distinct
// from the Scheduled clock (which is a plain clock) and the Remind bell.
// Signals "this is about something you sent that's still hanging".
function FollowUpsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Zm.75 2.5a.75.75 0 0 0-1.5 0v3.25c0 .2.08.39.22.53l2 2a.75.75 0 1 0 1.06-1.06L8.75 7.94V5Z" />
    </svg>
  );
}

// "Assigned to me" — person-with-check glyph. Matches the geometry of the
// other 16x16 sidebar icons (filled, currentColor).
function AssignedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M6 1.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm-4 11c0-2.21 1.79-4 4-4s4 1.79 4 4v.5H2v-.5Zm12.78-5.78a.75.75 0 0 0-1.06-1.06L11 8.44 9.78 7.22a.75.75 0 0 0-1.06 1.06l1.75 1.75a.75.75 0 0 0 1.06 0l3.25-3.31Z" />
    </svg>
  );
}

// Calendar icon — month grid with a header strip, mirrors the geometry of
// the other 16x16 sidebar glyphs (filled, currentColor).
function CalendarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M4.5 1a.5.5 0 0 1 .5.5V2h6v-.5a.5.5 0 0 1 1 0V2h.5A2 2 0 0 1 14 4v8.5A2 2 0 0 1 12 14.5H4A2 2 0 0 1 2 12.5V4a2 2 0 0 1 2-2H4v-.5A.5.5 0 0 1 4.5 1ZM3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6H3Z" />
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

function ArchivedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="3" rx="0.5" />
      <path d="M2.5 5.5v7a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-7" />
      <path d="M6 8.5h4" />
    </svg>
  );
}

function SpamIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm-.75 3.5a.75.75 0 0 1 1.5 0v4a.75.75 0 0 1-1.5 0v-4ZM8 12.05a.95.95 0 1 1 0-1.9.95.95 0 0 1 0 1.9Z" />
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

function MailNavIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M2.5 3A1.5 1.5 0 0 0 1 4.5v7A1.5 1.5 0 0 0 2.5 13h11a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 13.5 3h-11Zm.5 1.94 5 3.06 5-3.06v.41L8.4 8.39a.8.8 0 0 1-.8 0L3 5.35v-.41Z" />
    </svg>
  );
}

// Treat "everything mail-related" as the active state for the Mail bottom-row
// icon: All inboxes, per-mailbox views, drafts/templates/scheduled/vips/
// subscriptions/aliases, the unified domain views, and saved layouts. The
// only scopes that *aren't* mail are the dedicated section pages.
function isMailScope(scope: string): boolean {
  if (
    scope === "settings" ||
    scope === "help" ||
    scope === "calendar" ||
    scope === "contacts" ||
    scope === "storage"
  ) {
    return false;
  }
  return true;
}

