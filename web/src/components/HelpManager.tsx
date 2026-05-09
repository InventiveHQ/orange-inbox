import Link from "next/link";

// In-app help. Renders as a full-page scope (like Settings) so it has room
// for prose and is reachable from the sidebar without leaving the app.
export default function HelpManager() {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="px-4 py-4 sm:px-6 border-b border-neutral-200 dark:border-neutral-800">
        <h1 className="text-base font-semibold">Help</h1>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 space-y-12">
          <InstallSection />
          <NotificationsSection />
          <DomainsSection />
          <SharingSection />
          <ComposeSection />
          <OrganizingSection />
          <SearchSection />
          <MobileSection />
          <TroubleshootingSection />
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
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

function InstallSection() {
  return (
    <Section title="Installing on your phone">
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
    <Section title="Push notifications">
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
    <Section title="Adding mail domains">
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
    <Section title="Sharing a mailbox with someone">
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
    <Section title="Composing mail">
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
          <Link className="mx-1 text-[var(--color-brand)] underline" href="/scheduled">Scheduled</Link> and you can cancel
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

function OrganizingSection() {
  return (
    <Section title="Organizing threads">
      <ul className="ml-5 list-disc space-y-1.5">
        <li>
          <span className="font-medium">Star</span> and <span className="font-medium">Archive</span> from the
          thread header. Archived threads stay searchable but leave the inbox.
        </li>
        <li>
          <span className="font-medium">Snooze</span> — pick a future time and
          the thread leaves the inbox until then, when it returns marked unread.
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

function SearchSection() {
  return (
    <Section title="Search">
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
    <Section title="On mobile">
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
    <Section title="Troubleshooting">
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
