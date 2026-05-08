"use client";

import { useState } from "react";
import ManageMembersDialog from "./ManageMembersDialog";

export default function ManageMailboxButton({
  mailboxId,
  mailboxLabel,
}: {
  mailboxId: string;
  mailboxLabel: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Manage members of ${mailboxLabel}`}
        aria-label={`Manage members of ${mailboxLabel}`}
        className="opacity-0 group-hover:opacity-100 transition-opacity rounded p-1 text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-800"
      >
        {/* people icon, plain SVG so we don't pull in an icon lib */}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M5.5 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm5 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM2 13.5C2 11.6 3.6 10 5.5 10s3.5 1.6 3.5 3.5V14H2v-.5Zm8 0c0-.9-.3-1.7-.8-2.4.4-.1.8-.1 1.3-.1 1.9 0 3.5 1.6 3.5 3.5v.5h-4v-1.5Z" />
        </svg>
      </button>
      {open && (
        <ManageMembersDialog
          mailboxId={mailboxId}
          mailboxLabel={mailboxLabel}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
