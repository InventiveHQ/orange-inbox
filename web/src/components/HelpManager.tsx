"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

// Section IDs are exported so the Sidebar Help-mode drawer can render the
// same anchor list as the page itself — single source of truth.
export const HELP_SECTIONS: { id: string; label: string }[] = [
  { id: "install", label: "Install" },
  { id: "shortcuts", label: "Keyboard shortcuts" },
  { id: "notifications", label: "Notifications" },
  { id: "domains", label: "Mail domains" },
  { id: "sharing", label: "Sharing" },
  { id: "compose", label: "Compose" },
  { id: "scheduling", label: "Scheduling" },
  { id: "organizing", label: "Organizing" },
  { id: "board", label: "Board view" },
  { id: "search", label: "Search" },
  { id: "mobile", label: "Mobile" },
  { id: "troubleshooting", label: "Troubleshooting" },
];

// In-app help. Renders as a full-page scope (like Settings) so it has room
// for prose and is reachable from the sidebar without leaving the app.
//
// Search filters by raw section text content — each Section is wrapped in
// a div tagged with data-help-section, and the effect walks them after
// every keystroke to toggle `hidden`. Cheap because there's only ~10
// sections; avoids hard-coding a parallel search index that would drift
// from the prose.
export default function HelpManager() {
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const [matchCount, setMatchCount] = useState<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const q = query.trim().toLowerCase();
    const wrappers = container.querySelectorAll<HTMLElement>("[data-help-section]");
    let visible = 0;
    for (const w of wrappers) {
      const text = (w.textContent ?? "").toLowerCase();
      const match = q === "" || text.includes(q);
      if (match) {
        w.removeAttribute("hidden");
        visible++;
      } else {
        w.setAttribute("hidden", "");
      }
    }
    setMatchCount(q === "" ? null : visible);
  }, [query]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="px-4 py-4 sm:px-6 border-b border-neutral-200 dark:border-neutral-800 flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold">Help</h1>
        <div className="ml-auto flex items-center gap-2">
          {matchCount !== null && (
            <span className="text-xs text-neutral-500">
              {matchCount === 0 ? "No matches" : `${matchCount} section${matchCount === 1 ? "" : "s"}`}
            </span>
          )}
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search help…"
            aria-label="Search help"
            className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent text-sm px-2 py-1 w-48 sm:w-64 focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)]/40"
          />
        </div>
      </header>
      <div ref={containerRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 space-y-12">
          <div data-help-section><InstallSection /></div>
          <div data-help-section><KeyboardShortcutsSection /></div>
          <div data-help-section><NotificationsSection /></div>
          <div data-help-section><DomainsSection /></div>
          <div data-help-section><SharingSection /></div>
          <div data-help-section><ComposeSection /></div>
          <div data-help-section><SchedulingSection /></div>
          <div data-help-section><OrganizingSection /></div>
          <div data-help-section><BoardSection /></div>
          <div data-help-section><SearchSection /></div>
          <div data-help-section><MobileSection /></div>
          <div data-help-section><TroubleshootingSection /></div>
        </div>
      </div>
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="space-y-3 scroll-mt-4">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-500">
        {title}
      </h2>
      <div className="space-y-3 text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed">
        {children}
      </div>
    </section>
  );
}

function Step({ children }: { children: React.ReactNode }) {
  return <li className="ml-5 list-decimal pl-1">{children}</li>;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] justify-center rounded border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 px-1.5 py-0.5 text-xs font-mono">
      {children}
    </kbd>
  );
}

function ShortcutRow({ keys, desc }: { keys: string[]; desc: string }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="text-neutral-700 dark:text-neutral-300">{desc}</span>
      <span className="flex items-center gap-1">
        {keys.map((k, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-neutral-400 text-xs">then</span>}
            <Kbd>{k}</Kbd>
          </span>
        ))}
      </span>
    </li>
  );
}

