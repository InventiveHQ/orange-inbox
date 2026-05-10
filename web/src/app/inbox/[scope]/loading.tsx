import { ThreadListSkeleton } from "@/components/Skeletons";

// Mounted by Next.js while the layout's thread fetch is in flight. Renders
// just the list-column skeleton — the sidebar comes from a layout above us
// and stays interactive, so we only fill the middle column with placeholders.
export default function InboxScopeLoading() {
  return <ThreadListSkeleton rows={8} />;
}
