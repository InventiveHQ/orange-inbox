import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getThreadDetail } from "@/lib/queries";
import { markThreadRead } from "@/lib/threads-mutate";
import ThreadView from "@/components/ThreadView";

export default async function ThreadPage({
  params,
}: {
  params: Promise<{ scope: string; threadId: string }>;
}) {
  const { threadId } = await params;
  const user = await requireUser();
  const detail = await getThreadDetail(user.id, threadId);
  if (!detail) notFound();
  // Side-effect during render is fine here: this page is dynamic, the
  // mutation is idempotent, and it's auth-gated inside markThreadRead.
  await markThreadRead(user.id, threadId);
  return <ThreadView detail={detail} mailboxId={detail.thread.mailbox_id} />;
}
