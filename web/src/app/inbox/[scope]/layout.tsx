import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { listDomainsForUser, listMailboxesForUser, listThreads } from "@/lib/queries";
import { DEFAULT_QUADRANT, listThreadsForTriage } from "@/lib/triage";
import { listIdentities } from "@/lib/identities";
import { listDraftsForUser } from "@/lib/drafts";
import { listSavedSearches } from "@/lib/saved-searches";
import Sidebar from "@/components/Sidebar";
import ThreadList from "@/components/ThreadList";
import DraftsList from "@/components/DraftsList";
import ComposeProvider from "@/components/ComposeProvider";
import { ToastProvider } from "@/components/ToastProvider";
import ComposeFromUrl from "@/components/ComposeFromUrl";
import SearchBar from "@/components/SearchBar";
import MobileShell from "@/components/MobileShell";
import AppBadgeSync from "@/components/AppBadgeSync";
import KeyboardShortcuts from "@/components/KeyboardShortcuts";

export default async function InboxLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ scope: string }>;
}) {
  const { scope } = await params;
  const user = await getCurrentUser();
  if (!user) return <SignInPrompt />;

  const [domains, mailboxes, identities, savedSearches, cookieStore] = await Promise.all([
    listDomainsForUser(user.id),
    listMailboxesForUser(user.id),
    listIdentities(user.id),
    listSavedSearches(user.id),
    cookies(),
  ]);
  const sidebarCollapsed = cookieStore.get("sidebar-collapsed")?.value === "1";
  // Default open: this section is the whole point of the saved-search feature,
  // and it's empty for new users so collapsing-by-default would hide the
  // discoverability hint. Toggling writes a cookie that flips the default.
  const smartMailboxesOpen = cookieStore.get("smart-mailboxes-open")?.value !== "0";

  // Validate the scope: "all", "drafts", "contacts", "templates",
  // "subscriptions", "settings", "help", "storage", or a mailbox the user
  // has access to. Anything else falls back to "all" rather than 404'ing
  // the layout.
  const SPECIAL_SCOPES = new Set([
    "all",
    "drafts",
    "contacts",
    "templates",
    "subscriptions",
    "settings",
    "help",
    "storage",
  ]);
  const isValidScope = SPECIAL_SCOPES.has(scope) || mailboxes.some(mb => mb.id === scope);
  const effectiveScope = isValidScope ? scope : "all";

  const isDrafts = effectiveScope === "drafts";
  // Full-page scopes own the main area — no middle column, no thread/draft fetch.
  const isFullPage =
    effectiveScope === "contacts" ||
    effectiveScope === "templates" ||
    effectiveScope === "subscriptions" ||
    effectiveScope === "settings" ||
    effectiveScope === "help" ||
    effectiveScope === "storage";
  const mailboxId =
    effectiveScope === "all" || isDrafts || isFullPage ? undefined : effectiveScope;

  const [threads, drafts] = await Promise.all([
    isDrafts || isFullPage
      ? Promise.resolve([])
      : effectiveScope === "all"
        ? // Layouts can't read searchParams in this Next, so the SSR'd payload
          // is always the default quadrant. The client toggle re-navigates,
          // which re-renders the page; once a classifier exists this should
          // pick up the ?view= param via a wrapping page-level fetch.
          listThreadsForTriage(user.id, {
            quadrant: DEFAULT_QUADRANT,
            includeMuted: true,
          })
        : listThreads(user.id, {
            mailboxId,
            // Per-mailbox views hide muted threads; the unified "all" view
            // shows them so muted mail is still findable without leaving the
            // inbox UI.
            includeMuted: mailboxId === undefined,
          }),
    isDrafts ? listDraftsForUser(user.id) : Promise.resolve([]),
  ]);

  if (
    domains.length === 0 &&
    effectiveScope !== "settings" &&
    effectiveScope !== "help" &&
    effectiveScope !== "storage" &&
    effectiveScope !== "subscriptions"
  ) {
    return (
      <ToastProvider>
        <ComposeProvider identities={identities} undoSendSeconds={user.undo_send_seconds}>
          <ComposeFromUrl />
          <AppBadgeSync />
          <MobileShell
            sidebar={
              <Sidebar
                domains={[]}
                mailboxes={[]}
                scope={effectiveScope}
                initialCollapsed={sidebarCollapsed}
                isAdmin={user.is_admin}
                savedSearches={savedSearches}
                initialSmartOpen={smartMailboxesOpen}
              />
            }
            topBar={<TopBar mailboxes={[]} scope={effectiveScope} />}
            list={null}
            main={<FirstMailboxPrompt />}
          />
        </ComposeProvider>
      </ToastProvider>
    );
  }

  const scopeLabel = isDrafts
    ? "Drafts"
    : effectiveScope === "all"
      ? "All inboxes"
      : (() => {
          const mb = mailboxes.find(m => m.id === effectiveScope);
          return mb ? `${mb.local_part}@${mb.domain_name}` : "Inbox";
        })();

  const searchMailboxes = mailboxes.map(mb => ({
    id: mb.id,
    local_part: mb.local_part,
    domain_name: mb.domain_name,
  }));

  const listContent = isFullPage ? null : (
    <>
      <header className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 text-sm font-medium">
        {scopeLabel}
      </header>
      {isDrafts ? (
        <DraftsList drafts={drafts} />
      ) : (
        <ThreadList
          threads={threads}
          scope={effectiveScope}
          showDomain={effectiveScope === "all"}
        />
      )}
    </>
  );

  return (
    <ToastProvider>
      <ComposeProvider identities={identities} undoSendSeconds={user.undo_send_seconds}>
        <ComposeFromUrl />
        <AppBadgeSync />
        <KeyboardShortcuts />
        <MobileShell
          sidebar={
            <Sidebar
              domains={domains}
              mailboxes={mailboxes}
              scope={effectiveScope}
              initialCollapsed={sidebarCollapsed}
              isAdmin={user.is_admin}
              savedSearches={savedSearches}
              initialSmartOpen={smartMailboxesOpen}
            />
          }
          topBar={<TopBar mailboxes={searchMailboxes} scope={effectiveScope} />}
          list={listContent}
          main={children}
        />
      </ComposeProvider>
    </ToastProvider>
  );
}

