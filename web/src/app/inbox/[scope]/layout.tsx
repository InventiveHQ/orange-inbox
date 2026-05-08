import { getCurrentUser } from "@/lib/auth";
import { listDomainsForUser, listMailboxesForUser, listThreads } from "@/lib/queries";
import { listIdentities } from "@/lib/identities";
import { listDraftsForUser } from "@/lib/drafts";
import Sidebar from "@/components/Sidebar";
import ThreadList from "@/components/ThreadList";
import DraftsList from "@/components/DraftsList";
import ComposeProvider from "@/components/ComposeProvider";

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

  const [domains, mailboxes, identities] = await Promise.all([
    listDomainsForUser(user.id),
    listMailboxesForUser(user.id),
    listIdentities(user.id),
  ]);

  // Validate the scope: "all", "drafts", "contacts", "templates", or a mailbox
  // the user has access to. Anything else falls back to "all" rather than
  // 404'ing the layout.
  const SPECIAL_SCOPES = new Set(["all", "drafts", "contacts", "templates"]);
  const isValidScope = SPECIAL_SCOPES.has(scope) || mailboxes.some(mb => mb.id === scope);
  const effectiveScope = isValidScope ? scope : "all";

  const isDrafts = effectiveScope === "drafts";
  // Contacts and templates use the full main area — no middle column, no
  // thread/draft fetch needed.
  const isFullPage = effectiveScope === "contacts" || effectiveScope === "templates";
  const mailboxId =
    effectiveScope === "all" || isDrafts || isFullPage ? undefined : effectiveScope;

  const [threads, drafts] = await Promise.all([
    isDrafts || isFullPage ? Promise.resolve([]) : listThreads(user.id, { mailboxId }),
    isDrafts ? listDraftsForUser(user.id) : Promise.resolve([]),
  ]);

  if (domains.length === 0) {
    return (
      <ComposeProvider identities={identities}>
        <div className="flex h-screen">
          <Sidebar domains={[]} mailboxes={[]} scope={effectiveScope} />
          <FirstMailboxPrompt />
        </div>
      </ComposeProvider>
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

  return (
    <ComposeProvider identities={identities}>
      <div className="flex h-screen">
        <Sidebar domains={domains} mailboxes={mailboxes} scope={effectiveScope} />
        {!isFullPage && (
          <section className="w-96 shrink-0 border-r border-neutral-200 dark:border-neutral-800 flex flex-col">
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
          </section>
        )}
        <main className="flex-1 flex flex-col overflow-hidden">{children}</main>
      </div>
    </ComposeProvider>
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
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Use the “+ Add mail domain” button in the sidebar. Adding a domain creates a
          default catch-all mailbox you own. Once Email Routing on that domain points at
          the orange-inbox-email Worker, mail starts landing here.
        </p>
      </div>
    </div>
  );
}
