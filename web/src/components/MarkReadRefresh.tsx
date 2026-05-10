"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Renders nothing; on mount, triggers a router.refresh() so the inbox layout
// (sidebar unread badges, thread-list row bold/regular) re-fetches with the
// post-markThreadRead state.
//
// The parent only renders this when the thread *was* unread on entry, so the
// refreshed render won't include this component again — no infinite loop.
export default function MarkReadRefresh() {
  const router = useRouter();
  useEffect(() => {
    router.refresh();
  }, [router]);
  return null;
}
