"use client";

import { useEffect, useRef } from "react";
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
// fetches, so star/archive/label/reply all reuse their existing
// optimistic + UndoToast plumbing.
//
// `?` navigates to /inbox/help#shortcuts (the cheat sheet now lives as a
// regular Help section instead of a modal overlay).

const CHORD_TIMEOUT_MS = 1500;

export default function KeyboardShortcuts() {
  const router = useRouter();
  const pathname = usePathname();
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

    // `x` toggles the row's selection checkbox (Gmail parity). Clicking the
    // input fires its onChange, so this reuses ThreadList's selection state
    // and bulk-action bar without re-implementing anything.
    function toggleSelectCurrent() {
      const els = listEl();
      const idx = selectedIndexRef.current;
      if (idx < 0 || idx >= els.length) return;
      const box = els[idx].querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (box) box.click();
    }

    // `a` toggles the list's "Select all" checkbox (rendered whenever the
    // list is non-empty), driving ThreadList's toggleAll.
    function toggleSelectAll() {
      const box = document.querySelector<HTMLInputElement>(
        'input[aria-label="Select all"]',
      );
      if (box) box.click();
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
      if (isTypingTarget(e.target)) return;

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
        case "h":
          // Follow-up — the feature that replaced the removed snooze. Toggles
          // tracking on the open thread (data-action="follow-up").
          clickAction("follow-up");
          e.preventDefault();
          return;
        case "x":
          toggleSelectCurrent();
          e.preventDefault();
          return;
        case "a":
          toggleSelectAll();
          e.preventDefault();
          return;
        case "Escape":
          clearSelection();
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
        case "r":
          clickAction("reply");
          e.preventDefault();
          return;
        case "c":
          clickAction("compose");
          e.preventDefault();
          return;
        case "t":
          // Add to calendar — extract a date from the open thread and open a
          // prefilled event composer (data-action="add-event" in ThreadView).
          clickAction("add-event");
          e.preventDefault();
          return;
        case "/":
          focusSearch();
          e.preventDefault();
          return;
        case "?":
          router.push("/inbox/help#shortcuts");
          e.preventDefault();
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

    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
    };
  }, [router]);

  // The command palette's "Show keyboard shortcuts" action dispatches this
  // event. The cheat sheet lives as a Help section (not a modal), so route
  // there — same destination as the `?` shortcut. Previously nothing listened
  // and the action was inert.
  useEffect(() => {
    function onShow() {
      router.push("/inbox/help#shortcuts");
    }
    document.addEventListener("orange:show-shortcuts", onShow);
    return () => document.removeEventListener("orange:show-shortcuts", onShow);
  }, [router]);

  // Reset the selection when the route changes — selection-by-index is only
  // meaningful within a single rendered list.
  useEffect(() => {
    selectedIndexRef.current = -1;
  }, [pathname]);

  return null;
}
