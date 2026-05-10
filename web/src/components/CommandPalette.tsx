"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";
import { useRouter } from "next/navigation";
import type {
  CommandPaletteBundle,
  CommandPaletteContact,
  CommandPaletteMailbox,
  CommandPaletteSavedSearch,
  CommandPaletteThread,
} from "@/app/api/command-palette/route";

// ──────────────────────────────────────────────────────────────────────────
// Match scoring
//
// We deliberately don't pull in cmdk / fuse.js / fzf.js — the palette's
// candidate list is small (≤ a few hundred items) and the user's input is
// usually a short token. A hand-rolled substring scorer is fast enough and
// keeps the bundle lean.
//
// Scoring rules, descending:
//   - exact match (case-insensitive) on a haystack string  → 1000
//   - prefix match on the haystack                         → 500 - position
//   - word-boundary infix match (after space/@/.)          → 200 - position
//   - generic infix match                                  → 100 - position
//
// Items with multiple haystacks (e.g. mailbox local_part + domain) take the
// max score across haystacks. A 0 score means "no match" and the item is
// filtered out entirely.
// ──────────────────────────────────────────────────────────────────────────

function scoreOne(haystack: string, needle: string): number {
  if (!haystack || !needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h === n) return 1000;
  if (h.startsWith(n)) return 500 - 0; // best non-exact
  // Word-boundary match — start of the needle aligns with the char after a
  // separator. This makes typing "set" find "Settings" before it finds
  // "asset" or "subscriptions".
  let pos = -1;
  for (let i = 1; i < h.length; i++) {
    const prev = h.charCodeAt(i - 1);
    const isBoundary =
      prev === 32 /* space */ ||
      prev === 64 /* @ */ ||
      prev === 46 /* . */ ||
      prev === 45 /* - */ ||
      prev === 95 /* _ */;
    if (isBoundary && h.startsWith(n, i)) {
      pos = i;
      break;
    }
  }
  if (pos >= 0) return Math.max(1, 200 - pos);
  const idx = h.indexOf(n);
  if (idx >= 0) return Math.max(1, 100 - idx);
  return 0;
}

function bestScore(needle: string, haystacks: string[]): number {
  let best = 0;
  for (const h of haystacks) {
    const s = scoreOne(h, needle);
    if (s > best) best = s;
  }
  return best;
}

// ──────────────────────────────────────────────────────────────────────────
// Item model — every row in the palette boils down to one of these.
// ──────────────────────────────────────────────────────────────────────────

type ItemKind =
  | "action"
  | "mailbox"
  | "saved_search"
  | "thread"
  | "contact"
  | "view";

interface PaletteItem {
  key: string;
  kind: ItemKind;
  title: string;
  subtitle?: string;
  hint?: string;
  // Strings the scorer searches against. Title is implicit; extras boost
  // matches via alternate identifiers (mailbox @-address, contact email …).
  haystacks: string[];
  // What pressing Enter does. Caller invokes; the palette closes regardless.
  activate: (router: ReturnType<typeof useRouter>) => void;
}

// ──────────────────────────────────────────────────────────────────────────
// State machine — useReducer keeps query/selection in lockstep so the
// keyboard handler never reaches into stale state.
// ──────────────────────────────────────────────────────────────────────────

interface PaletteState {
  query: string;
  selected: number;
}

type PaletteAction =
  | { type: "set_query"; query: string }
  | { type: "move"; delta: number; max: number }
  | { type: "set_selected"; index: number }
  | { type: "reset" };

