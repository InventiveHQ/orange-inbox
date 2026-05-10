"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "./ToastProvider";

interface InitialAssignment {
  assignee_id: string;
  assignee_email: string | null;
  assignee_display_name: string | null;
  // Resolve lifecycle (0048). Non-null resolved_at = the assignment has been
  // marked done; the row stays but drops out of /inbox/assigned. resolved_by
  // is the user who clicked Resolve (not necessarily the assignee).
  resolved_at: number | null;
  resolved_by: string | null;
  resolved_by_email: string | null;
  resolved_by_display_name: string | null;
}

interface Member {
  user_id: string;
  email: string;
  display_name: string | null;
}

interface Props {
  threadId: string;
  mailboxId: string;
  currentUserId: string;
  // SSR-resolved snapshot from getAssignment. Null means unassigned.
  initialAssignment: InitialAssignment | null;
}

// Assignment toolbar group for ThreadActions. Renders as a single chip:
//   - unassigned → "Claim" (one-click self-assign) + a small ▾ that opens the
//     full "Assign to…" picker for delegating to a teammate.
//   - assigned to me → "Assigned to you" with a menu to reassign or release.
//   - assigned to someone else → "Assigned to <name>" with a menu to reassign
//     (incl. claim it for yourself) or release.
//
// Kept as a DISTINCT toolbar group from the star/archive/mute/pin row so the
// parallel follow-ups agent (issue #26) can land its Follow-up button
// alongside without colliding on the same flex container.
export default function AssignButton({
  threadId,
  mailboxId,
  currentUserId,
  initialAssignment,
}: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [assignment, setAssignment] = useState<InitialAssignment | null>(
    initialAssignment,
  );
  const [members, setMembers] = useState<Member[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Lazy-load the member list the first time the menu opens. Avoids hitting
  // /api/mailboxes/<id>/assignable on every thread render.
  useEffect(() => {
    if (!menuOpen || members !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/mailboxes/${mailboxId}/assignable`);
        if (!res.ok) {
          if (!cancelled) setError(`Failed to load members (${res.status})`);
          return;
        }
        const data = (await res.json()) as { members: Member[] };
        if (!cancelled) setMembers(data.members);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [menuOpen, members, mailboxId]);

  // Close-on-outside-click. Plain document listener; no portal — the menu is
  // anchored to its trigger so the toolbar layout (and the parallel
  // follow-ups agent's Follow-up button) keeps working unchanged.
  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  function assignTo(userId: string) {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/threads/${threadId}/assignment`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignee_id: userId }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as { assignment: InitialAssignment };
      setAssignment(data.assignment);
      setMenuOpen(false);
      toast({
        message:
          userId === currentUserId
            ? "Claimed"
            : `Assigned to ${labelFor(data.assignment)}`,
      });
      router.refresh();
    });
  }

  function unassign() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/threads/${threadId}/assignment`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      setAssignment(null);
      setMenuOpen(false);
      toast({ message: "Unassigned" });
      router.refresh();
    });
  }

  function resolve() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/threads/${threadId}/assignment/resolve`, {
        method: "POST",
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as { assignment: InitialAssignment };
      setAssignment(data.assignment);
      toast({ message: "Resolved" });
      router.refresh();
    });
  }

  function reopen() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/threads/${threadId}/assignment/resolve`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as { assignment: InitialAssignment };
      setAssignment(data.assignment);
      toast({ message: "Reopened" });
      router.refresh();
    });
  }

  const isMine = assignment?.assignee_id === currentUserId;
  const isResolved = assignment?.resolved_at != null;
  const chipLabel = assignment
    ? isResolved
      ? "Resolved"
      : isMine
        ? "Assigned to you"
        : `Assigned to ${labelFor(assignment)}`
    : null;

  return (
    <div className="flex items-center gap-1" data-toolbar-group="assignment">
      {error && <span className="text-xs text-red-600">{error}</span>}
      {!assignment ? (
        <>
          <button
            type="button"
            data-action="claim"
            onClick={() => assignTo(currentUserId)}
            disabled={isPending}
            title="Claim this thread"
            className="rounded-md border border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-900/30 dark:text-emerald-300 px-3 py-1.5 text-sm hover:bg-emerald-100 dark:hover:bg-emerald-900/50 disabled:opacity-50"
          >
            Claim
          </button>
          <div ref={wrapRef} className="relative">
            <button
              type="button"
              data-action="assign-menu"
              onClick={() => setMenuOpen(o => !o)}
              disabled={isPending}
              title="Assign to teammate"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
            >
              ▾
            </button>
            {menuOpen && (
              <AssignMenu
                members={members}
                currentUserId={currentUserId}
                onPick={assignTo}
                onClear={unassign}
                assignment={assignment}
              />
            )}
          </div>
        </>
      ) : (
        <>
          <div ref={wrapRef} className="relative">
            <button
              type="button"
              data-action="assign-menu"
              onClick={() => setMenuOpen(o => !o)}
              disabled={isPending}
              title={chipLabel || ""}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className={`inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm disabled:opacity-50 ${
                isResolved
                  ? "border-neutral-300 bg-neutral-100 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700"
                  : isMine
                    ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-900/30 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/50"
                    : "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-900/60 dark:bg-sky-900/30 dark:text-sky-300 hover:bg-sky-100 dark:hover:bg-sky-900/50"
              }`}
            >
              <span className="truncate max-w-[14ch]">{chipLabel}</span>
              <span aria-hidden>▾</span>
            </button>
            {menuOpen && (
              <AssignMenu
                members={members}
                currentUserId={currentUserId}
                onPick={assignTo}
                onClear={unassign}
                assignment={assignment}
              />
            )}
          </div>
          {isResolved ? (
            <button
              type="button"
              data-action="reopen"
              onClick={reopen}
              disabled={isPending}
              title="Reopen — return to the assignee's active queue"
              className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
            >
              Reopen
            </button>
          ) : (
            <button
              type="button"
              data-action="resolve"
              onClick={resolve}
              disabled={isPending}
              title="Mark this assignment resolved — clears it from /inbox/assigned"
              className="rounded-md border border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-900/30 dark:text-emerald-300 px-3 py-1.5 text-sm hover:bg-emerald-100 dark:hover:bg-emerald-900/50 disabled:opacity-50"
            >
              ✓ Resolve
            </button>
          )}
        </>
      )}
    </div>
  );
}

function AssignMenu({
  members,
  currentUserId,
  onPick,
  onClear,
  assignment,
}: {
  members: Member[] | null;
  currentUserId: string;
  onPick: (id: string) => void;
  onClear: () => void;
  assignment: InitialAssignment | null;
}) {
  return (
    <div
      role="menu"
      className="absolute right-0 z-20 mt-1 w-64 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-lg overflow-hidden"
    >
      {members === null ? (
        <div className="px-3 py-2 text-xs text-neutral-500">Loading members…</div>
      ) : members.length === 0 ? (
        <div className="px-3 py-2 text-xs text-neutral-500">No members</div>
      ) : (
        <ul className="max-h-72 overflow-y-auto py-1">
          {members.map(m => {
            const isSelf = m.user_id === currentUserId;
            const isAssignee = assignment?.assignee_id === m.user_id;
            return (
              <li key={m.user_id}>
                <button
                  type="button"
                  onClick={() => onPick(m.user_id)}
                  disabled={isAssignee}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-sm text-left hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-60 disabled:cursor-default ${
                    isAssignee ? "bg-neutral-50 dark:bg-neutral-900/50" : ""
                  }`}
                >
                  <span className="truncate">
                    {isSelf ? "Me" : m.display_name?.trim() || m.email}
                    {!isSelf && m.display_name && (
                      <span className="ml-2 text-xs text-neutral-500">
                        {m.email}
                      </span>
                    )}
                  </span>
                  {isAssignee && (
                    <span className="ml-2 shrink-0 text-[10px] uppercase tracking-wider text-neutral-500">
                      assigned
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {assignment && (
        <div className="border-t border-neutral-200 dark:border-neutral-800">
          <button
            type="button"
            onClick={onClear}
            className="block w-full px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
          >
            Unassign
          </button>
        </div>
      )}
    </div>
  );
}

function labelFor(a: InitialAssignment): string {
  return a.assignee_display_name?.trim() || a.assignee_email || "user";
}
