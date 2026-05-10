"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "./ToastProvider";
import UndoToast from "./UndoToast";

interface Props {
  threadId: string;
  initialStarred: boolean;
  initialArchived: boolean;
  initialMuted: boolean;
  initialPinned: boolean;
}

// Window during which the user can hit Undo. Mirrors Gmail's "Conversation
// archived" toast cadence; long enough to be a safety net, short enough that
// repeated archives don't pile up.
const UNDO_WINDOW_SECONDS = 6;

type PendingAction =
  | { kind: "archive"; previousArchived: boolean }
  | { kind: "delete" };

// Header actions: star toggle, archive, mute, delete. Star and mute are
// plain optimistic toggles. Archive and delete go through an undo-toast
// pattern:
//
//   - Archive fires the PATCH immediately (the operation is reversible
//     server-side via the same endpoint with `{archived: false}`). If the
//     undo window expires the user is bounced to /inbox/all, since the
//     archived thread no longer belongs in the current scope's list.
//   - Delete defers the actual DELETE until the undo window expires —
//     the irreversibility means we'd rather not call the server at all
//     than try to soft-undelete after the fact. While the toast is up the
//     thread is hidden behind a "Conversation deleted" placeholder.
export default function ThreadActions({
  threadId,
  initialStarred,
  initialArchived,
  initialMuted,
  initialPinned,
}: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [starred, setStarred] = useState(initialStarred);
  const [archived, setArchived] = useState(initialArchived);
  const [muted, setMuted] = useState(initialMuted);
  const [pinned, setPinned] = useState(initialPinned);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [isStarPending, startStarTransition] = useTransition();
  const [isMutePending, startMuteTransition] = useTransition();
  const [isPinPending, startPinTransition] = useTransition();

  function toggleStar() {
    const next = !starred;
    setStarred(next);
    setError(null);
    startStarTransition(async () => {
      const res = await fetch(`/api/threads/${threadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ starred: next }),
      });
      if (!res.ok) {
        // Roll back the optimistic flip on failure.
        setStarred(!next);
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      router.refresh();
    });
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    setError(null);
    startMuteTransition(async () => {
      const res = await fetch(`/api/threads/${threadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ muted: next }),
      });
      if (!res.ok) {
        setMuted(!next);
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      toast({
        message: next ? "Conversation muted" : "Conversation unmuted",
        action: {
          label: "Undo",
          onClick: async () => {
            setMuted(!next);
            await fetch(`/api/threads/${threadId}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ muted: !next }),
            });
            router.refresh();
          },
        },
      });
      router.refresh();
    });
  }

  function togglePin() {
    const next = !pinned;
    setPinned(next);
    setError(null);
    startPinTransition(async () => {
      const res = await fetch(`/api/threads/${threadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: next }),
      });
      if (!res.ok) {
        setPinned(!next);
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      toast({
        message: next ? "Conversation pinned" : "Conversation unpinned",
      });
      router.refresh();
    });
  }

  function archive() {
    if (pending) return;
    const previousArchived = archived;
    const next = !previousArchived;
    setArchived(next);
    setError(null);
    setPending({ kind: "archive", previousArchived });
    // Fire the PATCH immediately — the inbox list reflects the new state on
    // refresh, the toast lets the user reverse it within the window.
    void fetch(`/api/threads/${threadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: next }),
    }).then(async res => {
      if (!res.ok) {
        setArchived(previousArchived);
        setPending(null);
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      router.refresh();
    });
  }

  async function undoArchive(previousArchived: boolean) {
    const res = await fetch(`/api/threads/${threadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: previousArchived }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      setError(b.error ?? `Undo failed (${res.status})`);
      // Still close the toast — the optimistic restore below would be wrong,
      // so leave the UI showing whatever state the server is actually in.
      setPending(null);
      router.refresh();
      return;
    }
    setArchived(previousArchived);
    setPending(null);
    router.refresh();
  }

  function commitArchive() {
    // Toast expired without an undo. Archived threads don't belong in the
    // current scope's list, so route the user back to the All view; the
    // PATCH already landed when archive() ran.
    setPending(null);
    if (archived) {
      router.push("/inbox/all");
      router.refresh();
    }
  }

  function deleteThread() {
    if (pending) return;
    setError(null);
    // Defer the DELETE until the toast expires so the user can back out.
    setPending({ kind: "delete" });
  }

  async function commitDelete() {
    const res = await fetch(`/api/threads/${threadId}`, { method: "DELETE" });
    setPending(null);
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      setError(b.error ?? `Failed (${res.status})`);
      return;
    }
    router.push("/inbox/all");
    router.refresh();
  }

  function undoDelete() {
    setPending(null);
  }

  const isDeletePending = pending?.kind === "delete";
  const anyPending = pending !== null;

  return (
    <>
      <div className="flex items-center gap-2">
        {error && <span className="text-xs text-red-600">{error}</span>}
        {isDeletePending ? (
          <span className="text-xs text-neutral-500 italic">Deleting…</span>
        ) : (
          <>
            <button
              type="button"
              data-action="star"
              onClick={toggleStar}
              disabled={isStarPending || anyPending}
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
              data-action="pin"
              onClick={togglePin}
              disabled={isPinPending || anyPending}
              aria-pressed={pinned}
              title={pinned ? "Unpin thread" : "Pin thread — keep at top of inbox"}
              className={`rounded-md border px-3 py-1.5 text-sm disabled:opacity-50 ${
                pinned
                  ? "border-amber-400 bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                  : "border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              }`}
            >
              {pinned ? "📌 Pinned" : "Pin"}
            </button>
            <button
              type="button"
              data-action="archive"
              onClick={archive}
              disabled={anyPending}
              title={archived ? "Unarchive" : "Archive"}
              className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
            >
              {archived ? "Unarchive" : "Archive"}
            </button>
            <button
              type="button"
              data-action="mute"
              onClick={toggleMute}
              disabled={isMutePending || anyPending}
              aria-pressed={muted}
              title={muted ? "Unmute thread" : "Mute thread — new replies stay archived"}
              className={`rounded-md border px-3 py-1.5 text-sm disabled:opacity-50 ${
                muted
                  ? "border-neutral-400 bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                  : "border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              }`}
            >
              {muted ? "Unmute" : "Mute"}
            </button>
            <button
              type="button"
              data-action="delete"
              onClick={deleteThread}
              disabled={anyPending}
              title="Delete"
              className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
            >
              Delete
            </button>
          </>
        )}
      </div>
      {pending?.kind === "archive" && (
        <UndoToast
          key={`archive-${threadId}-${pending.previousArchived}`}
          message={archived ? "Conversation archived" : "Conversation unarchived"}
          delaySeconds={UNDO_WINDOW_SECONDS}
          onUndo={() => undoArchive(pending.previousArchived)}
          onCommit={commitArchive}
          onDismiss={() => setPending(null)}
        />
      )}
      {pending?.kind === "delete" && (
        <UndoToast
          key={`delete-${threadId}`}
          message="Conversation deleted"
          delaySeconds={UNDO_WINDOW_SECONDS}
          onUndo={undoDelete}
          onCommit={commitDelete}
          onDismiss={() => setPending(null)}
        />
      )}
    </>
  );
}
