"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "./ToastProvider";
import { useDismissedThreads } from "./DismissedThreadsProvider";
import AssignButton from "./AssignButton";
import UndoToast from "./UndoToast";

interface InitialAssignment {
  assignee_id: string;
  assignee_email: string | null;
  assignee_display_name: string | null;
  resolved_at: number | null;
  resolved_by: string | null;
  resolved_by_email: string | null;
  resolved_by_display_name: string | null;
}

interface Props {
  threadId: string;
  initialStarred: boolean;
  initialArchived: boolean;
  initialMuted: boolean;
  initialPinned: boolean;
  // Follow-up (issue #26). When enabled the thread becomes a
  // candidate for the Follow-ups view. `initialFollowUpMinutes` is the
  // per-thread cadence override (in minutes — supports sub-day values
  // since the bell-icon UX); NULL falls back to the global default
  // (DEFAULT_FOLLOWUP_MINUTES below).
  initialFollowUpEnabled?: boolean;
  initialFollowUpMinutes?: number | null;
  // Mailbox the thread lives on — drives the assignment menu's member fetch.
  mailboxId: string;
  // Current user id, needed to render "Claim" vs "Reassign" and to set the
  // self-claim button's payload.
  currentUserId: string;
  // SSR-resolved snapshot of the current assignment. Null when unassigned.
  initialAssignment: InitialAssignment | null;
}