function KeyboardShortcutsSection() {
  return (
    <Section id="shortcuts" title="Keyboard shortcuts">
      <p className="text-xs text-neutral-500">
        Shortcuts are disabled while typing in inputs. Press <Kbd>?</Kbd> from
        anywhere in the app to jump to this section.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 not-prose">
        <div>
          <h3 className="mt-2 mb-1 text-xs uppercase tracking-wider text-neutral-500">
            Navigation
          </h3>
          <ul className="space-y-1">
            <ShortcutRow keys={["j"]} desc="Next conversation" />
            <ShortcutRow keys={["k"]} desc="Previous conversation" />
            <ShortcutRow keys={["o", "Enter"]} desc="Open conversation" />
            <ShortcutRow keys={["u"]} desc="Back to list" />
            <ShortcutRow keys={["g", "i"]} desc="Go to All inboxes" />
            <ShortcutRow keys={["g", "s"]} desc="Go to Settings" />
            <ShortcutRow keys={["/"]} desc="Focus search" />
          </ul>
        </div>
        <div>
          <h3 className="mt-2 mb-1 text-xs uppercase tracking-wider text-neutral-500">
            Actions
          </h3>
          <ul className="space-y-1">
            <ShortcutRow keys={["e"]} desc="Archive" />
            <ShortcutRow keys={["h"]} desc="Follow-up on / off" />
            <ShortcutRow keys={["#"]} desc="Delete" />
            <ShortcutRow keys={["s"]} desc="Star / unstar" />
            <ShortcutRow keys={["l"]} desc="Apply label" />
            <ShortcutRow keys={["r"]} desc="Reply" />
            <ShortcutRow keys={["c"]} desc="Compose" />
            <ShortcutRow keys={["t"]} desc="Add to calendar" />
            <ShortcutRow keys={["?"]} desc="Show this section" />
          </ul>
        </div>
        <div>
          <h3 className="mt-2 mb-1 text-xs uppercase tracking-wider text-neutral-500">
            Selection
          </h3>
          <ul className="space-y-1">
            <ShortcutRow keys={["x"]} desc="Select / deselect conversation" />
            <ShortcutRow keys={["a"]} desc="Select all" />
            <ShortcutRow keys={["Esc"]} desc="Clear selection" />
          </ul>
        </div>
        <div className="sm:col-span-2">
          <h3 className="mt-2 mb-1 text-xs uppercase tracking-wider text-neutral-500">
            Calendar
          </h3>
          <ul className="space-y-1">
            <ShortcutRow keys={["d"]} desc="Day view" />
            <ShortcutRow keys={["w"]} desc="Week view" />
            <ShortcutRow keys={["m"]} desc="Month view" />
            <ShortcutRow keys={["a"]} desc="Agenda (list) view" />
            <ShortcutRow keys={["t"]} desc="Jump to today" />
            <ShortcutRow keys={["j"]} desc="Next day / week / month" />
            <ShortcutRow keys={["k"]} desc="Previous day / week / month" />
            <ShortcutRow keys={["c"]} desc="New event" />
          </ul>
        </div>
      </div>
    </Section>
  );
}

function InstallSection() {
  return (
    <Section id="install" title="Installing on your phone">
      <p>
        orange inbox is a Progressive Web App. Once installed it launches like
        a native app, full-screen, with its own icon on the home screen.
      </p>

      <div>
        <div className="font-medium text-neutral-900 dark:text-neutral-100 mb-1">
          iPhone / iPad — Safari
        </div>
        <ol className="space-y-1">
          <Step>Open this site in Safari (Chrome and Firefox on iOS can&apos;t install PWAs).</Step>
          <Step>Sign in through Cloudflare Access first.</Step>
          <Step>Tap the Share button — the square with an up-arrow.</Step>
          <Step>Scroll and tap <span className="font-medium">Add to Home Screen</span>, then <span className="font-medium">Add</span>.</Step>
        </ol>
      </div>

      <div>
        <div className="font-medium text-neutral-900 dark:text-neutral-100 mb-1">
          Android — Chrome
        </div>
        <ol className="space-y-1">
          <Step>Open the site in Chrome and sign in.</Step>
          <Step>Tap the install banner if it appears, or open the ⋮ menu and tap <span className="font-medium">Install app</span>.</Step>
        </ol>
      </div>

      <p className="text-neutral-500 text-xs">
        If install fails silently it&apos;s almost always because the
        <code className="mx-1 px-1 rounded bg-neutral-100 dark:bg-neutral-900">manifest.webmanifest</code>
        couldn&apos;t be fetched — sign in through Access first so the cookie is
        present when the browser asks for it.
      </p>
    </Section>
  );
}

