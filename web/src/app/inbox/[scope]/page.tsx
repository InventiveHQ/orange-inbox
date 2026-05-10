import { getCurrentUser } from "@/lib/auth";
import { listContactsForUser } from "@/lib/contacts";
import { listTemplatesForUser } from "@/lib/templates";
import { listAllIdentities, listIdentities } from "@/lib/identities";
import { listAllDomains, listDomainsForUser, listVipAddresses } from "@/lib/queries";
import { listLabelsForUser } from "@/lib/labels";
import ContactsManager from "@/components/ContactsManager";
import TemplatesManager from "@/components/TemplatesManager";
import SettingsManager from "@/components/SettingsManager";
import HelpManager from "@/components/HelpManager";
import VipsManager from "@/components/VipsManager";

export default async function InboxIndex({
  params,
  searchParams,
}: {
  params: Promise<{ scope: string }>;
  searchParams: Promise<{ mailbox?: string }>;
}) {
  const { scope } = await params;

  if (scope === "contacts") return <ContactsRoute searchParams={await searchParams} />;
  if (scope === "templates") return <TemplatesRoute />;
  if (scope === "settings") return <SettingsRoute />;
  if (scope === "help") return <HelpManager />;
  if (scope === "vips") return <VipsRoute />;

  const message =
    scope === "drafts" ? "Select a draft to edit it." : "Select a thread to read it.";
  return (
    <div className="flex-1 flex items-center justify-center text-sm text-neutral-500">
      {message}
    </div>
  );
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
  return <ContactsManager contacts={contacts} identities={identities} filter={filter} />;
}

async function VipsRoute() {
  const user = await getCurrentUser();
  if (!user) return null;
  const vips = await listVipAddresses(user.id);
  return <VipsManager initialVips={vips} />;
}

async function TemplatesRoute() {
  const user = await getCurrentUser();
  if (!user) return null;
  const [identities, templates] = await Promise.all([
    listIdentities(user.id),
    listTemplatesForUser(user.id),
  ]);
  return <TemplatesManager templates={templates} identities={identities} />;
}

async function SettingsRoute() {
  const user = await getCurrentUser();
  if (!user) return null;
  // Admins manage every domain and every mailbox; non-admins see only what
  // they have membership in (and the management UI below is hidden anyway).
  const [domains, labels, manageableIdentities, myIdentities] = await Promise.all([
    user.is_admin ? listAllDomains() : listDomainsForUser(user.id),
    listLabelsForUser(user.id),
    user.is_admin ? listAllIdentities() : listIdentities(user.id),
    listIdentities(user.id),
  ]);
  // Signatures are personal-config: any user can edit signatures on mailboxes
  // *they own*, regardless of admin status.
  const ownedIdentities = myIdentities.filter(i => i.role === "owner");
  return (
    <SettingsManager
      domains={domains}
      initialLabels={labels}
      manageableIdentities={manageableIdentities}
      ownedIdentities={ownedIdentities}
      isAdmin={user.is_admin}
      initialUndoSendSeconds={user.undo_send_seconds}
    />
  );
}
