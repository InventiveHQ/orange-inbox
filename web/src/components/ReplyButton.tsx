"use client";

import { useCompose } from "./ComposeProvider";

interface QuotedOriginal {
  fromAddr: string;
  fromName: string | null;
  // Unix seconds (matches ThreadMessage.date).
  date: number;
  // Plain-text body to quote. Falls back to the snippet for HTML-only
  // messages where text_body is null.
  text: string;
}

export default function ReplyButton({
  replyToMessageId,
  preferredMailboxId,
  toAddrs,
  subject,
  quoted,
}: {
  replyToMessageId: string;
  preferredMailboxId: string;
  toAddrs: string[];
  subject: string;
  // Original message metadata for the Gmail-style quoted reply block. When
  // omitted (e.g. callers that don't have message context), the reply opens
  // with no quote.
  quoted?: QuotedOriginal;
}) {
  const compose = useCompose();
  return (
    <button
      type="button"
      data-action="reply"
      onClick={() =>
        compose.open({
          replyToMessageId,
          preferredMailboxId,
          toAddrs,
          subject: subject.match(/^re:/i) ? subject : `Re: ${subject}`,
          quotedHtml: quoted ? buildQuotedHtml(quoted) : undefined,
        })
      }
      className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900"
    >
      Reply
    </button>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildQuotedHtml({ fromAddr, fromName, date, text }: QuotedOriginal): string {
  const dateStr = new Date(date * 1000).toLocaleString();
  const senderRaw = fromName?.trim()
    ? `${fromName.trim()} <${fromAddr}>`
    : fromAddr;
  const intro = `On ${escapeHtml(dateStr)}, ${escapeHtml(senderRaw)} wrote:`;
  const body = escapeHtml(text || "").replace(/\r?\n/g, "<br>");
  return (
    `<p>${intro}</p>` +
    `<blockquote type="cite" style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex;">` +
    body +
    `</blockquote>`
  );
}
