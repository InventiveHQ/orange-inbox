import { cookies, headers } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import {
  countAssignedToUser,
  listAssignedToUser,
  listDomainsForUser,
  listDueFollowups,
  listMailboxesForUser,
  listThreads,
  listVipThreads,
  type MessageCategory,
} from "@/lib/queries";
import { DEFAULT_QUADRANT, listThreadsForTriage } from "@/lib/triage";
import { listIdentities } from "@/lib/identities";
import { listDraftsForUser } from "@/lib/drafts";
import { listSavedSearches } from "@/lib/saved-searches";
import { listInboxLayouts } from "@/lib/inbox-layouts";
import { getUserPreferences } from "@/lib/preferences";
import Sidebar from "@/components/Sidebar";
import ThreadList from "@/components/ThreadList";
import DraftsList from "@/components/DraftsList";
import ComposeProvider from "@/components/ComposeProvider";
import { ToastProvider } from "@/components/ToastProvider";
import ComposeFromUrl from "@/components/ComposeFromUrl";
import SearchBar from "@/components/SearchBar";
import OfflineIndicator from "@/components/OfflineIndicator";
import MobileShell from "@/components/MobileShell";
import AppBadgeSync from "@/components/AppBadgeSync";
import KeyboardShortcuts from "@/components/KeyboardShortcuts";
import CommandPaletteShortcut from "@/components/CommandPaletteShortcut";

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

  const [
    domains,
    mailboxes,
    identities,
    savedSearches,
    inboxLayouts,
    prefs,
    cookieStore,
    headerStore,
    assignedCount,
  ] = await Promise.all([
    listDomainsForUser(user.id),
    listMailboxesForUser(user.id),
    listIdentities(user.id),
    listSavedSearches(user.id),
    listInboxLayouts(user.id),
    getUserPreferences(user.id),
    cookies(),
    headers(),
    // Sidebar badge for "Assigned to me" — keep with the rest of the layout
    // data fetches so it's a single round-trip from the layout's perspective.
    countAssignedToUser(user.id),
  ]);
  const sidebarCollapsed = cookieStore.get("sidebar-collapsed")?.value === "1";

  // Auto-categorization tabs (#68). Layouts can't read searchParams in this
  // Next, but the RSC request carries the URL on the `next-url` header so we
  // can fish out `?category=` ourselves. Falls back to `referer` for the
  // initial server render and to "primary" when neither is present. The
  // CategoryTabs client component calls router.refresh() after pushing so
  // the layout actually re-fetches with the new param.
  const categoryParam = readCategoryFromHeaders(headerStore);
  // Default open: this section is the whole point of the saved-search feature,
  // and it's empty for new users so collapsing-by-default would hide the
  // discoverability hint. Toggling writes a cookie that flips the default.
  const smartMailboxesOpen = cookieStore.get("smart-mailboxes-open")?.value !== "0";
  // Same default-open rationale for the multi-pane Layouts section.
  const inboxLayoutsOpen = cookieStore.get("inbox-layouts-open")?.value !== "0";

  // Validate the scope: "all", "vips", "drafts", "contacts", "templates",
  // "subscriptions", "settings", "help", "storage", "aliases", or a mailbox
  // the user has access to. Anything else falls back to "all" rather than
  // 404'ing the layout.
  const SPECIAL_SCOPES = new Set([
    "all",
    "vips",
    "assigned",
    "drafts",
    "contacts",
    "templates",
    "subscriptions",
    "settings",
    "help",
    "storage",
    "aliases",
    "calendar",
    "scheduled",
    // Follow-ups (issue #26): threads the user opted in for nudges that
    // have passed the per-thread day threshold without a reply. Listing
    // logic lives in queries.ts → listDueFollowups.
    "followups",
  ]);
  // `domain:<id>` is a unified view across every mailbox the user can read on
  // a given domain — picked up below in the listThreads filter. `layout:<id>`
  // is a multi-pane split view rendered by MultiInboxLayout (see below).
  // Each prefix is checked at scope-validation time so they coexist without
  // bleed between features.
  const domainScopeId = scope.startsWith("domain:") ? scope.slice("domain:".length) : null;
  const matchedDomain = domainScopeId ? domains.find(d => d.id === domainScopeId) ?? null : null;
  const layoutScopeId = scope.startsWith("layout:") ? scope.slice("layout:".length) : null;
  const matchedLayout = layoutScopeId
    ? inboxLayouts.find(l => l.id === layoutScopeId) ?? null
    : null;
  const isValidScope =
    SPECIAL_SCOPES.has(scope) ||
    mailboxes.some(mb => mb.id === scope) ||
    matchedDomain !== null ||
    matchedLayout !== null;
  const effectiveScope = isValidScope ? scope : "all";

  const isDrafts = effectiveScope === "drafts";
  const isVips = effectiveScope === "vips";
  const isFollowups = effectiveScope === "followups";
  const isAssigned = effectiveScope === "assigned";
  const isDomainScope = matchedDomain !== null && effectiveScope === scope;
  const isLayoutScope = matchedLayout !== null && effectiveScope === scope;
  // Full-page scopes own the main area — no middle column, no thread/draft fetch.
  // `layout:<id>` is treated as full-page too: the multi-pane MultiInboxLayout
  // *is* the main column, and children (thread reader) takes over once a row
  // is clicked into a /<threadId> URL.
  const isFullPage =
    effectiveScope === "contacts" ||
    effectiveScope === "templates" ||
    effectiveScope === "subscriptions" ||
    effectiveScope === "settings" ||
    effectiveScope === "help" ||
    effectiveScope === "storage" ||
    effectiveScope === "aliases" ||
    effectiveScope === "calendar" ||
    effectiveScope === "scheduled" ||
    isLayoutScope;
  const mailboxId =
    effectiveScope === "all" ||
    isDrafts ||
    isVips ||
    isFollowups ||
    isAssigned ||
    isFullPage ||
    isDomainScope ||
    isLayoutScope
      ? undefined
      : effectiveScope;

  const [threads, drafts] = await Promise.all([
    isDrafts || isFullPage
      ? Promise.resolve([])
      : isFollowups
        ? // Follow-ups (issue #26): threads opted into nudges that are now
          // overdue without a reply. Cross-mailbox by design.
          listDueFollowups(user.id)
        : isAssigned
        ? // Assigned-to-me (#27) spans every mailbox the user is a member of,
          // just like VIPs but filtered on thread_assignments.assignee_id.
          listAssignedToUser(user.id)
        : isVips
        ? // VIPs view spans every mailbox the user can read — see
          // listVipThreads. Cross-mailbox by design: VIPs are a per-user
          // concept, not per-mailbox.
          listVipThreads(user.id)
        : effectiveScope === "all"
          ? // Layouts can't read searchParams in this Next, so the SSR'd payload
            // is always the default quadrant. The client toggle re-navigates,
            // which re-renders the page; once a classifier exists this should
            // pick up the ?view= param via a wrapping page-level fetch.
            listThreadsForTriage(user.id, {
              quadrant: DEFAULT_QUADRANT,
              includeMuted: true,
              category: categoryParam,
            })
          : listThreads(user.id, {
              mailboxId,
              domainId: isDomainScope ? matchedDomain!.id : undefined,
              // Per-mailbox views hide muted threads; the unified "all" / domain
              // views show them so muted mail is still findable without leaving
              // the inbox UI.
              includeMuted: mailboxId === undefined,
              // Domain roll-ups don't render the category strip yet (the
              // semantics across multi-mailbox domains need more thought),
              // so don't filter on category there either.
              category: isDomainScope ? undefined : categoryParam,
            }),
    isDrafts ? listDraftsForUser(user.id) : Promise.resolve([]),
  ]);

  if (
    domains.length === 0 &&
    effectiveScope !== "settings" &&
    effectiveScope !== "help" &&
    effectiveScope !== "storage" &&
    effectiveScope !== "subscriptions" &&
    effectiveScope !== "aliases" &&
    effectiveScope !== "calendar" &&
    effectiveScope !== "scheduled"
  ) {
    return (
      <ToastProvider>
        <ComposeProvider
          identities={identities}
          undoSendSeconds={user.undo_send_seconds}
          defaultTrackOpens={prefs.default_track_opens}
        >
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
                inboxLayouts={inboxLayouts}
                initialSmartOpen={smartMailboxesOpen}
                assignedCount={assignedCount}
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
    : isVips
      ? "VIPs"
      : isFollowups
        ? "Follow-ups"
        : isAssigned
          ? "Assigned to me"
          : effectiveScope === "all"
          ? "All inboxes"
          : isDomainScope
            ? matchedDomain!.name
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
      <ComposeProvider
        identities={identities}
        undoSendSeconds={user.undo_send_seconds}
        defaultTrackOpens={prefs.default_track_opens}
      >
        <ComposeFromUrl />
        <AppBadgeSync />
        <KeyboardShortcuts />
        <CommandPaletteShortcut />
        <MobileShell
          sidebar={
            <Sidebar
              domains={domains}
              mailboxes={mailboxes}
              scope={effectiveScope}
              initialCollapsed={sidebarCollapsed}
              isAdmin={user.is_admin}
              savedSearches={savedSearches}
              inboxLayouts={inboxLayouts}
              initialSmartOpen={smartMailboxesOpen}
              initialLayoutsOpen={inboxLayoutsOpen}
              assignedCount={assignedCount}
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
      <div className="max-w-3xl flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <SearchBar mailboxes={mailboxes} defaultScope={scope} />
        </div>
        <OfflineIndicator />
      </div>
    </div>
  );
}

// Categories the auto-categorizer emits. Anything outside this set in the
// URL is silently ignored and we fall back to "primary".
const VALID_CATEGORIES: ReadonlySet<string> = new Set([
  "primary",
  "promotions",
  "updates",
  "social",
  "forums",
]);

function readCategoryFromHeaders(
  headerStore: Awaited<ReturnType<typeof headers>>,
): MessageCategory {
  // `next-url` is set by Next on RSC payload requests and carries the
  // pathname + search; this is the workaround for layouts not receiving
  // searchParams as a prop. Falls back to `referer` for the initial render
  // (which carries the full URL the browser asked for).
  const candidate =
    headerStore.get("next-url") ?? headerStore.get("referer") ?? null;
  if (!candidate) return "primary";
  let qs: string;
  try {
    // next-url is path+query; referer is a full URL. URL parsing handles
    // both when given a base.
    const u = new URL(candidate, "http://localhost");
    qs = u.search;
  } catch {
    return "primary";
  }
  const params = new URLSearchParams(qs);
  const raw = params.get("category");
  if (raw && VALID_CATEGORIES.has(raw)) return raw as MessageCategory;
  return "primary";
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