function reduce(state: PaletteState, action: PaletteAction): PaletteState {
  switch (action.type) {
    case "set_query":
      // Any input edit resets the cursor to the top — keeps "type a few chars,
      // hit Enter" behaviour predictable.
      return { query: action.query, selected: 0 };
    case "move": {
      if (action.max <= 0) return { ...state, selected: 0 };
      let next = state.selected + action.delta;
      if (next < 0) next = action.max - 1;
      if (next >= action.max) next = 0;
      return { ...state, selected: next };
    }
    case "set_selected":
      return { ...state, selected: action.index };
    case "reset":
      return { query: "", selected: 0 };
    default:
      return state;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
}

// Module-level cache — survives re-renders, including unmount/remount, since
// the palette is conditionally rendered. SWR-style: serve stale on open, then
// refetch in the background. 60s freshness window.
let bundleCache: { at: number; data: CommandPaletteBundle } | null = null;
const CACHE_MS = 60_000;

export default function CommandPalette({ open, onClose }: Props) {
  const router = useRouter();
  const [state, dispatch] = useReducer(reduce, { query: "", selected: 0 });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // Force a re-render after the bundle arrives. We don't put `bundle` in state
  // because the cache itself is the source of truth across instances.
  const [, forceRerender] = useReducer(x => x + 1, 0);
  const bundle = bundleCache?.data ?? null;

  useEffect(() => {
    if (!open) return;
    const fresh = bundleCache && Date.now() - bundleCache.at < CACHE_MS;
    if (fresh) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/command-palette", {
          credentials: "same-origin",
        });
        if (!r.ok) return;
        const data = (await r.json()) as CommandPaletteBundle;
        if (cancelled) return;
        bundleCache = { at: Date.now(), data };
        forceRerender();
      } catch {
        // Silent — the palette still works with action-only items.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset every time we open so the user starts on a clean slate. Focus the
  // input on the next frame; opening the dialog mounts the input but focusing
  // synchronously fights the parent ⌘K keydown's default action.
  useEffect(() => {
    if (!open) return;
    dispatch({ type: "reset" });
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    return buildItems(bundle);
  }, [bundle]);

  // Filter + score in a single pass. Empty query keeps the natural order
  // (actions first, then mailboxes, then recents) so the palette is useful as
  // a quick-jump even before the user types.
  const ranked = useMemo<PaletteItem[]>(() => {
    const q = state.query.trim();
    if (!q) return items;
    const scored: { item: PaletteItem; score: number }[] = [];
    for (const item of items) {
      const haystacks = [item.title, ...(item.haystacks ?? [])];
      if (item.subtitle) haystacks.push(item.subtitle);
      const s = bestScore(q, haystacks);
      if (s > 0) scored.push({ item, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.item);
  }, [items, state.query]);

  // Keep selected in range (e.g. typing trims the result list below the
  // current cursor). The reducer enforces wrap on move; here we just clamp.
  useEffect(() => {
    if (state.selected >= ranked.length && ranked.length > 0) {
      dispatch({ type: "set_selected", index: 0 });
    }
  }, [ranked.length, state.selected]);

  // Scroll the active row into view when navigating with the keyboard.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLLIElement>(
      `[data-palette-index="${state.selected}"]`,
    );
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [state.selected]);

  function activate(item: PaletteItem) {
    onClose();
    item.activate(router);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        dispatch({ type: "move", delta: 1, max: ranked.length });
        return;
      case "ArrowUp":
        e.preventDefault();
        dispatch({ type: "move", delta: -1, max: ranked.length });
        return;
      case "Enter":
        e.preventDefault();
        if (ranked[state.selected]) activate(ranked[state.selected]);
        return;
      case "Escape":
        e.preventDefault();
        onClose();
        return;
      default:
        // Letters / Backspace / etc. flow into the input handler — we deliberately
        // don't intercept anything else.
        return;
    }
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-xl flex flex-col max-h-[70vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="border-b border-neutral-200 dark:border-neutral-800 px-3 py-2">
          <input
            ref={inputRef}
            type="text"
            value={state.query}
            onChange={e =>
              dispatch({ type: "set_query", query: e.target.value })
            }
            onKeyDown={onKeyDown}
            placeholder="Jump to a mailbox, thread, contact, or action…"
            aria-label="Command palette search"
            className="w-full bg-transparent px-1 py-1.5 text-sm focus:outline-none"
          />
        </div>
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Command palette results"
          className="flex-1 overflow-y-auto py-1"
        >
          {ranked.length === 0 ? (
            <li className="px-4 py-3 text-sm text-neutral-500">
              No matches. Try a different query.
            </li>
          ) : (
            ranked.map((item, i) => (
              <Row
                key={item.key}
                item={item}
                index={i}
                active={i === state.selected}
                onHover={() =>
                  dispatch({ type: "set_selected", index: i })
                }
                onActivate={() => activate(item)}
              />
            ))
          )}
        </ul>
        <div className="border-t border-neutral-200 dark:border-neutral-800 px-3 py-1.5 text-[11px] text-neutral-500 flex items-center gap-3">
          <KeyHint label="↑ ↓" desc="Navigate" />
          <KeyHint label="↵" desc="Open" />
          <KeyHint label="Esc" desc="Close" />
        </div>
      </div>
    </div>
  );
}

function Row({
  item,
  index,
  active,
  onHover,
  onActivate,
}: {
  item: PaletteItem;
  index: number;
  active: boolean;
  onHover: () => void;
  onActivate: () => void;
}) {
  return (
    <li
      role="option"
      aria-selected={active}
      data-palette-index={index}
      onMouseEnter={onHover}
      onClick={onActivate}
      className={`flex items-center gap-3 px-3 py-2 cursor-pointer text-sm ${
        active
          ? "bg-[var(--color-brand)]/15"
          : "hover:bg-neutral-100 dark:hover:bg-neutral-900"
      }`}
    >
      <KindIcon kind={item.kind} />
      <div className="flex-1 min-w-0">
        <div className="truncate text-neutral-900 dark:text-neutral-100">
          {item.title}
        </div>
        {item.subtitle && (
          <div className="truncate text-xs text-neutral-500">
            {item.subtitle}
          </div>
        )}
      </div>
      {item.hint && (
        <span className="text-[11px] uppercase tracking-wider text-neutral-400 shrink-0">
          {item.hint}
        </span>
      )}
    </li>
  );
}

function KindIcon({ kind }: { kind: ItemKind }) {
  // Single-character glyphs keep the bundle small; the kind drives the colour
  // accent so the palette is scannable even before reading titles.
  const map: Record<ItemKind, { glyph: string; tone: string }> = {
    action: { glyph: "⚡", tone: "text-amber-500" },
    mailbox: { glyph: "✉", tone: "text-[var(--color-brand)]" },
    saved_search: { glyph: "★", tone: "text-purple-500" },
    thread: { glyph: "#", tone: "text-blue-500" },
    contact: { glyph: "@", tone: "text-emerald-500" },
    view: { glyph: "▦", tone: "text-neutral-500" },
  };
  const m = map[kind];
  return (
    <span
      aria-hidden
      className={`inline-flex items-center justify-center w-6 h-6 rounded text-sm shrink-0 ${m.tone}`}
    >
      {m.glyph}
    </span>
  );
}

function KeyHint({ label, desc }: { label: string; desc: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <kbd className="rounded border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 px-1 py-px text-[10px] font-mono">
        {label}
      </kbd>
      <span>{desc}</span>
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Item builders — each section produces a flat list of PaletteItems, and the
// section ordering in the no-query view is the order they're concatenated
// here (actions → views → mailboxes → saved searches → threads → contacts).
// ──────────────────────────────────────────────────────────────────────────

function buildItems(bundle: CommandPaletteBundle | null): PaletteItem[] {
  return [
    ...buildActionItems(),
    ...buildViewItems(),
    ...buildMailboxItems(bundle?.mailboxes ?? []),
    ...buildDomainItems(bundle?.domains ?? [], bundle?.mailboxes ?? []),
    ...buildSavedSearchItems(bundle?.savedSearches ?? []),
    ...buildThreadItems(bundle?.recentThreads ?? []),
    ...buildContactItems(bundle?.contacts ?? []),
  ];
}

function buildActionItems(): PaletteItem[] {
  return [
    {
      key: "action:compose",
      kind: "action",
      title: "Compose",
      subtitle: "New message",
      hint: "Action",
      haystacks: ["new", "write", "mail"],
      activate: () => {
        // The compose flow is owned by ComposeProvider — its trigger button
        // listens for the global "compose" data-action selector. Dispatch
        // through that path so we don't double-implement opening.
        const btn = document.querySelector<HTMLElement>(
          '[data-action="compose"]',
        );
        if (btn) btn.click();
      },
    },
    {
      key: "action:shortcuts",
      kind: "action",
      title: "Show keyboard shortcuts",
      hint: "Action",
      haystacks: ["help", "cheatsheet", "?"],
      activate: () => {
        // KeyboardShortcuts.tsx listens for this custom event already.
        document.dispatchEvent(new CustomEvent("orange:show-shortcuts"));
      },
    },
  ];
}

function buildViewItems(): PaletteItem[] {
  // The "go to" navigation entries — these don't depend on the bundle and
  // surface the global views the sidebar can reach.
  const views: { label: string; href: string; alts?: string[] }[] = [
    { label: "Go to Inbox", href: "/inbox/all", alts: ["all", "inboxes"] },
    { label: "Go to VIPs", href: "/inbox/vips", alts: ["vip", "important"] },
    { label: "Go to Drafts", href: "/inbox/drafts" },
    { label: "Go to Contacts", href: "/inbox/contacts", alts: ["people"] },
    { label: "Go to Templates", href: "/inbox/templates" },
    {
      label: "Go to Subscriptions",
      href: "/inbox/subscriptions",
      alts: ["unsubscribe", "newsletters"],
    },
    { label: "Go to Storage", href: "/inbox/settings#storage", alts: ["usage", "quota"] },
    { label: "Go to Settings", href: "/inbox/settings", alts: ["preferences"] },
    { label: "Go to Help", href: "/inbox/help", alts: ["docs", "support"] },
  ];
  return views.map(v => ({
    key: `view:${v.href}`,
    kind: "view",
    title: v.label,
    hint: "View",
    haystacks: v.alts ?? [],
    activate: router => router.push(v.href),
  }));
}

function buildMailboxItems(mailboxes: CommandPaletteMailbox[]): PaletteItem[] {
  return mailboxes.map(mb => {
    const addr = `${mb.local_part}@${mb.domain_name}`;
    return {
      key: `mailbox:${mb.id}`,
      kind: "mailbox",
      title: addr,
      subtitle: mb.is_catch_all ? "Catch-all mailbox" : "Mailbox",
      hint: "Mailbox",
      haystacks: [mb.local_part, mb.domain_name, addr],
      activate: router => router.push(`/inbox/${mb.id}`),
    };
  });
}

function buildDomainItems(
  domains: { id: string; name: string }[],
  mailboxes: CommandPaletteMailbox[],
): PaletteItem[] {
  // Only surface multi-mailbox domains as their own entry — for single-mailbox
  // domains, the mailbox row already gets you there and a domain entry would
  // be duplicate noise.
  const counts = new Map<string, number>();
  for (const mb of mailboxes) {
    counts.set(mb.domain_name, (counts.get(mb.domain_name) ?? 0) + 1);
  }
  return domains
    .filter(d => (counts.get(d.name) ?? 0) > 1)
    .map(d => ({
      key: `domain:${d.id}`,
      kind: "mailbox",
      title: `All of ${d.name}`,
      subtitle: "Domain view",
      hint: "Domain",
      haystacks: [d.name],
      activate: router => router.push(`/inbox/domain:${d.id}`),
    }));
}

function buildSavedSearchItems(
  saved: CommandPaletteSavedSearch[],
): PaletteItem[] {
  return saved.map(s => ({
    key: `saved:${s.id}`,
    kind: "saved_search",
    title: s.name,
    subtitle: s.query,
    hint: "Smart Mailbox",
    haystacks: [s.query],
    activate: router =>
      router.push(`/search?q=${encodeURIComponent(s.query)}`),
  }));
}

function buildThreadItems(threads: CommandPaletteThread[]): PaletteItem[] {
  return threads.map(t => {
    const sender =
      t.from_name && t.from_name.trim()
        ? t.from_name.trim()
        : t.from_addr ?? "Unknown sender";
    return {
      key: `thread:${t.id}`,
      kind: "thread",
      title: t.subject || "(no subject)",
      subtitle: `${sender} — ${t.mailbox_local_part}@${t.domain_name}`,
      hint: "Recent",
      haystacks: [sender, t.from_addr ?? "", t.mailbox_local_part, t.domain_name],
      activate: router => router.push(`/inbox/${t.mailbox_id}/${t.id}`),
    };
  });
}

function buildContactItems(contacts: CommandPaletteContact[]): PaletteItem[] {
  return contacts.map(c => {
    const display = c.name?.trim() || c.email;
    return {
      key: `contact:${c.id}`,
      kind: "contact",
      title: display,
      subtitle: c.name ? c.email : undefined,
      hint: "Contact",
      haystacks: [c.email, c.name ?? ""],
      activate: router => router.push(`/inbox/contacts/${c.id}`),
    };
  });
}