function NotificationsSection() {
  return (
    <Section id="notifications" title="Push notifications">
      <p>
        Open <Link className="text-[var(--color-brand)] underline" href="/inbox/settings#notifications">Settings → Notifications</Link>
        {" "}and toggle them on. The browser will prompt for permission once.
      </p>
      <p>
        On iOS, push notifications only work after the app is installed to the
        home screen (iOS 16.4+). Install first, then open the installed app and
        enable notifications from inside it.
      </p>
    </Section>
  );
}

function DomainsSection() {
  return (
    <Section id="domains" title="Adding mail domains">
      <p>
        Admins add mail domains from
        <Link className="mx-1 text-[var(--color-brand)] underline" href="/inbox/settings#mail-domains">Settings → Mail domains</Link>.
        Each domain you add must already have Cloudflare Email Routing enabled
        and a routing rule pointing inbound mail at the
        <code className="mx-1 px-1 rounded bg-neutral-100 dark:bg-neutral-900">orange-inbox-email</code>
        Worker.
      </p>
      <p>
        Adding a domain creates a default catch-all mailbox so any address on
        that domain lands in one place. Admins can split it into more specific
        mailboxes (e.g. <code className="px-1 rounded bg-neutral-100 dark:bg-neutral-900">support@</code>,
        {" "}<code className="px-1 rounded bg-neutral-100 dark:bg-neutral-900">billing@</code>) from the sidebar &quot;+&quot; next
        to the domain name.
      </p>
    </Section>
  );
}

function SharingSection() {
  return (
    <Section id="sharing" title="Sharing a mailbox with someone">
      <p>
        Admins invite collaborators from
        <Link className="mx-1 text-[var(--color-brand)] underline" href="/inbox/settings#mailbox-access">Settings → Mailbox access</Link>.
        Pick a mailbox, enter an email, and choose a role:
      </p>
      <ul className="ml-5 list-disc space-y-1">
        <li><span className="font-medium">Owner</span> — full control, including managing other members.</li>
        <li><span className="font-medium">Member</span> — read and send.</li>
        <li><span className="font-medium">Reader</span> — read-only; can&apos;t reply or compose from this mailbox.</li>
      </ul>
      <p>
        Members sign in through Cloudflare Access, so make sure the Access
        policy on the host application allows their email.
      </p>
    </Section>
  );
}

