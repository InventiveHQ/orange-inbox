"use client";

import { useCompose } from "./ComposeProvider";

export default function ReplyButton({
  replyToMessageId,
  preferredMailboxId,
  toAddrs,
  subject,
}: {
  replyToMessageId: string;
  preferredMailboxId: string;
  toAddrs: string[];
  subject: string;
}) {
  const compose = useCompose();
  return (
    <button
      type="button"
      onClick={() =>
        compose.open({
          replyToMessageId,
          preferredMailboxId,
          toAddrs,
          subject: subject.match(/^re:/i) ? subject : `Re: ${subject}`,
        })
      }
      className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900"
    >
      Reply
    </button>
  );
}
