"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Props {
  messageId: string;
  // Sender address — used for the confirmation prompt and to hide block/spam
  // for outbound messages (you can't usefully block yourself).
  fromAddr: string;
  direction: "inbound" | "outbound";
  // True when `fromAddr` is in the current user's VIP list. Determines
  // whether the menu offers "Add to VIPs" or "Remove from VIPs".
  isVip?: boolean;
}

export default function MessageMenu({ messageId, fromAddr, direction, isVip = false }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Move focus to first menuitem on open so arrow keys work immediately.
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, [open]);

  function focusItem(delta: 1 | -1 | "first" | "last") {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? items.indexOf(active) : -1;
    let next: number;
    if (delta === "first") next = 0;
    else if (delta === "last") next = items.length - 1;
    else if (idx === -1) next = delta === 1 ? 0 : items.length - 1;
    else next = (idx + delta + items.length) % items.length;
    items[next].focus();
  }

  function onMenuKey(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusItem(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        focusItem(-1);
        return;
      case "Home":
        e.preventDefault();
        focusItem("first");
        return;
      case "End":
        e.preventDefault();
        focusItem("last");
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      case "Tab":
        // Treat Tab as "close and let focus continue" — matches native menus.
        setOpen(false);
        return;
    }
  }

  function onTriggerKey(e: React.KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setOpen(true);
    }
  }

  function runAction(
    path: string,
    confirmMsg: string,
    onSuccessNavigateAway: boolean,
  ) {
    if (!confirm(confirmMsg)) return;
    setOpen(false);
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/messages/${messageId}/${path}`, { method: "POST" });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      if (onSuccessNavigateAway) {
        // Both block-sender and report-spam archive the thread, so the
        // current view is no longer in the active scope. Bounce to All Mail
        // (mirrors what ThreadActions does on archive/delete).
        router.push("/inbox/all");
      }
      router.refresh();
    });
  }

  const canBlock = direction === "inbound" && fromAddr;
  const canVip = !!fromAddr;

  function toggleVip() {
    setOpen(false);
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/me/vips", {
        method: isVip ? "DELETE" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ addr: fromAddr }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        onKeyDown={onTriggerKey}
        disabled={isPending}
        title="More"
        aria-label="More message options"
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded-md border border-transparent p-1 text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-200 disabled:opacity-50"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M8 4a1.25 1.25 0 1 0 0-2.5A1.25 1.25 0 0 0 8 4Zm0 5.25A1.25 1.25 0 1 0 8 6.75a1.25 1.25 0 0 0 0 2.5Zm0 5.25A1.25 1.25 0 1 0 8 12a1.25 1.25 0 0 0 0 2.5Z" />
        </svg>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Message actions"
          onKeyDown={onMenuKey}
          className="absolute right-0 top-full mt-1 z-30 w-56 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg"
        >
          <a
            href={`/api/messages/${messageId}/raw`}
            target="_blank"
            rel="noopener noreferrer"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 focus:bg-neutral-100 dark:focus:bg-neutral-900 focus:outline-none"
          >
            View original
          </a>
          {canVip && (
            <>
              <div className="border-t border-neutral-200 dark:border-neutral-800" />
              <button
                type="button"
                role="menuitem"
                onClick={toggleVip}
                className="block w-full text-left px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 focus:bg-neutral-100 dark:focus:bg-neutral-900 focus:outline-none"
              >
                {isVip ? "Remove from VIPs" : "Add to VIPs"}
              </button>
            </>
          )}
          {canBlock && (
            <>
              <div className="border-t border-neutral-200 dark:border-neutral-800" />
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  runAction(
                    "block-sender",
                    `Block ${fromAddr}? Future mail from this address will be auto-archived.`,
                    true,
                  )
                }
                className="block w-full text-left px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 focus:bg-neutral-100 dark:focus:bg-neutral-900 focus:outline-none"
              >
                Block sender
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  runAction(
                    "report-spam",
                    `Report ${fromAddr} as spam? This blocks the sender and flags this message for the spam corpus.`,
                    true,
                  )
                }
                className="block w-full text-left px-3 py-2 text-sm text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 focus:bg-red-50 dark:focus:bg-red-950/40 focus:outline-none"
              >
                Report spam
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="absolute right-0 top-full mt-1 z-30 rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-2 py-1 text-xs text-red-700 dark:text-red-300 shadow"
        >
          {error}
        </div>
      )}
    </div>
  );
}