function ComposeSection() {
  return (
    <Section id="compose" title="Composing mail">
      <p>
        Click <span className="font-medium">Compose</span> in the sidebar, or
        hit <span className="font-medium">Reply</span> on any thread.
      </p>
      <ul className="ml-5 list-disc space-y-1.5">
        <li>
          <span className="font-medium">Templates</span> — open the &quot;Insert
          template&quot; menu in the compose footer to drop a saved template into
          the body. Manage templates at
          <Link className="mx-1 text-[var(--color-brand)] underline" href="/inbox/templates">Templates</Link>.
          Templates support placeholders like
          <code className="mx-1 px-1 rounded bg-neutral-100 dark:bg-neutral-900">{"{{recipient_name}}"}</code>
          and <code className="mx-1 px-1 rounded bg-neutral-100 dark:bg-neutral-900">{"{{my_email}}"}</code>.
        </li>
        <li>
          <span className="font-medium">Signatures</span> — set a per-mailbox
          signature at <Link className="text-[var(--color-brand)] underline" href="/inbox/settings#signatures">Settings → Signatures</Link>.
          New compose windows seed with the chosen mailbox&apos;s signature.
        </li>
        <li>
          <span className="font-medium">Schedule send</span> — pick a future
          time before sending. Pending sends live at
          <Link className="mx-1 text-[var(--color-brand)] underline" href="/inbox/scheduled">Scheduled</Link> and you can cancel
          them up until they go out.
        </li>
        <li>
          <span className="font-medium">Undo Send</span> — sets a hold window
          (5–30 seconds) so you can pull a message back. Configure at
          <Link className="mx-1 text-[var(--color-brand)] underline" href="/inbox/settings#sending">Settings → Sending</Link>.
        </li>
        <li>
          <span className="font-medium">Drafts</span> — autosaved as you type.
          Find them in the sidebar under <Link className="text-[var(--color-brand)] underline" href="/inbox/drafts">Drafts</Link>.
        </li>
      </ul>
    </Section>
  );
}

function SchedulingSection() {
  return (
    <Section id="scheduling" title="Scheduling — booking links">
      <p>
        Booking links let people pick a time with you without the email
        back-and-forth: a public page shows your open slots and writes the
        confirmed meeting straight to your calendar. Manage them at
        <Link className="mx-1 text-[var(--color-brand)] underline" href="/scheduling">Scheduling</Link>
        — also linked from
        <Link className="mx-1 text-[var(--color-brand)] underline" href="/inbox/settings#scheduling">Settings → Scheduling</Link>.
      </p>

      <div>
        <div className="font-medium text-neutral-900 dark:text-neutral-100 mb-1">
          Create a booking link
        </div>
        <ol className="space-y-1">
          <Step>
            Open <Link className="text-[var(--color-brand)] underline" href="/scheduling">Scheduling</Link> and
            click <span className="font-medium">New booking link</span>.
          </Step>
          <Step>Give it a name and a meeting length, and choose which calendars feed availability — confirmed bookings are written there too.</Step>
          <Step>Set the booking window (how far ahead people can book), then save.</Step>
        </ol>
      </div>

      <div>
        <div className="font-medium text-neutral-900 dark:text-neutral-100 mb-1">
          Share it
        </div>
        <p>
          Every link has a public address like
          <code className="mx-1 px-1 rounded bg-neutral-100 dark:bg-neutral-900">/p/book/your-slug</code>.
          In the Scheduling list, click that path to copy the full URL, or
          click <span className="font-medium">Open</span> to preview the
          booking page. Anyone with the URL can book — no sign-in needed.
        </p>
      </div>

      <p className="text-neutral-500 text-xs">
        Availability uses your built-in calendars by default. If the
        deployment has Google Calendar enabled, you can connect it under
        <span className="font-medium"> Connected calendars</span> on the
        Scheduling page to also block out Google events and add a Meet link
        to every booking.
      </p>
    </Section>
  );
}

function OrganizingSection() {
  return (
    <Section id="organizing" title="Organizing threads">
      <ul className="ml-5 list-disc space-y-1.5">
        <li>
          <span className="font-medium">Star</span> and <span className="font-medium">Archive</span> from the
          thread header. Archived threads stay searchable but leave the inbox.
        </li>
        <li>
          <span className="font-medium">Labels</span> — apply via the label
          button in the thread header. Manage label colors at
          <Link className="mx-1 text-[var(--color-brand)] underline" href="/inbox/settings#labels">Settings → Labels</Link>.
        </li>
        <li>
          <span className="font-medium">Contacts</span> — every address you
          send to gets a contact row. View and edit at
          <Link className="mx-1 text-[var(--color-brand)] underline" href="/inbox/contacts">Contacts</Link>.
        </li>
      </ul>
    </Section>
  );
}

