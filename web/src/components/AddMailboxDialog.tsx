"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export default function AddMailboxDialog({
  domainId,
  domainName,
  onClose,
}: {
  domainId: string;
  domainName: string;
  onClose: () => void;
}) {
  const [localPart, setLocalPart] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isCatchAll, setIsCatchAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Snapshotted at mount so we can restore focus to the trigger on close even
  // if the trigger itself unmounts (e.g. parent re-renders after a refresh).
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null,
  );

  // Esc to close + focus trap. Confines Tab/Shift+Tab to focusable descendants
  // of the dialog so keyboard users can't escape into the obscured background.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(el => el.offsetParent !== null || el === document.activeElement);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && active === last) {
        first.focus();
        e.preventDefault();
      }
    }
    document.addEventListener("keydown", onKey);
    const opener = openerRef.current;
    return () => {
      document.removeEventListener("keydown", onKey);
      // Return focus to whatever the user was on before opening the dialog.
      if (opener && typeof opener.focus === "function") opener.focus();
    };
  }, [onClose]);

  function submit() {
    setError(null);
    const trimmed = localPart.trim().toLowerCase();
    if (!trimmed) {
      setError("Enter a local part");
      return;
    }
    startTransition(async () => {
      const res = await fetch("/api/mailboxes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          domain_id: domainId,
          local_part: trimmed,
          display_name: displayName.trim() || undefined,
          is_catch_all: isCatchAll,
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      const json = (await res.json()) as { mailbox: { id: string } };
      onClose();
      router.refresh();
      router.push(`/inbox/${json.mailbox.id}`);
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={e => e.stopPropagation()}
        className="w-full max-w-md rounded-lg bg-white dark:bg-neutral-950 shadow-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden"
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
          <div>
            <div id={titleId} className="text-sm font-medium">Add mailbox</div>
            <div className="text-xs text-neutral-600 dark:text-neutral-400">on {domainName}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-1 text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 text-xl leading-none"
            aria-label="Close dialog"
          >
            ×
          </button>
        </header>

        <div className="px-4 py-3 space-y-3 text-sm">
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-neutral-600 dark:text-neutral-400">Address</span>
            <div className="mt-1 flex items-center gap-1">
              <input
                autoFocus
                type="text"
                value={localPart}
                placeholder="support"
                onChange={e => setLocalPart(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") submit();
                }}
                className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 focus:outline-none focus:border-[var(--color-brand)]"
              />
              <span className="text-neutral-600 dark:text-neutral-400 px-1">@{domainName}</span>
            </div>
          </label>

          <label className="block">
            <span className="text-xs uppercase tracking-wider text-neutral-600 dark:text-neutral-400">
              Display name (optional)
            </span>
            <input
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder="Support Team"
              className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 focus:outline-none focus:border-[var(--color-brand)]"
            />
          </label>

          <label className="flex items-center gap-2 text-neutral-700 dark:text-neutral-300">
            <input
              type="checkbox"
              checked={isCatchAll}
              onChange={e => setIsCatchAll(e.target.checked)}
            />
            <span>
              Catch-all{" "}
              <span className="text-xs text-neutral-600 dark:text-neutral-400">
                — receive mail addressed to anything else on this domain
              </span>
            </span>
          </label>

          {error && <div role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</div>}
        </div>

        <footer className="flex items-center justify-end gap-2 px-4 py-3 border-t border-neutral-200 dark:border-neutral-800">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={isPending}
            className="rounded-md bg-[var(--color-brand)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {isPending ? "Creating…" : "Create"}
          </button>
        </footer>
      </div>
    </div>
  );
}
