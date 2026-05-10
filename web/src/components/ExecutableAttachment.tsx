"use client";

import { useEffect, useId, useRef, useState } from "react";

interface Props {
  id: string;
  filename: string | null;
  size: number;
}

// Replacement for the plain <a download> chip when an attachment is flagged
// executable. Shows a red "⚠ Executable" badge and gates the actual download
// behind a confirm modal — the user has to acknowledge "I know what I'm
// doing" before the API will hand the file over (the route also enforces
// `?confirmed=1` server-side, so a savvy user can't just type the URL).
export default function ExecutableAttachment({ id, filename, size }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 px-3 py-1.5 text-xs hover:bg-red-100 dark:hover:bg-red-950/60"
        title="Flagged as executable — download requires confirmation"
      >
        <span
          className="inline-flex items-center gap-1 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white"
          aria-label="Executable attachment"
        >
          <span aria-hidden="true">⚠</span>
          Executable
        </span>
        <span className="font-medium truncate max-w-[16rem] text-red-900 dark:text-red-100">
          {filename || "attachment"}
        </span>
        <span className="text-red-700/70 dark:text-red-300/70">{formatBytes(size)}</span>
      </button>
      {open && (
        <ConfirmDialog
          id={id}
          filename={filename}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ConfirmDialog({
  id,
  filename,
  onClose,
}: {
  id: string;
  filename: string | null;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null,
  );

  // Esc-to-close + focus trap, matching AddMailboxDialog. The confirm button
  // is auto-focused on mount; the trap keeps Tab inside the dialog.
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
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
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
      if (opener && typeof opener.focus === "function") opener.focus();
    };
  }, [onClose]);

  function confirm() {
    // Trigger the download in a hidden anchor — keeps the host page intact
    // and lets the browser surface its own download UI for executables.
    const a = document.createElement("a");
    a.href = `/api/attachments/${encodeURIComponent(id)}?confirmed=1`;
    if (filename) a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    onClose();
  }

  const displayName = filename || "This file";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 shadow-xl"
      >
        <h2
          id={titleId}
          className="flex items-center gap-2 text-base font-semibold text-red-700 dark:text-red-400"
        >
          <span aria-hidden="true">⚠</span>
          Executable attachment
        </h2>
        <p className="mt-3 text-sm text-neutral-700 dark:text-neutral-300 break-words">
          <span className="font-medium">{displayName}</span> is an executable
          file. Open only if you trust the sender. Continue?
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            autoFocus
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
          >
            Download anyway
          </button>
        </div>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
