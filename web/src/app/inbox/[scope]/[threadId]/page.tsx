import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getAssignment } from "@/lib/assignments";
import { promoteInvitesForThread } from "@/lib/calendar";
import { getThreadDetail, listVipAddresses } from "@/lib/queries";
import { listNotes } from "@/lib/thread-notes";
import { markThreadRead } from "@/lib/threads-mutate";
import {
  getContactForUser,
  getContactsLookup,
  listThreadsForContactEmail,
} from "@/lib/contacts";
import { listIdentities } from "@/lib/identities";
import ThreadView from "@/components/ThreadView";
import ContactDetail from "@/components/ContactDetail";
import MarkReadRefresh from "@/components/MarkReadRefresh";

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

  const [detail, vipAddrs, contacts, assignment, notes] = await Promise.all([
    getThreadDetail(user.id, threadId),
    listVipAddresses(user.id),
    getContactsLookup(user.id),
    // Team workflow (#27): assignment + notes SSR'd alongside detail so the
    // reader hydrates with the right state on first paint (no client flash).
    getAssignment(threadId),
    listNotes(threadId),
  ]);
  if (!detail) notFound();
  // Capture the pre-mutation unread state — used below to trigger a
  // router.refresh() in the client so the inbox layout (sidebar badges,
  // thread-list row weight) re-fetches with fresh counts.
  const wasUnread = detail.thread.unread_count > 0;
  // Side-effect during render is fine here: this page is dynamic, the
  // mutation is idempotent, and it's auth-gated inside markThreadRead.
  await markThreadRead(user.id, threadId);

  // Lazy promote any inbound invites in this thread to the user's
  // calendar_events (#77). Fire-and-forget — render must not block on the
  // write, and the function is idempotent so repeat opens are a no-op.
  // Errors are swallowed; the next open will retry the same INSERT.
  promoteInvitesForThread(
    user.id,
    detail.thread.mailbox_id,
    detail.messages.map(m => ({ id: m.id, calendar_event: m.calendar_event })),
  ).catch(err => console.warn("promoteInvitesForThread", err));
  return (
    <>
      {wasUnread && <MarkReadRefresh />}
      <ThreadView
        detail={detail}
        mailboxId={detail.thread.mailbox_id}
        vipAddrs={new Set(vipAddrs)}
        contacts={contacts}
        currentUserId={user.id}
        assignment={assignment}
        notes={notes}
      />
    </>
  );
}
