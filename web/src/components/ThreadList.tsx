"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { ThreadListItem } from "@/lib/queries";
import { dateBucket, formatThreadDate, senderLabel } from "@/lib/format";
import {
  DEFAULT_QUADRANT,
  QUADRANT_LABELS,
  parseQuadrant,
  type TriageQuadrant,
} from "@/lib/triage";
import Avatar, { hashHue } from "./Avatar";
import CategoryTabs from "./CategoryTabs";
import { useDismissedThreads } from "./DismissedThreadsProvider";
import EmptyState from "./EmptyState";
import LabelChip from "./LabelChip";
import UndoToast from "./UndoToast";

interface Props {
  threads: ThreadListItem[];
  scope: string;
  activeThreadId?: string;
  showDomain: boolean;
}

interface AppliableLabel {
  id: string;
  name: string;
  color: string | null;
}

const SWIPE_THRESHOLD_PX = 80;
const SWIPE_MAX_VERTICAL_PX = 30;
const SWIPE_UNDO_SECONDS = 5;

// sessionStorage key prefix for thread-list scroll memory. We key on
// scope+pathname+search so each filtered view (e.g. ?view=quiet_humans) has
// its own remembered scroll position. The detail page lives under the same
// scope path, so coming back to the list naturally restores its position.
const SCROLL_KEY_PREFIX = "orange-inbox:threadlist-scroll:";
const SCROLL_SAVE_DEBOUNCE_MS = 120;

// Default cadence for follow-up (issue #26 + sub-day support via
// migration 0051). Kept in sync with listDueFollowups' defaultMinutes
// so the inline "Waiting N days" badge agrees with the server's
// "this thread is due" check.
const DEFAULT_FOLLOWUP_MINUTES = 4 * 1440;

// Quadrant tabs only make sense for the unified All view — per-mailbox
// scopes already have a single intent. Returning false hides the toggle bar.
function showsTriageBar(scope: string): boolean {
  return scope === "all";
}

// Category tabs (Primary / Promotions / Updates / Social / Forums) appear
// on per-mailbox inboxes. The unified "all" view uses the triage strip
// (Primary action / Quiet / Bulk action / Newsletters / Show all) instead —
// both rows together is visual noise and the two models overlap. Drafts /
// VIPs / domain roll-ups have their own filter semantics so we keep them
// off the strip.
const SCOPES_WITHOUT_CATEGORIES: ReadonlySet<string> = new Set([
  "all",
  "drafts",
  "vips",
]);
function showsCategoryTabs(scope: string): boolean {
  if (SCOPES_WITHOUT_CATEGORIES.has(scope)) return false;
  if (scope.startsWith("domain:")) return false;
  return true;
}