// Default cadence surfaced when the user enables follow-up on a thread
// with no per-thread override. 4 days = 5760 minutes; kept in sync with
// listDueFollowups' default.
const DEFAULT_FOLLOWUP_MINUTES = 4 * 1440;

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
  initialFollowUpEnabled = false,
  initialFollowUpMinutes = null,
  mailboxId,
  currentUserId,
  initialAssignment,
}: Props) {
  const router = useRouter();
  const { toast } = useToast();
  // Shared optimistic-dismissal set — lets the detail-pane Archive button
  // hide the row from ThreadList immediately. Without this the row stays
  // visible on /inbox/all (which intentionally includes archived threads)
  // until the user navigates away. See DismissedThreadsProvider.
  const dismissed = useDismissedThreads();
  const [starred, setStarred] = useState(initialStarred);
  const [archived, setArchived] = useState(initialArchived);
  const [muted, setMuted] = useState(initialMuted);
  const [pinned, setPinned] = useState(initialPinned);
  const [followUpEnabled, setFollowUpEnabled] = useState(initialFollowUpEnabled);
  const [followUpMinutes, setFollowUpMinutes] = useState<number | null>(
    initialFollowUpMinutes,
  );
  const [followUpPopoverOpen, setFollowUpPopoverOpen] = useState(false);
  // Two-field draft: a number (string) and a unit. Seeded from the
  // current cadence — see seedFollowUpDraft.
  const [followUpDraftValue, setFollowUpDraftValue] = useState("");
  const [followUpDraftUnit, setFollowUpDraftUnit] = useState<CadenceUnit>("days");
  const followUpPopoverRef = useRef<HTMLDivElement>(null);

  function seedFollowUpDraft(minutes: number | null) {
    const m = minutes ?? DEFAULT_FOLLOWUP_MINUTES;
    const split = splitCadence(m);
    setFollowUpDraftValue(String(split.value));
    setFollowUpDraftUnit(split.unit);
  }
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [isStarPending, startStarTransition] = useTransition();
  const [isMutePending, startMuteTransition] = useTransition();
  const [isPinPending, startPinTransition] = useTransition();
  const [isFollowUpPending, startFollowUpTransition] = useTransition();
  // Overflow menu — Pin / Mute / Mark unread / Delete live here so the
  // primary toolbar stays compact. Mirrors the MessageMenu pattern.
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);

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

  // Follow-up (issue #26). Toggling the button flips
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
        message: next ? "Follow-up on" : "Follow-up off",
      });
      router.refresh();
    });
  }

  function submitFollowUpCadence() {
    const parsed = Number(followUpDraftValue);
    if (!Number.isFinite(parsed) || parsed < 1) {
      setError("Enter a value of at least 1.");
      return;
    }
    const minutes = toMinutes(parsed, followUpDraftUnit);
    // 1 minute floor (anything smaller than a minute would just be noise
    // given the cron cadence) and 1-year ceiling (matches the previous
    // 365-day bound, expressed in minutes).
    if (minutes < 1 || minutes > 365 * 1440) {
      setError("Cadence must be between 1 minute and 1 year.");
      return;
    }
    setFollowUpMinutes(minutes);
    setFollowUpPopoverOpen(false);
    setError(null);
    startFollowUpTransition(async () => {
      const res = await fetch(`/api/threads/${threadId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ follow_up_minutes: minutes }),
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

  useEffect(() => {
    if (!moreMenuOpen) return;
    function onDown(e: MouseEvent) {
      if (
        moreMenuRef.current &&
        !moreMenuRef.current.contains(e.target as Node)
      ) {
        setMoreMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [moreMenuOpen]);

  function archive() {
    if (pending) return;
    const previousArchived = archived;
    const next = !previousArchived;
    setArchived(next);
    // Hide the row from any ThreadList rendered alongside this view. The
    // dismissal is shared via DismissedThreadsProvider so /inbox/all
    // (which keeps archived rows in its listing query) doesn't keep
    // showing the just-archived thread.
    dismissed.dismiss(threadId);
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
        dismissed.restore(threadId);
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
    dismissed.restore(threadId);
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
    // Hide the row from the list while the toast counts down — same
    // rationale as archive(). Without this the user sees "Conversation
    // deleted" on the toast but the row keeps sitting in the inbox list.
    dismissed.dismiss(threadId);
    // Defer the DELETE until the toast expires so the user can back out.
    setPending({ kind: "delete" });
  }

  async function commitDelete() {
    const res = await fetch(`/api/threads/${threadId}`, { method: "DELETE" });
    setPending(null);
    if (!res.ok) {
      // DELETE failed — bring the row back so the user can retry.
      dismissed.restore(threadId);
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      setError(b.error ?? `Failed (${res.status})`);
      return;
    }
    router.push("/inbox/all");
    router.refresh();
  }

  function undoDelete() {
    dismissed.restore(threadId);
    setPending(null);
  }

  const isDeletePending = pending?.kind === "delete";
  const anyPending = pending !== null;

  return (
    <>
      {/*
        Assignment lives in its own toolbar group so the parallel follow-ups
        work (issue #26) can drop its Follow-up button right next to it
        without fighting this container for layout. data-toolbar-group is a
        stable hook for downstream styling / e2e.
      */}
      <div className="flex items-center gap-2" data-toolbar-group="assignment-row">
        <AssignButton
          threadId={threadId}
          mailboxId={mailboxId}
          currentUserId={currentUserId}
          initialAssignment={initialAssignment}
        />
      </div>
      <div className="flex items-center gap-1" data-toolbar-group="thread-actions">
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
              aria-label={starred ? "Unstar" : "Star"}
              title={starred ? "Unstar" : "Star"}
              className={`inline-flex h-8 w-8 items-center justify-center rounded-md border text-sm disabled:opacity-50 ${
                starred
                  ? "border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 text-yellow-500"
                  : "border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              }`}
            >
              {starred ? "★" : "☆"}
            </button>
            <button
              type="button"
              data-action="archive"
              onClick={archive}
              disabled={anyPending}
              aria-label={archived ? "Unarchive" : "Archive"}
              title={archived ? "Unarchive" : "Archive"}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
            >
              <ArchiveGlyph filled={archived} />
            </button>
            <div ref={moreMenuRef} className="relative">
              <button
                type="button"
                data-action="more"
                onClick={() => setMoreMenuOpen(o => !o)}
                disabled={anyPending}
                aria-haspopup="menu"
                aria-expanded={moreMenuOpen}
                aria-label="More thread actions"
                title="More"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                  <path d="M8 4a1.25 1.25 0 1 0 0-2.5A1.25 1.25 0 0 0 8 4Zm0 5.25A1.25 1.25 0 1 0 8 6.75a1.25 1.25 0 0 0 0 2.5Zm0 5.25A1.25 1.25 0 1 0 8 12a1.25 1.25 0 0 0 0 2.5Z" />
                </svg>
              </button>
              {moreMenuOpen && (
                <div
                  role="menu"
                  aria-label="Thread actions"
                  className="absolute right-0 top-full mt-1 z-30 w-48 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg"
                >
                  <button
                    type="button"
                    role="menuitem"
                    data-action="pin"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      togglePin();
                    }}
                    disabled={isPinPending || anyPending}
                    className="block w-full text-left px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 focus:bg-neutral-100 dark:focus:bg-neutral-900 focus:outline-none disabled:opacity-50"
                  >
                    {pinned ? "📌 Unpin" : "Pin to top"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-action="mute"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      toggleMute();
                    }}
                    disabled={isMutePending || anyPending}
                    className="block w-full text-left px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 focus:bg-neutral-100 dark:focus:bg-neutral-900 focus:outline-none disabled:opacity-50"
                  >
                    {muted ? "Unmute" : "Mute thread"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-action="mark-unread"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      markUnread();
                    }}
                    disabled={isUnreadPending || anyPending}
                    className="block w-full text-left px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 focus:bg-neutral-100 dark:focus:bg-neutral-900 focus:outline-none disabled:opacity-50"
                  >
                    Mark unread
                  </button>
                  <div className="border-t border-neutral-200 dark:border-neutral-800" />
                  <button
                    type="button"
                    role="menuitem"
                    data-action="delete"
                    onClick={() => {
                      setMoreMenuOpen(false);
                      deleteThread();
                    }}
                    disabled={anyPending}
                    className="block w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 focus:bg-red-50 dark:focus:bg-red-950/30 focus:outline-none disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {/* Follow-up (issue #26). Own toolbar group so the parallel
          shared-mailbox-assignment work merging into ThreadActions doesn't
          collide with the main button row above. */}
      {!isDeletePending && (
        <div
          data-toolbar-group="follow-up"
          className="flex items-center gap-1"
        >
          <div className="relative inline-flex" ref={followUpPopoverRef}>
            <button
              type="button"
              data-action="follow-up"
              onClick={toggleFollowUp}
              disabled={isFollowUpPending || anyPending}
              aria-pressed={followUpEnabled}
              aria-label={followUpEnabled ? "Follow-up on" : "Follow-up off"}
              title={
                followUpEnabled
                  ? `Follow-up on — due ${formatCadence(followUpMinutes ?? DEFAULT_FOLLOWUP_MINUTES)}`
                  : "Follow-up off — turn on to get reminded when waiting on a reply"
              }
              className={`inline-flex h-8 ${
                followUpEnabled ? "px-2" : "w-8"
              } items-center justify-center gap-1 rounded-l-md border text-sm disabled:opacity-50 ${
                followUpEnabled
                  ? "border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 text-[var(--color-brand)]"
                  : "border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              }`}
            >
              <BellGlyph filled={followUpEnabled} />
              {followUpEnabled && (
                <span className="text-xs tabular-nums">
                  {formatCadenceShort(followUpMinutes)}
                </span>
              )}
            </button>
            <button
              type="button"
              data-action="follow-up-cadence"
              onClick={() => {
                seedFollowUpDraft(followUpMinutes);
                setFollowUpPopoverOpen(o => !o);
              }}
              disabled={isFollowUpPending || anyPending}
              aria-label="Edit follow-up cadence"
              aria-expanded={followUpPopoverOpen}
              title="Change follow-up cadence"
              className={`inline-flex h-8 w-6 items-center justify-center rounded-r-md border-y border-r text-xs disabled:opacity-50 ${
                followUpEnabled
                  ? "border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 text-[var(--color-brand)]"
                  : "border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              }`}
            >
              ▾
            </button>
            {followUpPopoverOpen && (
              <div
                role="dialog"
                aria-label="Follow-up cadence"
                className="absolute right-0 top-full mt-1 z-30 w-64 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg p-3"
              >
                <label className="block text-xs text-neutral-600 dark:text-neutral-400 mb-1">
                  Follow up after
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={followUpDraftValue}
                    onChange={e => setFollowUpDraftValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") submitFollowUpCadence();
                    }}
                    className="w-20 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
                  />
                  <select
                    value={followUpDraftUnit}
                    onChange={e => setFollowUpDraftUnit(e.target.value as CadenceUnit)}
                    className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
                  >
                    <option value="minutes">minutes</option>
                    <option value="hours">hours</option>
                    <option value="days">days</option>
                  </select>
                  <button
                    type="button"
                    onClick={submitFollowUpCadence}
                    className="ml-auto rounded-md bg-[var(--color-brand)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
                  >
                    Save
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-neutral-500">
                  Default {formatCadence(DEFAULT_FOLLOWUP_MINUTES)}. Threads
                  surface in the Follow-ups view once they pass this
                  threshold without a reply.
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

// Cadence picker units. Internally everything is minutes; we just split
// for display and recompose on save.
type CadenceUnit = "minutes" | "hours" | "days";

function toMinutes(value: number, unit: CadenceUnit): number {
  if (unit === "minutes") return Math.round(value);
  if (unit === "hours") return Math.round(value * 60);
  return Math.round(value * 1440);
}

// Pick the largest whole unit that the cadence cleanly divides into
// (24h → 1 day, 90m → 90 minutes since it doesn't round to whole hours).
// Used to seed the popover with a sensible default unit when reopening.
function splitCadence(minutes: number): { value: number; unit: CadenceUnit } {
  if (minutes >= 1440 && minutes % 1440 === 0) {
    return { value: minutes / 1440, unit: "days" };
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    return { value: minutes / 60, unit: "hours" };
  }
  return { value: minutes, unit: "minutes" };
}

// Long-form ("4 days", "6 hours", "30 minutes") for tooltips and the
// popover help text.
function formatCadence(minutes: number): string {
  const split = splitCadence(minutes);
  const noun =
    split.unit === "days" ? "day" : split.unit === "hours" ? "hour" : "minute";
  return `${split.value} ${noun}${split.value === 1 ? "" : "s"}`;
}

// Compact form for the bell-button label ("4d", "6h", "30m"). Stays
// inside the toolbar's tight horizontal budget.
function formatCadenceShort(minutes: number | null): string {
  if (minutes == null) return formatCadenceShort(DEFAULT_FOLLOWUP_MINUTES);
  const split = splitCadence(minutes);
  const suffix =
    split.unit === "days" ? "d" : split.unit === "hours" ? "h" : "m";
  return `${split.value}${suffix}`;
}

// Bell glyph for the follow-up button. Filled when active so the on-state
// reads at a glance even in monochrome.
function BellGlyph({ filled }: { filled: boolean }) {
  if (filled) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
        <path d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5v2.379a1 1 0 0 1-.293.707l-1.207 1.207A.75.75 0 0 0 2.53 11.5h10.94a.75.75 0 0 0 .53-1.207l-1.207-1.207A1 1 0 0 1 12.5 8.379V6A4.5 4.5 0 0 0 8 1.5Zm-1.75 11a1.75 1.75 0 0 0 3.5 0h-3.5Z" />
      </svg>
    );
  }
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3.75 11.5h8.5l-.94-.94a1 1 0 0 1-.31-.71V6a3.5 3.5 0 1 0-7 0v3.85a1 1 0 0 1-.31.71l-.94.94Z" />
      <path d="M6.5 12.5a1.5 1.5 0 0 0 3 0" />
    </svg>
  );
}

// Archive glyph — file-with-down-arrow style, matches the same 14×14 box
// the other toolbar icons use. Filled background reads as "already
// archived" without needing a label swap.
function ArchiveGlyph({ filled }: { filled: boolean }) {
  if (filled) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
        <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5V5H2V3.5Z" />
        <path d="M2.5 6h11l-.5 7a1.5 1.5 0 0 1-1.5 1.4H4.5A1.5 1.5 0 0 1 3 13l-.5-7Zm3 2.25a.75.75 0 0 1 1.06 0L7.25 8.94V11.5a.75.75 0 0 0 1.5 0V8.94l.69.69a.75.75 0 1 0 1.06-1.06L8.53 6.72a.75.75 0 0 0-1.06 0L5.5 8.69a.75.75 0 0 0 0 1.06Z" />
      </svg>
    );
  }
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2" y="2.5" width="12" height="3" rx="1" />
      <path d="M3 5.5v7a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 12.5v-7" />
      <path d="M6.5 8.5 8 7l1.5 1.5M8 7v4" />
    </svg>
  );
}
