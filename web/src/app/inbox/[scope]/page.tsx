import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { listContactsForUser } from "@/lib/contacts";
import { listTemplatesForUser } from "@/lib/templates";
import { listAllIdentities, listIdentities } from "@/lib/identities";
import { listAliases, listObservedAliases } from "@/lib/aliases";
import {
  listAllDomains,
  listDomainsForUser,
  listSubscriptionsForUser,
  listVipAddresses,
} from "@/lib/queries";
import { listLabelsForUser } from "@/lib/labels";
import { getInboxLayout, listInboxLayouts } from "@/lib/inbox-layouts";
import { listSavedSearches } from "@/lib/saved-searches";
import AliasesManager from "@/components/AliasesManager";
import CalendarManager from "@/components/CalendarManager";
import ContactsManager from "@/components/ContactsManager";
import TemplatesManager from "@/components/TemplatesManager";
import SettingsManager from "@/components/SettingsManager";
import HelpManager from "@/components/HelpManager";
import ScheduledManager from "@/components/ScheduledManager";
import StorageManager from "@/components/StorageManager";
import SubscriptionsList from "@/components/SubscriptionsList";
import VipsManager from "@/components/VipsManager";
import MultiInboxLayout from "@/components/MultiInboxLayout";
import KanbanBoard from "@/components/KanbanBoard";

export default async function InboxIndex({
  params,
  searchParams,
}: {
  params: Promise<{ scope: string }>;
  searchParams: Promise<{ mailbox?: string; view?: string }>;
}) {
  const { scope } = await params;

  if (scope === "contacts") return <ContactsRoute searchParams={await searchParams} />;
  if (scope === "templates") return <TemplatesRoute />;
  if (scope === "subscriptions") return <SubscriptionsRoute />;
  if (scope === "settings") return <SettingsRoute />;
  if (scope === "help") return <HelpManager />;
  if (scope === "calendar") return <CalendarManager />;
  if (scope === "scheduled") return <ScheduledManager />;
  if (scope === "storage") return <StorageRoute />;
  if (scope === "vips") return <VipsRoute />;
  if (scope === "aliases") return <AliasesRoute />;
  if (scope.startsWith("layout:")) return <LayoutRoute scope={scope} />;

  // Board view (`?view=board`). Reached only for non-special scopes; for a
  // real mailbox id KanbanBoard renders the board, and for anything else
  // loadBoard returns null and the board shows its own "unavailable" notice.
  const { view } = await searchParams;
  if (view === "board") return <KanbanBoard mailboxId={scope} />;

  const message =
    scope === "drafts" ? "Select a draft to edit it." : "Select a thread to read it.";
  return (
    <div className="flex-1 flex items-center justify-center text-sm text-neutral-500">
      {message}
    </div>
  );
}

async function LayoutRoute({ scope }: { scope: string }) {
  const user = await getCurrentUser();
  if (!user) return null;
  const id = scope.slice("layout:".length);
  const layout = await getInboxLayout(id, user.id);
  if (!layout) {
    return (
      <div className="flex-1 flex items-center justify-center text-center px-6">
        <div className="max-w-md">
          <h1 className="text-base font-semibold mb-2">Layout not found</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            This layout was deleted or never existed. Try the{" "}
            <Link href="/inbox/all" className="text-[var(--color-brand)] underline">
              All inboxes view
            </Link>
            .
          </p>
        </div>
      </div>
    );
  }
  return <MultiInboxLayout layout={layout} userId={user.id} />;
}

