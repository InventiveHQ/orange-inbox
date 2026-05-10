"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Props {
  messageId: string;
  // Sender address — used for the confirmation prompt and to hide block/spam
  // for outbound messages (you can't usefully block yourself).
  fromAddr: string;
  direction: "inbound" | "outbound";
}

export default function MessageMenu({ messageId, fromAddr, direction }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);

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

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={isPending}
        title="More"
        aria-label="More options"
        className="rounded-md border border-transparent p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-900 dark:hover:text-neutral-200 disabled:opacity-50"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M8 4a1.25 1.25 0 1 0 0-2.5A1.25 1.25 0 0 0 8 4Zm0 5.25A1.25 1.25 0 1 0 8 6.75a1.25 1.25 0 0 0 0 2.5Zm0 5.25A1.25 1.25 0 1 0 8 12a1.25 1.25 0 0 0 0 2.5Z" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-30 w-56 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg"
        >
          <a
            href={`/api/messages/${messageId}/raw`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900"
          >
            View original
          </a>
          {canBlock && (
            <>
              <div className="border-t border-neutral-200 dark:border-neutral-800" />
              <button
                type="button"
                onClick={() =>
                  runAction(
                    "block-sender",
                    `Block ${fromAddr}? Future mail from this address will be auto-archived.`,
                    true,
                  )
                }
                className="block w-full text-left px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                Block sender
              </button>
              <button
                type="button"
                onClick={() =>
                  runAction(
                    "report-spam",
                    `Report ${fromAddr} as spam? This blocks the sender and flags this message for the spam corpus.`,
                    true,
                  )
                }
                className="block w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
              >
                Report spam
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <div className="absolute right-0 top-full mt-1 z-30 rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-2 py-1 text-xs text-red-700 dark:text-red-300 shadow">
          {error}
        </div>
      )}
    </div>
  );
}
