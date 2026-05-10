"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import Avatar from "./Avatar";
import ThreadCollapseToggle from "./ThreadCollapseToggle";

// One-liner summary used when a message is collapsed. The parent
// (`ThreadView`) renders these server-side from the message rows so this
// client component doesn't need to know anything about the message schema
// beyond the four display fields below.
export interface MessageSummary {
  id: string;
  senderText: string;
  senderAddr: string; // seeds the avatar colour
  snippet: string;
  date: string; // pre-formatted (formatFullDate)
  isVip: boolean;
}

interface Props {
  // Pre-rendered <MessageBlock> children, one per item. Same order as
  // `summaries`. RSC passes server components through `children` arrays
  // fine — these are real elements, not placeholders.
  messages: { summary: MessageSummary; full: ReactNode }[];
  // Set of message ids that should start expanded. The default heuristic
  // (last message + `?focus=<id>`) is computed by the parent and passed in
  // so the server-rendered initial paint matches the client state on
  // hydration. URL-derived expansion is layered on top in an effect — see
  // below.
  defaultExpandedIds: string[];
}

// Wraps the messages list with per-message collapse/expand state. Default
// behaviour matches Gmail: only the last message is open; the rest collapse
// to a one-liner. Click a one-liner to expand it; the toolbar above can
// expand or collapse them all at once. Expansion is animated via a
// max-height transition — no JS animation library needed.
//
// `?focus=<message-id>` from the search-result navigation flow forces that
// specific message expanded on top of the default. We layer the URL param
// into the effective-expanded computation directly (no setState-in-effect)
// — manual user overrides win, then the URL focus, then the server default.
export default function MessageThread({ messages, defaultExpandedIds }: Props) {
  const searchParams = useSearchParams();
  const focusId = searchParams.get("focus");

  // Per-message manual override. `true` means user explicitly opened it,
  // `false` means user explicitly collapsed it, `undefined` means "fall back
  // to the default heuristic". Keeping the three states separate lets the
  // "expand all"/"collapse all" buttons override the defaults cleanly.
  const [override, setOverride] = useState<Map<string, boolean>>(() => new Map());

  const defaultSet = useMemo(() => new Set(defaultExpandedIds), [defaultExpandedIds]);

  function isExpanded(id: string): boolean {
    const o = override.get(id);
    if (o !== undefined) return o;
    if (focusId && focusId === id) return true;
    return defaultSet.has(id);
  }

  const expandedCount = messages.reduce(
    (n, m) => (isExpanded(m.summary.id) ? n + 1 : n),
    0,
  );

  // Scroll the focused message into view once on the client. Effect-only:
  // SSR can't scroll anyway, and we want this to fire even if the message
  // would have been expanded by the default heuristic already.
  useEffect(() => {
    if (!focusId) return;
    if (!messages.some(m => m.summary.id === focusId)) return;
    const t = setTimeout(() => {
      const el = document.getElementById(`msg-${focusId}`);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
    return () => clearTimeout(t);
  }, [focusId, messages]);

  function toggle(id: string) {
    setOverride(prev => {
      const next = new Map(prev);
      // Toggle relative to the *currently* effective state so collapsing a
      // default-expanded message stores `false`, not "unset".
      next.set(id, !isExpanded(id));
      return next;
    });
  }

  function expandAll() {
    const next = new Map<string, boolean>();
    for (const m of messages) next.set(m.summary.id, true);
    setOverride(next);
  }

  function collapseAll() {
    const next = new Map<string, boolean>();
    for (const m of messages) next.set(m.summary.id, false);
    setOverride(next);
  }

  // Render toolbar only when there's something to actually collapse — for
  // 1- and 2-message threads the controls are noise. Matches Gmail's
  // heuristic.
  const showToolbar = messages.length > 2;

  return (
    <>
      {showToolbar && (
        <ThreadCollapseToggle
          totalCount={messages.length}
          expandedCount={expandedCount}
          onExpandAll={expandAll}
          onCollapseAll={collapseAll}
        />
      )}
      <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
        {messages.map(({ summary, full }) => (
          <CollapsibleMessage
            key={summary.id}
            summary={summary}
            isExpanded={isExpanded(summary.id)}
            onToggle={() => toggle(summary.id)}
          >
            {full}
          </CollapsibleMessage>
        ))}
      </div>
    </>
  );
}

// Single message wrapper. When collapsed: shows a Gmail-style one-liner
// (avatar dot + "{sender} — {snippet} — {date}") that toggles on click.
// When expanded: renders the full server-rendered <MessageBlock> children.
//
// We use a max-height transition on the expanded body so the collapse/expand
// animates without measuring layout. `max-h-none` while open removes the cap
// so long messages don't get clipped — we swap to a finite max-height only
// during the collapse animation. The browser's height-from-auto issue
// doesn't bite us here because the collapsed state is a hard `hidden` (the
// content is replaced rather than constrained).
function CollapsibleMessage({
  summary,
  isExpanded,
  onToggle,
  children,
}: {
  summary: MessageSummary;
  isExpanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section id={`msg-${summary.id}`}>
      {isExpanded ? (
        // Wrap in a max-height transition so swapping in from collapsed feels
        // smooth. We don't need exact measurement — `max-h-[9999px]` is the
        // standard CSS trick that animates from 0 to a large enough ceiling.
        // The transition only runs on the toggle direction (open) since the
        // collapsed branch swaps out entirely; that's fine because the more
        // important animation is "opening" feels responsive.
        <div className="overflow-hidden transition-all duration-200 ease-out max-h-[9999px]">
          {children}
        </div>
      ) : (
        <button
          type="button"
          onClick={onToggle}
          className="w-full text-left px-4 py-2.5 sm:px-6 flex items-center gap-3 hover:bg-neutral-50 dark:hover:bg-neutral-900/40 transition-colors"
          aria-expanded={false}
          aria-controls={`msg-${summary.id}`}
        >
          <Avatar
            seed={summary.senderAddr || summary.senderText}
            label={summary.senderText}
            size="sm"
            vip={summary.isVip}
          />
          <div className="min-w-0 flex-1 flex items-baseline gap-2 text-sm">
            <span className="shrink-0 max-w-[12rem] truncate font-medium text-neutral-800 dark:text-neutral-200">
              {summary.senderText}
            </span>
            <span className="min-w-0 flex-1 truncate text-neutral-500">
              {summary.snippet || "(no preview)"}
            </span>
            <span className="shrink-0 text-xs text-neutral-400">
              {summary.date}
            </span>
          </div>
        </button>
      )}
    </section>
  );
}