async function ContactsRoute({ searchParams }: { searchParams: { mailbox?: string } }) {
  const user = await getCurrentUser();
  if (!user) return null;
  const filter = searchParams.mailbox ?? "all";
  const [identities, contacts] = await Promise.all([
    listIdentities(user.id),
    // Server-side filter when a specific mailbox is selected — saves shipping
    // a giant cross-mailbox list to the client just to throw most of it away.
    listContactsForUser(user.id, filter !== "all" ? filter : undefined),
  ]);
  // Contacts are per-mailbox; aliases ride on top of the mailbox so we don't
  // surface them as separate scope choices here (they'd collide on mailbox_id).
  const mailboxIdentities = identities.filter(i => i.kind === "mailbox");
  return <ContactsManager contacts={contacts} identities={mailboxIdentities} filter={filter} />;
}

async function VipsRoute() {
  const user = await getCurrentUser();
  if (!user) return null;
  const vips = await listVipAddresses(user.id);
  return <VipsManager initialVips={vips} />;
}

async function AliasesRoute() {
  const user = await getCurrentUser();
  if (!user) return null;
  // Both lists are scoped to mailboxes the user has owner/member access on,
  // so non-admins still get a useful page (their own promoted aliases +
  // observed candidates from their catch-alls).
  const [promoted, observed] = await Promise.all([
    listAliases(user.id),
    listObservedAliases(user.id),
  ]);
  return <AliasesManager initialPromoted={promoted} initialObserved={observed} />;
}

async function TemplatesRoute() {
  const user = await getCurrentUser();
  if (!user) return null;
  const [identities, templates] = await Promise.all([
    listIdentities(user.id),
    listTemplatesForUser(user.id),
  ]);
  // Shared templates attach to a mailbox, not an alias — same reasoning as
  // ContactsRoute: aliases inherit from the parent mailbox.
  const mailboxIdentities = identities.filter(i => i.kind === "mailbox");
  return <TemplatesManager templates={templates} identities={mailboxIdentities} />;
}

async function SubscriptionsRoute() {
  const user = await getCurrentUser();
  if (!user) return null;
  const subscriptions = await listSubscriptionsForUser(user.id);
  return <SubscriptionsList subscriptions={subscriptions} />;
}

async function SettingsRoute() {
  const user = await getCurrentUser();
  if (!user) return null;
  // Admins manage every domain and every mailbox; non-admins see only what
  // they have membership in (and the management UI below is hidden anyway).
  const [domains, labels, manageableIdentities, myIdentities, layouts, savedSearches] =
    await Promise.all([
      user.is_admin ? listAllDomains() : listDomainsForUser(user.id),
      listLabelsForUser(user.id),
      user.is_admin ? listAllIdentities() : listIdentities(user.id),
      listIdentities(user.id),
      listInboxLayouts(user.id),
      listSavedSearches(user.id),
    ]);
  // Signatures are personal-config: any user can edit signatures on mailboxes
  // *they own*, regardless of admin status. Aliases are filtered out here
  // because /api/mailboxes/<id>/signature is the per-mailbox endpoint;
  // alias signatures are managed from /inbox/aliases instead.
  const ownedIdentities = myIdentities.filter(
    i => i.role === "owner" && i.kind === "mailbox",
  );
  return (
    <SettingsManager
      domains={domains}
      initialLabels={labels}
      manageableIdentities={manageableIdentities}
      ownedIdentities={ownedIdentities}
      memberIdentities={myIdentities}
      isAdmin={user.is_admin}
      initialUndoSendSeconds={user.undo_send_seconds}
      initialInboxLayouts={layouts}
      savedSearches={savedSearches}
    />
  );
}

async function StorageRoute() {
  // Admin-only — non-admins get a friendly message rather than a 403, since
  // the link is hidden from them in the sidebar but the URL is still
  // reachable.
  const user = await getCurrentUser();
  if (!user) return null;
  if (!user.is_admin) {
    return (
      <div className="flex-1 flex items-center justify-center text-center px-6">
        <div className="max-w-md">
          <h1 className="text-base font-semibold mb-2">Admin only</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Storage Explorer is only available to admins. If you need it, ask
            an existing admin to add you in Settings.
          </p>
        </div>
      </div>
    );
  }
  return <StorageManager />;
}
