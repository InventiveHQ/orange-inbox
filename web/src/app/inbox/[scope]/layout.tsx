import { cookies, headers } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import {
  countAssignedToUser,
  countRecentAutoArchived,
  listAssignedToUser,
  listDomainsForUser,
  listDueFollowups,
  listMailboxesForUser,
  listSpamReportedThreads,
  listStarredThreads,
  listThreads,
  listVipThreads,
  type MessageCategory,
} from "@/lib/queries";
import { listAssignedToUserResolved } from "@/lib/assignments";
import AssignmentStatusTabs, {
  parseAssignmentStatus,
  type AssignmentStatus,
} from "@/components/AssignmentStatusTabs";
import ResolvedAssignmentsList from "@/components/ResolvedAssignmentsList";
import {
  DEFAULT_QUADRANT,
  parseQuadrant,
  type TriageQuadrant,
  listThreadsForTriage,
} from "@/lib/triage";
import { listIdentities } from "@/lib/identities";
import { listDraftsForUser } from "@/lib/drafts";
import { listSavedSearches } from "@/lib/saved-searches";
import { listInboxLayouts } from "@/lib/inbox-layouts";
import { getUserPreferences } from "@/lib/preferences";
import Sidebar from "@/components/Sidebar";
import ThreadList from "@/components/ThreadList";
import AutoArchiveDigest from "@/components/AutoArchiveDigest";
import TriageDeck from "@/components/TriageDeck";
import EventComposerProvider from "@/components/EventComposerProvider";
import DraftsList from "@/components/DraftsList";
import ComposeProvider from "@/components/ComposeProvider";
import { DismissedThreadsProvider } from "@/components/DismissedThreadsProvider";
import { ToastProvider } from "@/components/ToastProvider";
import ComposeFromUrl from "@/components/ComposeFromUrl";
import SearchBar from "@/components/SearchBar";
import OfflineIndicator from "@/components/OfflineIndicator";
import MobileShell from "@/components/MobileShell";
import AppBadgeSync from "@/components/AppBadgeSync";
import KeyboardShortcuts from "@/components/KeyboardShortcuts";
import CommandPaletteShortcut from "@/components/CommandPaletteShortcut";
import KanbanViewToggle from "@/components/KanbanViewToggle";
import { CalendarUIProvider } from "@/components/CalendarUIContext";
import { ContactsUIProvider } from "@/components/ContactsUIContext";
import CalendarSidebarBody from "@/components/sidebar/CalendarSidebarBody";
import ContactsSidebarBody from "@/components/sidebar/ContactsSidebarBody";
import SettingsSidebarBody from "@/components/sidebar/SettingsSidebarBody";
import HelpSidebarBody from "@/components/sidebar/HelpSidebarBody";
import { buildSettingsSections } from "@/lib/settings-sections";

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
  // Triage quadrant (#3 + #7). Same `next-url` workaround as category — the
  // triage bar's client toggle pushes ?view=… and router.refresh()es, so the
  // RSC payload sees the new param on the next render.
  const quadrantParam = readQuadrantFromHeaders(headerStore);
  // Assignment status tab (#99). Same next-url workaround — `?status=resolved`
  // on /inbox/assigned switches the list query from active to resolved.
  const assignmentStatus = readAssignmentStatusFromHeaders(headerStore);
  // Board view. `?view=board` on a mailbox scope swaps the chronological list
  // for the Kanban board — a full-page view, the same shape as layout:<id>.
  const boardViewRequested = readViewParamFromHeaders(headerStore) === "board";
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
    // Follow-ups (issue #26): threads the user opted into follow-up that
    // have passed the per-thread day threshold without a reply. Listing
    // logic lives in queries.ts → listDueFollowups.
    "followups",
    // Spam (issue #74): threads the user reported as spam. Reported-spam
    // messages are auto-archived, so this scope is the only place to
    // review/restore them. Listing logic in queries.ts → listSpamReportedThreads.
    "spam",
    // Starred: threads the user has hit ★ on. Cross-mailbox, includes
    // archived rows (starring is how users save things to revisit).
    "starred",
    // Archived view (issue #125): dedicated browse / restore surface for
    // archived threads. The default inbox listing hides archived, so this
    // scope is the only place to see them on their own.
    "archived",
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
  const isSpam = effectiveScope === "spam";
  const isStarred = effectiveScope === "starred";
  const isArchived = effectiveScope === "archived";
  const isDomainScope = matchedDomain !== null && effectiveScope === scope;
  const isLayoutScope = matchedLayout !== null && effectiveScope === scope;
  // Board view is only offered on a single mailbox scope — the board owns a
  // mailbox-specific column set (see lib/kanban.ts).
  const isMailboxScope = mailboxes.some(mb => mb.id === effectiveScope);
  const isBoardView = isMailboxScope && boardViewRequested;
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
    isLayoutScope ||
    isBoardView;
  const mailboxId =
    effectiveScope === "all" ||
    isDrafts ||
    isVips ||
    isFollowups ||
    isAssigned ||
    isSpam ||
    isStarred ||
    isArchived ||
    isFullPage ||
    isDomainScope ||
    isLayoutScope
      ? undefined
      : effectiveScope;

  // Resolved-history tab (#99) on /inbox/assigned. Fetched separately from
  // the main `threads` array because the row shape is different (resolved
  // metadata + Reopen action) and rendered by ResolvedAssignmentsList rather
  // than ThreadList.
  const showResolvedAssignments = isAssigned && assignmentStatus === "resolved";

  const [threads, drafts, resolvedAssignments] = await Promise.all([
    isDrafts || isFullPage
      ? Promise.resolve([])
      : isFollowups
        ? // Follow-ups (issue #26): threads opted into follow-up that are
          // now overdue without a reply. Cross-mailbox by design.
          listDueFollowups(user.id)
        : isAssigned
        ? showResolvedAssignments
          ? // The resolved tab uses its own list component — keep `threads`
            // empty here so the active ThreadList doesn't briefly render.
            Promise.resolve([])
          : // Assigned-to-me (#27) spans every mailbox the user is a member of,
            // just like VIPs but filtered on thread_assignments.assignee_id.
            listAssignedToUser(user.id)
        : isSpam
        ? // Spam (#74) spans every mailbox — reported-spam messages were
          // auto-archived so this view is the only place to review them.
          listSpamReportedThreads(user.id)
        : isStarred
        ? // Starred view — cross-mailbox listing of every thread the user
          // has hit ★ on. Includes archived rows so it doubles as a
          // "saved for later" stash. See listStarredThreads.
          listStarredThreads(user.id)
        : isArchived
        ? // Archived view (#125): only archived threads — cross-mailbox so
          // anything the user has previously archived is findable in one
          // place, with includeMuted so muted-and-archived rows surface too.
          listThreads(user.id, { archivedOnly: true, includeMuted: true })
        : isVips
        ? // VIPs view spans every mailbox the user can read — see
          // listVipThreads. Cross-mailbox by design: VIPs are a per-user
          // concept, not per-mailbox.
          listVipThreads(user.id)
        : effectiveScope === "all"
          ? // The triage bar's client toggle pushes ?view=<quadrant> and
            // router.refresh()es. We read the param off `next-url` /
            // `referer` headers (same workaround as ?category=) since
            // layouts can't see searchParams as a prop.
            //
            // When the triage quadrant is "all" (Show all), drop the
            // category filter too — otherwise the implicit
            // category=primary default would hide every non-primary
            // thread and "Show all" would render inbox-zero for users
            // whose mail is mostly auto-categorised as promotions /
            // updates / social.
            listThreadsForTriage(user.id, {
              quadrant: quadrantParam,
              includeMuted: true,
              // The unified "All inboxes" scope is meant to surface every
              // thread the user has access to — archived included. Deriving
              // this from quadrantParam was unreliable: layouts can't see
              // searchParams, and the next-url/referer header workaround
              // doesn't survive every router.refresh() so the layout often
              // saw a stale quadrant and gated archived back out. Always
              // including archived here keeps the listing consistent; the
              // triage tabs still narrow the result by content (Primary
              // action filters by (is_marketing=0, is_action_item=1) etc.).
              includeArchived: true,
              // Same rationale for category: the unified view doesn't apply
              // the implicit category=primary default — the triage tabs are
              // what should narrow this view.
              category: undefined,
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
    showResolvedAssignments
      ? listAssignedToUserResolved(user.id)
      : Promise.resolve([]),
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
          : isSpam
          ? "Spam"
          : isStarred
          ? "Starred"
          : isArchived
          ? "Archived"
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

  // Context-aware drawer (#TBD): /inbox/calendar, /inbox/contacts, and
  // /inbox/settings render their section controls inside the global
  // Sidebar's `sectionBody` slot instead of as in-page chrome. The
  // mail-nav block (All inboxes / Mailboxes / Layouts / Smart
  // Mailboxes) is hidden while one of these is active; the bottom
  // utility row stays so users can still jump between sections.
  const calendarMode = effectiveScope === "calendar";
  const contactsMode = effectiveScope === "contacts";
  const settingsMode = effectiveScope === "settings";
  const helpMode = effectiveScope === "help";
  const mailboxIdentities = identities.filter(i => i.kind === "mailbox");
  const settingsSections = settingsMode
    ? buildSettingsSections({
        isAdmin: user.is_admin,
        // Mirror the same flag derivation used by SettingsRoute in
        // page.tsx — drawer must hide the same rows the in-page list
        // would have hidden, otherwise the drawer would link to
        // anchors that don't exist.
        hasOwnedMailboxes: identities.some(
          i => i.role === "owner" && i.kind === "mailbox",
        ),
        hasAuditAccess: identities.some(i => i.kind === "mailbox"),
      })
    : null;
  const sectionBody: React.ReactNode = calendarMode ? (
    <CalendarSidebarBody />
  ) : contactsMode ? (
    <ContactsSidebarBody />
  ) : settingsMode && settingsSections ? (
    <SettingsSidebarBody sections={settingsSections} />
  ) : helpMode ? (
    <HelpSidebarBody />
  ) : null;
  const initialContactsMailbox = readMailboxParamFromHeaders(headerStore);

  // Auto-archive digest (0055). Only meaningful on the unified inbox and only
  // for users who opted in — skip the extra count query otherwise. 24h window.
  const autoArchivedDigestCount =
    effectiveScope === "all" && prefs.auto_archive_marketing
      ? await countRecentAutoArchived(user.id, 24 * 60 * 60)
      : 0;

  const listContent = isFullPage ? null : (
    <>
      <header className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center gap-2">
        <span className="text-sm font-medium truncate">{scopeLabel}</span>
        {isMailboxScope && (
          <div className="ml-auto">
            <KanbanViewToggle />
          </div>
        )}
      </header>
      {isAssigned && <AssignmentStatusTabs />}
      {isDrafts ? (
        <DraftsList drafts={drafts} />
      ) : showResolvedAssignments ? (
        <ResolvedAssignmentsList items={resolvedAssignments} />
      ) : (
        <>
          <AutoArchiveDigest count={autoArchivedDigestCount} />
          <ThreadList
            threads={threads}
            scope={effectiveScope}
            showDomain={effectiveScope === "all"}
          />
        </>
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
        <DismissedThreadsProvider>
        <ComposeFromUrl />
        <AppBadgeSync />
        <KeyboardShortcuts />
        <CommandPaletteShortcut />
        <TriageDeck />
        <EventComposerProvider>
        <SectionDrawerWrap
          mode={
            calendarMode
              ? "calendar"
              : contactsMode
                ? "contacts"
                : "none"
          }
          contactsIdentities={mailboxIdentities}
          initialContactsMailbox={initialContactsMailbox}
        >
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
                sectionBody={sectionBody}
              />
            }
            topBar={<TopBar mailboxes={searchMailboxes} scope={effectiveScope} />}
            list={listContent}
            main={children}
          />
        </SectionDrawerWrap>
        </EventComposerProvider>
        </DismissedThreadsProvider>
      </ComposeProvider>
    </ToastProvider>
  );
}

// Conditionally wraps the layout body in the section's UI context
// provider. Calendar and Contacts both have a drawer body that needs
// to share state with the page body — the provider hosts that. Settings
// doesn't need one (its drawer is purely scroll-anchor based).
function SectionDrawerWrap({
  mode,
  contactsIdentities,
  initialContactsMailbox,
  children,
}: {
  mode: "calendar" | "contacts" | "none";
  contactsIdentities: Awaited<ReturnType<typeof listIdentities>>;
  initialContactsMailbox: string;
  children: React.ReactNode;
}) {
  if (mode === "calendar") return <CalendarUIProvider>{children}</CalendarUIProvider>;
  if (mode === "contacts") {
    return (
      <ContactsUIProvider
        identities={contactsIdentities}
        initialMailboxFilter={initialContactsMailbox}
      >
        {children}
      </ContactsUIProvider>
    );
  }
  return <>{children}</>;
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

function readQuadrantFromHeaders(
  headerStore: Awaited<ReturnType<typeof headers>>,
): TriageQuadrant {
  const candidate =
    headerStore.get("next-url") ?? headerStore.get("referer") ?? null;
  if (!candidate) return DEFAULT_QUADRANT;
  try {
    const u = new URL(candidate, "http://localhost");
    return parseQuadrant(u.searchParams.get("view"));
  } catch {
    return DEFAULT_QUADRANT;
  }
}

function readAssignmentStatusFromHeaders(
  headerStore: Awaited<ReturnType<typeof headers>>,
): AssignmentStatus {
  const candidate =
    headerStore.get("next-url") ?? headerStore.get("referer") ?? null;
  if (!candidate) return "active";
  try {
    const u = new URL(candidate, "http://localhost");
    return parseAssignmentStatus(u.searchParams.get("status"));
  } catch {
    return "active";
  }
}

function readViewParamFromHeaders(
  headerStore: Awaited<ReturnType<typeof headers>>,
): string | null {
  const candidate =
    headerStore.get("next-url") ?? headerStore.get("referer") ?? null;
  if (!candidate) return null;
  try {
    const u = new URL(candidate, "http://localhost");
    return u.searchParams.get("view");
  } catch {
    return null;
  }
}

function readMailboxParamFromHeaders(
  headerStore: Awaited<ReturnType<typeof headers>>,
): string {
  const candidate =
    headerStore.get("next-url") ?? headerStore.get("referer") ?? null;
  if (!candidate) return "all";
  try {
    const u = new URL(candidate, "http://localhost");
    return u.searchParams.get("mailbox") ?? "all";
  } catch {
    return "all";
  }
}

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
