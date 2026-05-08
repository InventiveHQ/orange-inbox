import { getCurrentUser } from "@/lib/auth";
import { listContactsForUser } from "@/lib/contacts";
import { listTemplatesForUser } from "@/lib/templates";
import { listIdentities } from "@/lib/identities";
import { listDomainsForUser } from "@/lib/queries";
import { listLabelsForUser } from "@/lib/labels";
import ContactsManager from "@/components/ContactsManager";
import TemplatesManager from "@/components/TemplatesManager";
import SettingsManager from "@/components/SettingsManager";

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
  const [domains, labels, identities] = await Promise.all([
    listDomainsForUser(user.id),
    listLabelsForUser(user.id),
    listIdentities(user.id),
  ]);
  // Only owners can edit a mailbox's signature.
  const ownedIdentities = identities.filter(i => i.role === "owner");
  return (
    <SettingsManager
      domains={domains}
      initialLabels={labels}
      ownedIdentities={ownedIdentities}
    />
  );
}
