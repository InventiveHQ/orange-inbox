"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Props {
  threadId: string;
  initialStarred: boolean;
  initialArchived: boolean;
}

// Header actions: star toggle, archive toggle, and hard delete. All three
// hit /api/threads/{id}; archive and delete navigate away on success since
// the thread vanishes from the list view.
export default function ThreadActions({ threadId, initialStarred, initialArchived }: Props) {
  const router = useRouter();
  const [starred, setStarred] = useState(initialStarred);
  const [archived, setArchived] = useState(initialArchived);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function patch(body: Record<string, unknown>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/threads/${threadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      after?.();
      router.refresh();
    });
  }

  function toggleStar() {
    const next = !starred;
    setStarred(next);
    patch({ starred: next }, undefined);
  }

  function toggleArchive() {
    const next = !archived;
    setArchived(next);
    patch({ archived: next }, () => {
      // Archived threads are filtered from the list view — leave the now-
      // detached detail and go back to All. Un-archiving is rare and the
      // user can re-find it; we still navigate away for symmetry.
      router.push("/inbox/all");
    });
  }

  function deleteThread() {
    if (!confirm("Delete this thread? This permanently removes all messages and attachments.")) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/threads/${threadId}`, { method: "DELETE" });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      router.push("/inbox/all");
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-red-600">{error}</span>}
      <button
        type="button"
        onClick={toggleStar}
        disabled={isPending}
        aria-pressed={starred}
        title={starred ? "Unstar" : "Star"}
        className={`rounded-md border px-2 py-1.5 text-sm disabled:opacity-50 ${
          starred
            ? "border-yellow-400 bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300"
            : "border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900"
        }`}
      >
        {starred ? "★ Starred" : "☆ Star"}
      </button>
      <button
        type="button"
        onClick={toggleArchive}
        disabled={isPending}
        title={archived ? "Unarchive" : "Archive"}
        className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
      >
        {archived ? "Unarchive" : "Archive"}
      </button>
      <button
        type="button"
        onClick={deleteThread}
        disabled={isPending}
        title="Delete"
        className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
      >
        Delete
      </button>
    </div>
  );
}