function BoardSection() {
  return (
    <Section id="board" title="Board view">
      <p>
        Every mailbox can be viewed as a Kanban board instead of a list — handy
        for a shared mailbox where the team needs to see what&apos;s untouched,
        in progress, and done at a glance. Open a mailbox and use the
        {" "}<span className="font-medium">List / Board</span> toggle in the
        inbox header to switch.
      </p>
      <ul className="ml-5 list-disc space-y-1.5">
        <li>
          <span className="font-medium">Cards and columns</span> — each
          conversation is a card; columns are statuses. A new board starts with
          {" "}<span className="font-medium">New</span>,{" "}
          <span className="font-medium">In progress</span>, and{" "}
          <span className="font-medium">Done</span>. Drag a card to another
          column to change its status.
        </li>
        <li>
          <span className="font-medium">Customizable columns</span> — add one
          with the &quot;+ Add column&quot; button, and use a column&apos;s
          {" "}<span className="font-medium">⋯</span> menu to rename or delete
          it. Drag a column header to reorder. Deleting a column moves its cards
          back to the first column.
        </li>
        <li>
          <span className="font-medium">Shared by the team</span> — columns and
          card placement belong to the mailbox, so everyone with access sees the
          same board.
        </li>
        <li>
          <span className="font-medium">Filters</span> — the{" "}
          <span className="font-medium">All / Unassigned / Assigned to me</span>
          {" "}chips narrow the board to the cards you care about. Assignment
          itself is unchanged — claim or assign a conversation from its header
          as usual; the board just reflects it.
        </li>
      </ul>
      <p className="text-neutral-500 text-xs">
        The board is per-mailbox. Cross-mailbox views like{" "}
        <span className="font-medium">All inboxes</span> stay list-only.
      </p>
    </Section>
  );
}

function SearchSection() {
  return (
    <Section id="search" title="Search">
      <p>
        The search bar at the top runs full-text search across subjects,
        snippets, and bodies of every thread you can read. On desktop you can
        scope the search to one mailbox via the dropdown next to the input; on
        mobile, search defaults to all mailboxes you have access to.
      </p>
    </Section>
  );
}

function MobileSection() {
  return (
    <Section id="mobile" title="On mobile">
      <ul className="ml-5 list-disc space-y-1.5">
        <li>The sidebar opens as a drawer — tap the ☰ button in the top-left.</li>
        <li>Tap a thread to open it; the back arrow in the thread header returns to the list.</li>
        <li>Compose opens full-screen. Tap outside or hit ✕ to dismiss; drafts autosave.</li>
        <li>iOS users: install to the home screen first to get push notifications and a real app feel.</li>
      </ul>
    </Section>
  );
}

function TroubleshootingSection() {
  return (
    <Section id="troubleshooting" title="Troubleshooting">
      <ul className="ml-5 list-disc space-y-1.5">
        <li>
          <span className="font-medium">&quot;Sign in required&quot; on every load</span> —
          the host domain needs a Cloudflare Access application in front of it.
          Without Access the app intentionally refuses requests.
        </li>
        <li>
          <span className="font-medium">No mail arriving</span> — confirm Email
          Routing is enabled on the domain and a rule sends inbound mail to the
          <code className="mx-1 px-1 rounded bg-neutral-100 dark:bg-neutral-900">orange-inbox-email</code>
          Worker. The catch-all rule is the simplest way.
        </li>
        <li>
          <span className="font-medium">Outbound send fails with &quot;recipient not verified&quot;</span> —
          Cloudflare requires the recipient be a verified destination on your
          account. Verify it from Email Routing → Destination addresses.
        </li>
        <li>
          <span className="font-medium">Push notifications don&apos;t arrive</span> —
          on iOS, the app must be installed to the home screen first. On all
          platforms, re-toggle in Settings → Notifications to re-subscribe.
        </li>
      </ul>
    </Section>
  );
}
