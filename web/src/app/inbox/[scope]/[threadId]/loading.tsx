import { ThreadDetailSkeleton } from "@/components/Skeletons";

// Mounted by Next.js while the thread detail page fetches messages,
// attachments, contacts, and VIPs. The sidebar + thread list (from the
// layout above) remain interactive while this skeleton fills the reader
// pane.
export default function ThreadDetailLoading() {
  return <ThreadDetailSkeleton />;
}
