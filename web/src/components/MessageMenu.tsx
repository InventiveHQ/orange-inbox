"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  messageId: string;
}

export default function MessageMenu({ messageId }: Props) {
  const [open, setOpen] = useState(false);
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

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="More"
        aria-label="More options"
        className="rounded-md border border-transparent p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-900 dark:hover:text-neutral-200"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M8 4a1.25 1.25 0 1 0 0-2.5A1.25 1.25 0 0 0 8 4Zm0 5.25A1.25 1.25 0 1 0 8 6.75a1.25 1.25 0 0 0 0 2.5Zm0 5.25A1.25 1.25 0 1 0 8 12a1.25 1.25 0 0 0 0 2.5Z" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-30 w-48 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg"
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
        </div>
      )}
    </div>
  );
}
