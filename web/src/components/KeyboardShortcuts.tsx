"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

// Gmail/Superhuman-style keyboard shortcuts for the inbox UI.
//
// The handler is mounted once in the inbox layout and listens at the document
// level. Selection state (which row in the list is highlighted) is tracked
// here in React; the rendered selection highlight is applied via DOM mutation
// since the rows are server-rendered and we don't want to hoist a context
// solely for keyboard nav.
//
// Action buttons in the existing UI carry data-action="<name>" attributes; the
// handler dispatches click()/focus() on those rather than re-implementing the
// fetches, so star/archive/snooze/label/reply all reuse their existing
// optimistic + UndoToast plumbing.
//
// Custom event "orange:show-shortcuts" opens the cheat-sheet modal — the
// Sidebar's "Keyboard shortcuts" footer button fires it.

const CHORD_TIMEOUT_MS = 1500;

export default function KeyboardShortcuts() {
  const router = useRouter();
  const pathname = usePathname();
  const [showCheatsheet, setShowCheatsheet] = useState(false);
  // selectedIndex is into the live document order of [data-thread-id] rows.
  // -1 means "nothing selected"; first j keypress moves to 0.
  const selectedIndexRef = useRef<number>(-1);
  const chordRef = useRef<{ key: string; expires: number } | null>(null);
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  useEffect(() => {
    function listEl(): HTMLLIElement[] {
      return Array.from(document.querySelectorAll<HTMLLIElement>("[data-thread-id]"));
    }

    function applySelection(idx: number) {
      const els = listEl();
      els.forEach((el, i) => {
        if (i === idx) {
          el.setAttribute("data-keyboard-selected", "true");
          el.classList.add(
            "ring-2",
            "ring-[var(--color-brand)]",
            "ring-inset",
          );
          el.scrollIntoView({ block: "nearest" });
        } else {
          el.removeAttribute("data-keyboard-selected");
          el.classList.remove("ring-2", "ring-[var(--color-brand)]", "ring-inset");
        }
      });
    }

    function clearSelection() {
      selectedIndexRef.current = -1;
      applySelection(-1);
    }

    function moveSelection(delta: number) {
      const els = listEl();
      if (els.length === 0) return;
      let next = selectedIndexRef.current + delta;
      if (next < 0) next = 0;
      if (next >= els.length) next = els.length - 1;
      selectedIndexRef.current = next;
      applySelection(next);
    }

    function openSelectedThread() {
      const els = listEl();
      const idx = selectedIndexRef.current;
      if (idx < 0 || idx >= els.length) return;
      const link = els[idx].querySelector<HTMLAnchorElement>("a[href]");
      if (link) link.click();
    }

    function clickAction(name: string) {
      // Prefer a button inside the current main viewport (thread detail);
      // otherwise click the first matching one anywhere on the page.
      const candidate =
        document.querySelector<HTMLElement>(`article [data-action="${name}"]`) ??
        document.querySelector<HTMLElement>(`[data-action="${name}"]`);
      if (candidate && !(candidate as HTMLButtonElement).disabled) candidate.click();
    }

    function focusAction(name: string) {
      const el = document.querySelector<HTMLElement>(`[data-action="${name}"]`);
      if (el) el.focus();
    }

    function focusSearch() {
      const el = document.getElementById("orange-search-input") as HTMLInputElement | null;
      if (el) {
        el.focus();
        el.select();
      }
    }

    function isTypingTarget(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (t.isContentEditable) return true;
      return false;
    }

    function inThreadDetail(): boolean {
      // /inbox/<scope>/<threadId>
      return /\/inbox\/[^/]+\/[^/]+/.test(pathnameRef.current ?? "");
    }

    function handleKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) {
        // Allow Esc to dismiss the cheatsheet even when an input is focused.
        if (e.key === "Escape" && showCheatsheet) {
          setShowCheatsheet(false);
          e.preventDefault();
        }
        return;
      }

      // Resolve any pending chord first.
      const now = Date.now();
      const chord = chordRef.current && chordRef.current.expires > now
        ? chordRef.current
        : null;
      if (chord) {
        chordRef.current = null;
        if (chord.key === "g") {
          if (e.key === "i") {
            router.push("/inbox/all");
            e.preventDefault();
            return;
          }
          if (e.key === "s") {
            router.push("/inbox/settings");
            e.preventDefault();
            return;
          }
          // Unrecognized continuation — fall through and treat as a fresh
          // keypress.
        }
      }

      switch (e.key) {
        case "j":
          moveSelection(1);
          e.preventDefault();
          return;
        case "k":
          moveSelection(-1);
          e.preventDefault();
          return;
        case "o":
        case "Enter":
          if (!inThreadDetail()) {
            openSelectedThread();
            e.preventDefault();
          }
          return;
        case "u":
          if (inThreadDetail()) {
            // Strip the threadId segment to return to the list.
            const parts = (pathnameRef.current ?? "").split("/").filter(Boolean);
            // ["inbox", scope, threadId]
            if (parts.length >= 3 && parts[0] === "inbox") {
              router.push(`/${parts[0]}/${parts[1]}`);
              clearSelection();
              e.preventDefault();
            }
          }
          return;
        case "e":
          clickAction("archive");
          e.preventDefault();
          return;
        case "#":
          clickAction("delete");
          e.preventDefault();
          return;
        case "s":
          clickAction("star");
          e.preventDefault();
          return;
        case "l":
          clickAction("label");
          e.preventDefault();
          return;
        case "b":
          clickAction("snooze");
          e.preventDefault();
          return;
        case "r":
          clickAction("reply");
          e.preventDefault();
          return;
        case "c":
          clickAction("compose");
          e.preventDefault();
          return;
        case "/":
          focusSearch();
          e.preventDefault();
          return;
        case "?":
          setShowCheatsheet(true);
          e.preventDefault();
          return;
        case "Escape":
          if (showCheatsheet) {
            setShowCheatsheet(false);
            e.preventDefault();
          }
          return;
        case "g":
          chordRef.current = { key: "g", expires: now + CHORD_TIMEOUT_MS };
          e.preventDefault();
          return;
        default:
          return;
      }
      // Make focus/touch reads happy — no-op.
      void focusAction;
    }

    function handleShowEvent() {
      setShowCheatsheet(true);
    }

    document.addEventListener("keydown", handleKey);
    document.addEventListener("orange:show-shortcuts", handleShowEvent);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("orange:show-shortcuts", handleShowEvent);
    };
  }, [router, showCheatsheet]);

  // Reset the selection when the route changes — selection-by-index is only
  // meaningful within a single rendered list.
  useEffect(() => {
    selectedIndexRef.current = -1;
  }, [pathname]);

  if (!showCheatsheet) return null;
  return <Cheatsheet onClose={() => setShowCheatsheet(false)} />;
}