interface SearchMailbox {
  id: string;
  local_part: string;
  domain_name: string;
}

function TopBar({ mailboxes, scope }: { mailboxes: SearchMailbox[]; scope: string }) {
  return (
    <div className="px-3 py-2 sm:px-4">
      <div className="max-w-3xl">
        <SearchBar mailboxes={mailboxes} defaultScope={scope} />
      </div>
    </div>
  );
}

function SignInPrompt() {
  return (
    <div className="flex h-screen items-center justify-center text-center px-6">
      <div className="max-w-md">
        <h1 className="text-xl font-semibold mb-2">Sign in required</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          orange-inbox expects Cloudflare Access in front of the host Worker. In production,
          Access redirects unauthenticated users to log in. For local development, set the
          <code className="mx-1 px-1.5 py-0.5 bg-neutral-200 dark:bg-neutral-800 rounded">DEV_USER_EMAIL</code>
          environment variable.
        </p>
      </div>
    </div>
  );
}

function FirstMailboxPrompt() {
  return (
    <div className="flex-1 flex items-center justify-center text-center px-6">
      <div className="max-w-md">
        <h2 className="text-lg font-semibold mb-2">Add your first mail domain</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
          Open <a href="/inbox/settings" className="text-[var(--color-brand)] underline">Settings</a> to
          add a mail domain. Adding a domain creates a default catch-all mailbox you own. Once
          Email Routing on that domain points at the orange-inbox-email Worker, mail starts
          landing here.
        </p>
      </div>
    </div>
  );
}