export default function ThreadList({ threads: rawThreads, scope, activeThreadId, showDomain }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const quadrant = parseQuadrant(searchParams.get("view"));
  // Tab toggling and bulk actions feel laggy when the router blocks on the
  // RSC roundtrip. React's transition primitive marks those navigations as
  // non-blocking so the rest of the UI stays interactive in the meantime.
  const [, startTransition] = useTransition();
  // Optimistic-archive UX. We add a thread id to the shared dismissed set
  // the moment the user archives (or bulk-archives/deletes) so the row
  // disappears immediately instead of waiting on the server roundtrip and
  // router.refresh() cycle. The set is shared (DismissedThreadsProvider) so
  // the detail-pane Archive button in ThreadActions can dismiss too —
  // otherwise /inbox/all (which intentionally includes archived threads)
  // keeps showing the just-archived row until the user navigates away.
  // Single archive rolls back on failure; bulk actions surface the error
  // via the existing bulkError banner and leave the dismissal in place
  // (the user can reload to recover failed ids).
  const dismissed = useDismissedThreads();
  // Animated removal. A dismissed thread is NOT dropped from the DOM
  // immediately — it stays mounted and plays a collapse-and-fade exit (see
  // [data-thread-exit] in globals.css), then a per-row timer adds its id to
  // `removed`, which is the set that actually drops it from render. Timer-driven
  // (not animationend) so reduced-motion users — for whom the animation is
  // suppressed — still get the row removed after the same short beat.
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const onExited = useCallback((id: string) => {
    setRemoved(prev => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);
  const rawIdSet = useMemo(() => new Set(rawThreads.map(t => t.id)), [rawThreads]);
  // Self-heal `removed`: keep an id flagged removed only while it's still both
  // present in the server data AND dismissed. This resurrects a row when an
  // archive is undone (dismissed.restore flips it back) — without it the undo
  // would leave the row hidden forever — and prunes ids the server has since
  // dropped so the set can't grow unbounded across a session.
  useEffect(() => {
    // Reconciling local removal state against server data + the dismissed set
    // is a genuine external-sync effect; the functional updater no-ops (returns
    // prev) when nothing changed, so it can't cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRemoved(prev => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (rawIdSet.has(id) && dismissed.isDismissed(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [rawIdSet, dismissed]);
  // What we actually render: server threads minus the fully-removed ones. This
  // still includes rows mid-exit (dismissed but not yet timed out) so they can
  // animate. Groups, the select-all header, and the empty-state check all key
  // off this so an exiting row keeps its place until the collapse finishes.
  const renderThreads = useMemo(
    () => rawThreads.filter(t => !removed.has(t.id)),
    [rawThreads, removed],
  );
  // Logical view (exiting rows excluded) — drives selection and counts so a row
  // on its way out can't be (de)selected or counted.
  const threads = useMemo(
    () =>
      dismissed.hasDismissed
        ? renderThreads.filter(t => !dismissed.isDismissed(t.id))
        : renderThreads,
    [renderThreads, dismissed],
  );
  // Clear optimistic dismissals when the user changes scope. The provider
  // persists across scope nav (it lives in the layout), so without this an
  // item archived from /inbox/all would still be hidden when the user
  // visits /inbox/archived where it legitimately belongs.
  const clearDismissed = dismissed.clear;
  useEffect(() => {
    clearDismissed();
    // Reset removal state alongside the dismissed set on scope change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRemoved(new Set());
  }, [scope, clearDismissed]);
  const triageEnabled = showsTriageBar(scope);
  const categoryTabsEnabled = showsCategoryTabs(scope);

  // Scroll memory — the <ul> is the scroller. We persist its scrollTop to
  // sessionStorage keyed by the current pathname+search so navigating into a
  // thread and back restores position without bleeding across mailboxes or
  // triage tabs.
  const listRef = useRef<HTMLUListElement>(null);
  const scrollKey = useMemo(
    () => `${SCROLL_KEY_PREFIX}${pathname}?${searchParams.toString()}`,
    [pathname, searchParams],
  );

  // Restore on mount / whenever the scroll key changes (e.g. user toggles
  // triage tab, which swaps the scope filter and remounts threads). Done in
  // a layout-friendly effect so the user doesn't see a flash at top.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    try {
      const raw = sessionStorage.getItem(scrollKey);
      const top = raw ? Number(raw) : 0;
      if (Number.isFinite(top) && top > 0) {
        el.scrollTop = top;
      } else {
        el.scrollTop = 0;
      }
    } catch {
      // sessionStorage may throw in private mode / quota — best effort only.
    }
  }, [scrollKey]);

  // Debounced save on scroll. We attach the listener via the effect (rather
  // than React's onScroll prop) so we can rebind cleanly when the key changes
  // and avoid React re-renders on every scroll tick.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    function onScroll() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          if (el) sessionStorage.setItem(scrollKey, String(el.scrollTop));
        } catch {
          // Ignore — see note above.
        }
      }, SCROLL_SAVE_DEBOUNCE_MS);
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (timer) clearTimeout(timer);
    };
  }, [scrollKey]);

  const [rawSelected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const [availableLabels, setAvailableLabels] = useState<AppliableLabel[] | null>(null);
  const labelMenuRef = useRef<HTMLDivElement>(null);

  // Swipe-to-archive (mobile only). The toast key bumps each time so a fresh
  // mount happens per archive — UndoToast's countdown anchors on mount and
  // reusing a key would let an old timer run on a new archive.
  const [swipeUndo, setSwipeUndo] = useState<{
    threadId: string;
    key: number;
  } | null>(null);
  const swipeUndoSeq = useRef(0);

  // Filter the stored selection through the *current* thread set so a router
  // refresh that drops a row also drops it from selection — without needing
  // an effect to mutate state when threads change. Stale ids in `rawSelected`
  // get garbage-collected the next time the user actually edits selection.
  const threadIdSet = useMemo(() => new Set(threads.map(t => t.id)), [threads]);
  const selected = useMemo(() => {
    const next = new Set<string>();
    for (const id of rawSelected) if (threadIdSet.has(id)) next.add(id);
    return next;
  }, [rawSelected, threadIdSet]);

  // Close label popover on outside click.
  useEffect(() => {
    if (!labelMenuOpen) return;
    function onDown(e: MouseEvent) {
      if (labelMenuRef.current && !labelMenuRef.current.contains(e.target as Node)) {
        setLabelMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [labelMenuOpen]);

  function navigateToQuadrant(next: TriageQuadrant) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === DEFAULT_QUADRANT) params.delete("view");
    else params.set("view", next);
    const qs = params.toString();
    const url = qs ? `/inbox/${scope}?${qs}` : `/inbox/${scope}`;
    // Wrap in startTransition so the tab toggle stays responsive — React
    // keeps the page interactive during the navigation rather than
    // blocking the click. router.refresh() forces the layout's server
    // fetch to re-read the ?view= param (App Router otherwise serves the
    // cached RSC payload for the same route when only search params change,
    // leaving the quadrant filter visually inert — other handlers in this
    // file already pair push + refresh for the same reason).
    startTransition(() => {
      router.push(url);
      router.refresh();
    });
  }

  function toggleOne(id: string, on: boolean) {
    setSelected(prev => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll(on: boolean) {
    setSelected(on ? new Set(threads.map(t => t.id)) : new Set());
  }

  async function runBulk(action: (id: string) => Promise<Response>) {
    if (selected.size === 0 || bulkBusy) return;
    setBulkBusy(true);
    setBulkError(null);
    const ids = Array.from(selected);
    try {
      const results = await Promise.all(ids.map(id => action(id).catch(() => null)));
      const failures = results.filter(r => !r || !r.ok).length;
      if (failures > 0) {
        setBulkError(
          failures === ids.length
            ? "All actions failed"
            : `${failures} of ${ids.length} failed`,
        );
      } else {
        setSelected(new Set());
      }
      router.refresh();
    } finally {
      setBulkBusy(false);
    }
  }

  function bulkArchive() {
    // Optimistically dismiss the selected ids so the rows vanish instantly.
    // runBulk's router.refresh() re-syncs from the server; any failures are
    // surfaced via the bulkError banner.
    const ids = Array.from(selected);
    dismissed.dismissMany(ids);
    void runBulk(id =>
      fetch(`/api/threads/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      }),
    );
  }

  function bulkDelete() {
    if (selected.size === 0 || bulkBusy) return;
    if (!confirm(`Permanently delete ${selected.size} conversation${selected.size === 1 ? "" : "s"}?`)) return;
    const ids = Array.from(selected);
    dismissed.dismissMany(ids);
    void runBulk(id => fetch(`/api/threads/${id}`, { method: "DELETE" }));
  }

  function bulkMarkRead() {
    void runBulk(id =>
      fetch(`/api/threads/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ read: true }),
      }),
    );
  }

  async function openLabelMenu() {
    setLabelMenuOpen(true);
    if (availableLabels !== null) return;
    const res = await fetch("/api/labels");
    if (!res.ok) {
      setBulkError("Failed to load labels");
      return;
    }
    const body = (await res.json()) as { labels: AppliableLabel[] };
    setAvailableLabels(body.labels);
  }

  function bulkApplyLabel(labelId: string) {
    setLabelMenuOpen(false);
    void runBulk(id =>
      fetch(`/api/threads/${id}/labels`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label_id: labelId }),
      }),
    );
  }

  function archiveOneFromSwipe(threadId: string) {
    // Optimistically dismiss so the swipe-to-archive feels instant. Roll
    // back on failure since a single archive has a clear blast radius.
    dismissed.dismiss(threadId);
    void fetch(`/api/threads/${threadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    }).then(res => {
      if (!res.ok) {
        dismissed.restore(threadId);
        setBulkError("Archive failed");
        return;
      }
      swipeUndoSeq.current += 1;
      setSwipeUndo({ threadId, key: swipeUndoSeq.current });
      router.refresh();
    });
  }

  async function undoSwipeArchive(threadId: string) {
    const res = await fetch(`/api/threads/${threadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
    setSwipeUndo(null);
    if (!res.ok) {
      setBulkError("Undo failed");
      return;
    }
    // Bring the row back into view; otherwise the optimistic dismiss from
    // archiveOneFromSwipe keeps it hidden client-side even though the
    // server has re-surfaced it.
    dismissed.restore(threadId);
    router.refresh();
  }

  const allSelected = threads.length > 0 && selected.size === threads.length;
  const someSelected = selected.size > 0 && !allSelected;

  // Group threads into contiguous date buckets. We iterate in arrival order
  // (the server already sorts by last_message_at desc) and emit a new group
  // each time the bucket label changes — this preserves overall ordering
  // even if a row's bucket doesn't strictly follow the server sort. A
  // stable `now` is captured on each render so all rows in this paint share
  // the same "today".
  const groups = useMemo(() => {
    const now = Date.now();
    const out: { label: string; items: ThreadListItem[] }[] = [];
    // Group `renderThreads` (not the logical `threads`) so a row mid-exit keeps
    // its place in its date bucket while it collapses.
    for (const t of renderThreads) {
      const label = dateBucket(t.last_message_at, now);
      const last = out[out.length - 1];
      if (last && last.label === label) {
        last.items.push(t);
      } else {
        out.push({ label, items: [t] });
      }
    }
    return out;
  }, [renderThreads]);

  // Flat position of each rendered row, used to stagger the entrance animation.
  const orderIndex = useMemo(() => {
    const m = new Map<string, number>();
    renderThreads.forEach((t, i) => m.set(t.id, i));
    return m;
  }, [renderThreads]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {categoryTabsEnabled && <CategoryTabs />}
      {triageEnabled && (
        <TriageBar current={quadrant} onChange={navigateToQuadrant} />
      )}

      {selected.size > 0 && (
        <div className="sticky top-0 z-20 flex items-center gap-2 border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm">
          <span className="text-neutral-600 dark:text-neutral-400">
            {selected.size} selected
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={bulkArchive}
              disabled={bulkBusy}
              className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2.5 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
            >
              Archive
            </button>
            <button
              type="button"
              onClick={bulkMarkRead}
              disabled={bulkBusy}
              className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2.5 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
            >
              Mark as read
            </button>
            <div ref={labelMenuRef} className="relative">
              <button
                type="button"
                onClick={() => (labelMenuOpen ? setLabelMenuOpen(false) : void openLabelMenu())}
                disabled={bulkBusy}
                className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2.5 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
              >
                Apply label
              </button>
              {labelMenuOpen && (
                <div
                  className="absolute right-0 top-full mt-1 z-30 w-56 max-h-64 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg"
                  role="menu"
                >
                  {availableLabels === null && (
                    <div className="px-3 py-2 text-xs text-neutral-500">Loading…</div>
                  )}
                  {availableLabels && availableLabels.length === 0 && (
                    <div className="px-3 py-2 text-xs text-neutral-500">
                      No labels yet.
                    </div>
                  )}
                  {availableLabels && availableLabels.length > 0 && (
                    <ul className="py-1">
                      {availableLabels.map(l => (
                        <li key={l.id}>
                          <button
                            type="button"
                            onClick={() => bulkApplyLabel(l.id)}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900"
                          >
                            <span
                              aria-hidden
                              className="inline-block w-2.5 h-2.5 rounded-full"
                              style={{ backgroundColor: l.color ?? "#9ca3af" }}
                            />
                            <span className="truncate">{l.name}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={bulkDelete}
              disabled={bulkBusy}
              className="rounded-md border border-neutral-300 dark:border-neutral-700 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              disabled={bulkBusy}
              className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-50"
              aria-label="Clear selection"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {bulkError && (
        <div className="px-3 py-1.5 text-xs text-red-600 bg-red-50 dark:bg-red-950/30 border-b border-red-200 dark:border-red-900/40">
          {bulkError}
        </div>
      )}

      {renderThreads.length === 0 ? (
        <EmptyState
          // The unified inbox reaching empty is the triage payoff, so it gets
          // the celebratory inbox_zero treatment. Per-mailbox / VIP empties are
          // ordinary states and keep the quiet neutral styling.
          variant={scope === "all" ? "inbox_zero" : "inbox"}
          title={scope === "vips" ? "No VIP mail yet" : undefined}
          body={
            scope === "vips"
              ? "Mark a sender as VIP from any message menu to see their mail here."
              : undefined
          }
        />
      ) : (
        <ul
          ref={listRef}
          className="flex-1 overflow-y-auto divide-y divide-neutral-200 dark:divide-neutral-800"
        >
          {threads.length > 0 && (
            <li className="px-4 py-2 flex items-center gap-3 text-xs text-neutral-500 bg-neutral-50/60 dark:bg-neutral-900/30">
              <input
                type="checkbox"
                aria-label="Select all"
                checked={allSelected}
                ref={el => {
                  if (el) el.indeterminate = someSelected;
                }}
                onChange={e => toggleAll(e.target.checked)}
                className="cursor-pointer"
              />
              <span>{allSelected ? "All selected" : "Select all"}</span>
            </li>
          )}
          {groups.map(group => (
            // Fragment-grouped so the sticky header <li> and row <li>s remain
            // direct children of the outer <ul> (valid HTML, divide-y still
            // applies between rows). Keyed by bucket label which is unique
            // within the contiguous group sequence.
            <Fragment key={group.label}>
              <li
                role="separator"
                aria-label={group.label}
                // top-0 inside the scrolling <ul>; z-10 so headers sit above
                // row content but below the bulk-action bar (z-20).
                className="sticky top-0 z-10 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 bg-neutral-50/95 dark:bg-neutral-900/80 backdrop-blur border-y border-neutral-200 dark:border-neutral-800"
              >
                {group.label}
              </li>
              {group.items.map(t => (
                <ThreadRow
                  key={t.id}
                  thread={t}
                  scope={scope}
                  showDomain={showDomain}
                  isActive={activeThreadId === t.id}
                  isSelected={selected.has(t.id)}
                  isExiting={dismissed.isDismissed(t.id)}
                  enterIndex={orderIndex.get(t.id) ?? 0}
                  onExited={onExited}
                  onToggleSelect={on => toggleOne(t.id, on)}
                  onSwipeArchive={() => archiveOneFromSwipe(t.id)}
                />
              ))}
            </Fragment>
          ))}
        </ul>
      )}

      {swipeUndo && (
        <UndoToast
          key={`swipe-archive-${swipeUndo.key}`}
          message="Conversation archived"
          delaySeconds={SWIPE_UNDO_SECONDS}
          onUndo={() => undoSwipeArchive(swipeUndo.threadId)}
          onDismiss={() => setSwipeUndo(null)}
        />
      )}
    </div>
  );
}

function TriageBar({
  current,
  onChange,
}: {
  current: TriageQuadrant;
  onChange: (q: TriageQuadrant) => void;
}) {
  // Split-inbox strip: one tab per triage quadrant, ordered by how often you
  // act on it. "Primary action" (humans who need a reply) leads; "Quiet"
  // (humans, no action — the FYI lane); "Newsletters" (marketing, no action);
  // "Bulk action" (marketing that still wants something — receipts/verifies);
  // and "Show all" as the escape hatch. Mirrors Superhuman's Split Inbox:
  // several small, intent-scoped inboxes instead of one firehose.
  const items: TriageQuadrant[] = [
    "action_needed",
    "quiet_humans",
    "marketing_quiet",
    "marketing_action",
    "all",
  ];
  return (
    <div
      role="tablist"
      aria-label="Triage view"
      className="flex items-center gap-1 px-3 py-1.5 border-b border-neutral-200 dark:border-neutral-800 overflow-x-auto"
    >
      {items.map(q => {
        const active = q === current;
        return (
          <button
            key={q}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(q)}
            className={`shrink-0 rounded-full px-3 py-1 text-xs ${
              active
                ? "bg-[var(--color-brand)]/15 text-[var(--color-brand)] font-medium"
                : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900"
            }`}
          >
            {QUADRANT_LABELS[q]}
          </button>
        );
      })}
      {/* Mobile-only launcher for the swipe-through Triage deck. Desktop users
          have j/k + keyboard actions; the card deck is the touch equivalent. */}
      <button
        type="button"
        onClick={() => document.dispatchEvent(new CustomEvent("orange:open-triage"))}
        className="sm:hidden ml-auto shrink-0 rounded-full bg-[var(--color-brand)] px-3 py-1 text-xs font-medium text-white"
      >
        Triage
      </button>
    </div>
  );
}

// Exit timing. Slightly longer than the [data-thread-exit] CSS animation
// (150ms) so the collapse visually finishes before the row unmounts. Drives
// removal even under prefers-reduced-motion, where the animation is suppressed.
const EXIT_REMOVE_MS = 170;
// Entrance stagger. Each row's delay = index * STEP, capped at MAX_STEPS so a
// long list reveals over ~0.25s rather than rippling indefinitely.
const ENTER_STEP_MS = 18;
const ENTER_MAX_STEPS = 14;

interface ThreadRowProps {
  thread: ThreadListItem;
  scope: string;
  showDomain: boolean;
  isActive: boolean;
  isSelected: boolean;
  // True once the thread is optimistically dismissed (archived/deleted). The
  // row stays mounted to play its collapse animation; `onExited` then drops it.
  isExiting: boolean;
  // Flat position in the list, used to stagger the entrance animation.
  enterIndex: number;
  onExited: (id: string) => void;
  onToggleSelect: (on: boolean) => void;
  onSwipeArchive: () => void;
}

function ThreadRow({
  thread: t,
  scope,
  showDomain,
  isActive,
  isSelected,
  isExiting,
  enterIndex,
  onExited,
  onToggleSelect,
  onSwipeArchive,
}: ThreadRowProps) {
  // Once exiting, schedule the actual removal. Timer-based (not animationend)
  // so reduced-motion users — whose collapse animation is suppressed — still
  // get the row dropped. Cancels if the dismissal is undone before it fires.
  useEffect(() => {
    if (!isExiting) return;
    const id = t.id;
    const timer = setTimeout(() => onExited(id), EXIT_REMOVE_MS);
    return () => clearTimeout(timer);
  }, [isExiting, t.id, onExited]);
  const sender = senderLabel(t.last_from_addr, t.last_from_name);
  const subject = t.last_subject || "(no subject)";
  const isUnread = t.unread_count > 0;
  const avatarSeed = t.last_from_addr || sender;
  // Per-sender color flair (issue #48). The hue is hashed from the canonical
  // email so the same sender stays the same color even when their display
  // name varies across messages. We only render the bar on unread rows —
  // read rows would just be visual noise. The hsl() values use a low
  // saturation in light mode and a slightly lower lightness in dark so the
  // flair reads as a tint, not a stripe of paint.
  const flairHue = hashHue(t.last_from_addr || sender || "?");

  // Follow-up (issue #26). When the user has opted this thread in AND
  // `last_message_at` is older than the configured cadence, show a
  // subtle "Waiting on reply" badge. We can't tell here whether the
  // most-recent message is outbound — that check lives server-side in
  // listDueFollowups — so the badge may show on threads where the other
  // side replied but a server hop hasn't refreshed yet. Cheap, harmless:
  // the badge is informational, not actionable.
  const followUpThresholdMinutes =
    t.follow_up_enabled === 1
      ? t.follow_up_minutes ??
        (t.follow_up_days != null ? t.follow_up_days * 1440 : DEFAULT_FOLLOWUP_MINUTES)
      : null;
  const waitingMinutes =
    followUpThresholdMinutes !== null
      ? Math.floor((Date.now() / 1000 - t.last_message_at) / 60)
      : 0;
  // Floor display in days for the badge label (UI doesn't need
  // sub-day precision — a sub-day-cadence thread that crosses the
  // bar reads as "Waiting 0 days", which still flags the row).
  const waitingDays = Math.floor(waitingMinutes / 1440);
  const showWaitingBadge =
    followUpThresholdMinutes !== null && waitingMinutes >= followUpThresholdMinutes;

  // Swipe state lives per-row so simultaneous swipes don't fight. Translate
  // is applied as inline style during the gesture for fluidity, then snapped
  // back via a CSS transition class once the gesture ends.
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [dragX, setDragX] = useState(0);
  const [animating, setAnimating] = useState(false);

  function onTouchStart(e: React.TouchEvent<HTMLLIElement>) {
    const t0 = e.touches[0];
    startRef.current = { x: t0.clientX, y: t0.clientY };
    setAnimating(false);
  }

  function onTouchMove(e: React.TouchEvent<HTMLLIElement>) {
    const start = startRef.current;
    if (!start) return;
    const t0 = e.touches[0];
    const dx = t0.clientX - start.x;
    const dy = t0.clientY - start.y;
    // Lock out vertical drags so the page can still scroll naturally.
    if (Math.abs(dy) > SWIPE_MAX_VERTICAL_PX && Math.abs(dy) > Math.abs(dx)) {
      startRef.current = null;
      setDragX(0);
      return;
    }
    // Only track left swipes — right swipe could become its own gesture later.
    if (dx >= 0) {
      setDragX(0);
      return;
    }
    setDragX(dx);
  }

  function onTouchEnd() {
    const start = startRef.current;
    startRef.current = null;
    if (!start) {
      setDragX(0);
      return;
    }
    setAnimating(true);
    if (dragX <= -SWIPE_THRESHOLD_PX) {
      // Slide out fully then trigger archive — visually finishes the gesture
      // before the row disappears via router refresh.
      setDragX(-window.innerWidth);
      setTimeout(() => {
        setDragX(0);
        onSwipeArchive();
      }, 150);
    } else {
      setDragX(0);
    }
  }

  function onTouchCancel() {
    startRef.current = null;
    setAnimating(true);
    setDragX(0);
  }

  const swiping = dragX < 0;
  const archiveRevealed = dragX <= -SWIPE_THRESHOLD_PX / 2;

  return (
    <li
      data-thread-id={t.id}
      // Exit (collapse+fade) vs entrance (staggered fade-rise) are mutually
      // exclusive — see the [data-thread-exit] / [data-thread-enter] rules in
      // globals.css. The entrance delay is set inline from the row's position.
      {...(isExiting
        ? { "data-thread-exit": "" }
        : { "data-thread-enter": "" })}
      style={
        isExiting
          ? undefined
          : { animationDelay: `${Math.min(enterIndex, ENTER_MAX_STEPS) * ENTER_STEP_MS}ms` }
      }
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
      className="relative overflow-hidden"
    >
      {swiping && (
        <div
          aria-hidden
          className={`md:hidden absolute inset-y-0 right-0 flex items-center justify-end pr-4 text-xs font-medium ${
            archiveRevealed
              ? "bg-[var(--color-brand)] text-white"
              : "bg-neutral-200 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300"
          }`}
          style={{ width: Math.min(-dragX, window.innerWidth) }}
        >
          Archive
        </div>
      )}
      <div
        style={{
          transform: swiping ? `translateX(${dragX}px)` : undefined,
          transition: animating ? "transform 150ms ease-out" : undefined,
        }}
        className="bg-white dark:bg-neutral-950 relative"
      >
        {isUnread && (
          <span
            aria-hidden
            className="absolute left-0 top-0 bottom-0 w-[3px] dark:hidden"
            style={{ backgroundColor: `hsl(${flairHue} 55% 60%)` }}
          />
        )}
        {isUnread && (
          <span
            aria-hidden
            className="absolute left-0 top-0 bottom-0 w-[3px] hidden dark:block"
            style={{ backgroundColor: `hsl(${flairHue} 45% 38%)` }}
          />
        )}
        <div className="flex items-stretch">
          <label
            className={`flex items-center justify-center pl-3 pr-2 cursor-pointer ${
              isActive ? "bg-[var(--color-brand)]/10" : ""
            }`}
            onClick={e => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={isSelected}
              onChange={e => onToggleSelect(e.target.checked)}
              aria-label={`Select ${sender}`}
              className="cursor-pointer"
            />
          </label>
          <Link
            data-thread-row
            href={`/inbox/${encodeURIComponent(scope)}/${t.id}`}
            style={{
              paddingTop: "var(--row-py)",
              paddingBottom: "var(--row-py)",
              paddingRight: "var(--row-px)",
            }}
            className={`flex-1 min-w-0 block ${
              isActive
                ? "bg-[var(--color-brand)]/10"
                : "hover:bg-neutral-100 dark:hover:bg-neutral-900"
            }`}
          >
            <div className="flex items-start gap-3">
              <Avatar seed={avatarSeed} label={sender} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span
                    className={`truncate flex-1 text-sm ${
                      isUnread
                        ? "font-semibold text-neutral-900 dark:text-neutral-100"
                        : "text-neutral-700 dark:text-neutral-300"
                    }`}
                  >
                    {sender}
                  </span>
                  {t.starred === 1 && (
                    <span
                      className="shrink-0 text-xs text-yellow-500"
                      aria-label="Starred"
                      title="Starred"
                    >
                      ★
                    </span>
                  )}
                  <span className="shrink-0 text-xs text-neutral-500">
                    {formatThreadDate(t.last_message_at)}
                  </span>
                </div>
                <div
                  className={`flex items-center gap-1.5 min-w-0 text-sm ${
                    isUnread ? "font-medium" : "text-neutral-700 dark:text-neutral-300"
                  }`}
                >
                  {t.labels.length > 0 && (
                    <span className="flex items-center gap-1 shrink-0">
                      {t.labels.map(l => (
                        <LabelChip key={l.id} name={l.name} color={l.color} />
                      ))}
                    </span>
                  )}
                  <span className="truncate min-w-0">
                    {subject}
                    {t.message_count > 1 && (
                      <span className="ml-1 text-xs text-neutral-500">
                        ({t.message_count})
                      </span>
                    )}
                  </span>
                  {showWaitingBadge && (
                    <span
                      className="shrink-0 inline-flex items-center gap-1 rounded-md bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 px-1.5 py-0.5 text-[10px] font-medium"
                      title={`Waiting on reply — ${waitingDays} day${waitingDays === 1 ? "" : "s"}`}
                    >
                      ⏰ Waiting {waitingDays}d
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-neutral-500">{t.last_snippet || ""}</div>
                {showDomain && (
                  <div className="mt-1 text-[10px] uppercase tracking-wider text-neutral-400">
                    {t.domain_name}
                  </div>
                )}
              </div>
            </div>
          </Link>
        </div>
      </div>
    </li>
  );
}