function Cheatsheet({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 px-4 py-3">
          <h2 className="text-base font-semibold">Keyboard shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900"
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 px-4 py-4 text-sm">
          <Section title="Navigation">
            <Row keys={["j"]} desc="Next conversation" />
            <Row keys={["k"]} desc="Previous conversation" />
            <Row keys={["o", "Enter"]} desc="Open conversation" />
            <Row keys={["u"]} desc="Back to list" />
            <Row keys={["g", "i"]} desc="Go to All inboxes" />
            <Row keys={["g", "s"]} desc="Go to Settings" />
            <Row keys={["/"]} desc="Focus search" />
          </Section>
          <Section title="Actions">
            <Row keys={["e"]} desc="Archive" />
            <Row keys={["#"]} desc="Delete" />
            <Row keys={["s"]} desc="Star / unstar" />
            <Row keys={["l"]} desc="Apply label" />
            <Row keys={["b"]} desc="Snooze" />
            <Row keys={["r"]} desc="Reply" />
            <Row keys={["c"]} desc="Compose" />
            <Row keys={["?"]} desc="Show this cheatsheet" />
          </Section>
        </div>
        <footer className="border-t border-neutral-200 dark:border-neutral-800 px-4 py-2 text-xs text-neutral-500">
          Shortcuts are disabled while typing in inputs. Press Esc to close.
        </footer>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mt-2 mb-1 text-xs uppercase tracking-wider text-neutral-500">{title}</h3>
      <ul className="space-y-1">{children}</ul>
    </div>
  );
}

function Row({ keys, desc }: { keys: string[]; desc: string }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="text-neutral-700 dark:text-neutral-300">{desc}</span>
      <span className="flex items-center gap-1">
        {keys.map((k, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-neutral-400 text-xs">then</span>}
            <kbd className="inline-flex min-w-[1.5rem] justify-center rounded border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 px-1.5 py-0.5 text-xs font-mono">
              {k}
            </kbd>
          </span>
        ))}
      </span>
    </li>
  );
}
