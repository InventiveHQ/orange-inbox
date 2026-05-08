import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getThreadDetail } from "@/lib/queries";
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
  return <ThreadView detail={detail} />;
}
