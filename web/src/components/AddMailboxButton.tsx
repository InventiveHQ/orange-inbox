"use client";

import { useState } from "react";
import AddMailboxDialog from "./AddMailboxDialog";

export default function AddMailboxButton({
  domainId,
  domainName,
}: {
  domainId: string;
  domainName: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Add mailbox to ${domainName}`}
        aria-label={`Add mailbox to ${domainName}`}
        className="rounded p-1 text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-800"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M8 1a.75.75 0 0 1 .75.75V7.25h5.5a.75.75 0 0 1 0 1.5h-5.5v5.5a.75.75 0 0 1-1.5 0v-5.5h-5.5a.75.75 0 0 1 0-1.5h5.5V1.75A.75.75 0 0 1 8 1Z" />
        </svg>
      </button>
      {open && <AddMailboxDialog domainId={domainId} domainName={domainName} onClose={() => setOpen(false)} />}
    </>
  );
}
