"use client";

import { useState } from "react";
import ManageLabelsDialog from "./ManageLabelsDialog";

// Sidebar trigger for the labels manager. Visual style mirrors
// ManageMailboxButton / AddMailboxButton so the sidebar reads as one piece.
export default function ManageLabelsButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Manage labels"
        aria-label="Manage labels"
        className="w-full text-left rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-900 flex items-center gap-2"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h4.379a1.5 1.5 0 0 1 1.06.44l5.122 5.12a1.5 1.5 0 0 1 0 2.122l-4.379 4.378a1.5 1.5 0 0 1-2.121 0L2.44 8.94A1.5 1.5 0 0 1 2 7.879V3.5Zm3.25 2.25a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Z" />
        </svg>
        Manage labels
      </button>
      {open && <ManageLabelsDialog onClose={() => setOpen(false)} />}
    </>
  );
}
