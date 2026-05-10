"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "./ToastProvider";
import RemindButton from "./RemindButton";
import UndoToast from "./UndoToast";

interface Props {
  threadId: string;
  initialStarred: boolean;
  initialArchived: boolean;
  initialMuted: boolean;
  initialPinned: boolean;
  // Reminder timestamp on the thread (issue #75). Drives the Remind button
  // sibling-rendered below. Snooze stays in its own component — remind is
  // intentionally a separate concept and a separate mutation endpoint.
  initialRemindAt: number | null;
  // Follow-up nudges (issue #26). When enabled the thread becomes a
  // candidate for the Follow-ups view. `initialFollowUpDays` is the
  // per-thread day-count override; NULL falls back to the global default
  // (DEFAULT_FOLLOWUP_DAYS below). Kept in its own toolbar group so the
  // parallel shared-mailbox-assignment work merges cleanly around it.
  initialFollowUpEnabled?: boolean;
  initialFollowUpDays?: number | null;
}

// Default day-count surfaced when the user enables nudges on a thread with
// no per-thread override. Kept in sync with listDueFollowups' default.
const DEFAULT_FOLLOWUP_DAYS = 4;

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
  initialRemindAt,
  initialFollowUpEnabled = false,
  initialFollowUpDays = null,
}: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [starred, setStarred] = useState(initialStarred);
  const [archived, setArchived] = useState(initialArchived);
  const [muted, setMuted] = useState(initialMuted);
  const [pinned, setPinned] = useState(initialPinned);
  const [followUpEnabled, setFollowUpEnabled] = useState(initialFollowUpEnabled);
  const [followUpDays, setFollowUpDays] = useState<number | null>(initialFollowUpDays);
  const [followUpPopoverOpen, setFollowUpPopoverOpen] = useState(false);
  const [followUpDaysDraft, setFollowUpDaysDraft] = useState(
    String(initialFollowUpDays ?? DEFAULT_FOLLOWUP_DAYS),
  );
  const followUpPopoverRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [isStarPending, startStarTransition] = useTransition();
  const [isMutePending, startMuteTransition] = useTransition();
  const [isPinPending, startPinTransition] = useTransition();
  const [isFollowUpPending, startFollowUpTransition] = useTransition();

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

  // Mark the whole thread back to unread. The /api/threads/<id> PATCH already
  // accepts `{ read: false }` and bumps unread_count to MAX(unread_count, 1)
  // without flipping per-message read flags (so re-opening doesn't re-trigger
  // first-unread highlighting). One-shot: no optimistic toggle since there's
  // nothing to show in this view; toast + router.refresh() update the
  // sidebar/list when the user navigates back.
  const [isUnreadPending, startUnreadTransition] = useTransition();
  function markUnread() {
    setError(null);
    startUnreadTransition(async () => {
      const res = await fetch(`/api/threads/${threadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ read: false }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      toast({ message: "Marked unread" });
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

  // Follow-up nudges (issue #26). Toggling the button flips
  // `follow_up_enabled` on threads_index; clicking the chevron beside it
  // opens a small popover where the user can override the per-thread day
  // count. Days override survives toggling off/on so users don't lose their
  // chosen cadence by experimenting.
  function toggleFollowUp() {
    const next = !followUpEnabled;
    setFollowUpEnabled(next);
    setError(null);
    startFollowUpTransition(async () => {
      const res = await fetch(`/api/threads/${threadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ follow_up_enabled: next }),
      });
      if (!res.ok) {
        setFollowUpEnabled(!next);
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      toast({
        message: next ? "Follow-up nudges on" : "Follow-up nudges off",
      });
      router.refresh();
    });
  }

  function submitFollowUpDays() {
    const parsed = Number(followUpDaysDraft);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 365) {
      setError("Days must be between 1 and 365");
      return;
    }
    const next = Math.floor(parsed);
    setFollowUpDays(next);
    setFollowUpPopoverOpen(false);
    setError(null);
    startFollowUpTransition(async () => {
      const res = await fetch(`/api/threads/${threadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ follow_up_days: next }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      router.refresh();
    });
  }

  // Close the days-popover on outside-click. Mirrors the pattern used by
  // ThreadList's label menu so the UX feels consistent across the app.
  useEffect(() => {
    if (!followUpPopoverOpen) return;
    function onDown(e: MouseEvent) {
      if (
        followUpPopoverRef.current &&
        !followUpPopoverRef.current.contains(e.target as Node)
      ) {
        setFollowUpPopoverOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [followUpPopoverOpen]);

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
              data-action="mark-unread"
              onClick={markUnread}
              disabled={isUnreadPending || anyPending}
              title="Mark unread — bring this back to your inbox as unread"
              className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
            >
              Mark unread
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
            <RemindButton threadId={threadId} initialRemindAt={initialRemindAt} />
          </>
        )}
      </div>
      {/* Follow-up nudges (issue #26). Own toolbar group so the parallel
          shared-mailbox-assignment work merging into ThreadActions doesn't
          collide with the main button row above. */}
      {!isDeletePending && (
        <div
          data-toolbar-group="follow-up"
          className="flex items-center gap-1 mt-2 sm:mt-0 sm:ml-1"
        >
          <div className="relative inline-flex" ref={followUpPopoverRef}>
            <button
              type="button"
              data-action="follow-up"
              onClick={toggleFollowUp}
              disabled={isFollowUpPending || anyPending}
              aria-pressed={followUpEnabled}
              title={
                followUpEnabled
                  ? `Follow-up nudges on — due in ${followUpDays ?? DEFAULT_FOLLOWUP_DAYS}d`
                  : "Follow-up nudges off — turn on to get reminded when waiting on a reply"
              }
              className={`rounded-l-md border px-3 py-1.5 text-sm disabled:opacity-50 ${
                followUpEnabled
                  ? "border-indigo-400 bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300"
                  : "border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              }`}
            >
              {followUpEnabled
                ? `⏰ Nudge in ${followUpDays ?? DEFAULT_FOLLOWUP_DAYS}d`
                : "⏰ Nudge"}
            </button>
            <button
              type="button"
              data-action="follow-up-days"
              onClick={() => {
                setFollowUpDaysDraft(
                  String(followUpDays ?? DEFAULT_FOLLOWUP_DAYS),
                );
                setFollowUpPopoverOpen(o => !o);
              }}
              disabled={isFollowUpPending || anyPending}
              aria-label="Edit follow-up days"
              aria-expanded={followUpPopoverOpen}
              title="Change follow-up cadence"
              className={`rounded-r-md border-y border-r px-2 py-1.5 text-sm disabled:opacity-50 ${
                followUpEnabled
                  ? "border-indigo-400 bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300"
                  : "border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              }`}
            >
              ▾
            </button>
            {followUpPopoverOpen && (
              <div
                role="dialog"
                aria-label="Follow-up cadence"
                className="absolute right-0 top-full mt-1 z-30 w-56 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg p-3"
              >
                <label className="block text-xs text-neutral-600 dark:text-neutral-400 mb-1">
                  Nudge after how many days?
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={followUpDaysDraft}
                    onChange={e => setFollowUpDaysDraft(e.target.value)}
                    className="w-20 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
                  />
                  <button
                    type="button"
                    onClick={submitFollowUpDays}
                    className="rounded-md bg-[var(--color-brand)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
                  >
                    Save
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-neutral-500">
                  Default {DEFAULT_FOLLOWUP_DAYS}d. Threads surface in the
                  Follow-ups view once they pass this threshold without a
                  reply.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
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
