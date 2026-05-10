import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getThreadDetail, listVipAddresses } from "@/lib/queries";
import { markThreadRead } from "@/lib/threads-mutate";
import {
  getContactForUser,
  listThreadsForContactEmail,
} from "@/lib/contacts";
import { listIdentities } from "@/lib/identities";
import ThreadView from "@/components/ThreadView";
import ContactDetail from "@/components/ContactDetail";

export default async function ScopedDetailPage({
  params,
}: {
  params: Promise<{ scope: string; threadId: string }>;
}) {
  const { scope, threadId } = await params;
  const user = await requireUser();

  // /inbox/contacts/<id> shares this dynamic segment with thread detail —
  // branch up front so we don't try to load a thread for a contact uuid.
  if (scope === "contacts") {
    const contact = await getContactForUser(user.id, threadId);
    if (!contact) notFound();
    const [threads, identities] = await Promise.all([
      listThreadsForContactEmail(user.id, contact.email),
      listIdentities(user.id),
    ]);
    // ContactDetail's mailbox picker only deals with mailbox-scoped contacts;
    // alias identities share their parent mailbox so listing them would
    // duplicate options.
    const mailboxIdentities = identities.filter(i => i.kind === "mailbox");
    return (
      <ContactDetail contact={contact} threads={threads} identities={mailboxIdentities} />
    );
  }

  const [detail, vipAddrs] = await Promise.all([
    getThreadDetail(user.id, threadId),
    listVipAddresses(user.id),
  ]);
  if (!detail) notFound();
  // Side-effect during render is fine here: this page is dynamic, the
  // mutation is idempotent, and it's auth-gated inside markThreadRead.
  await markThreadRead(user.id, threadId);
  return (
    <ThreadView
      detail={detail}
      mailboxId={detail.thread.mailbox_id}
      vipAddrs={new Set(vipAddrs)}
    />
  );
}
