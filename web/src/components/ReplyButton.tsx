"use client";

import { useState } from "react";
import { useCompose } from "./ComposeProvider";
import { htmlToQuotedText } from "@/lib/html-text";

interface QuotedOriginal {
  fromAddr: string;
  fromName: string | null;
  // Unix seconds (matches ThreadMessage.date).
  date: number;
  // Plain-text body to quote. Falls back to the snippet for HTML-only
  // messages where text_body is null — for those we lazily fetch the HTML
  // body on click and strip it (see onClick handler).
  text: string;
}

export default function ReplyButton({
  replyToMessageId,
  preferredMailboxId,
  threadId,
  toAddrs,
  subject,
  quoted,
}: {
  replyToMessageId: string;
  preferredMailboxId: string;
  // Forwarded to the composer so "Send and archive" knows which thread to
  // PATCH. Optional — callers without thread context (currently none) get
  // a normal reply with no archive option.
  threadId?: string;
  toAddrs: string[];
  subject: string;
  // Original message metadata for the Gmail-style quoted reply block. When
  // omitted (e.g. callers that don't have message context), the reply opens
  // with no quote.
  quoted?: QuotedOriginal;
}) {
  const compose = useCompose();
  const [loading, setLoading] = useState(false);

  async function onClick() {
    if (!quoted) {
      compose.open({
        replyToMessageId,
        preferredMailboxId,
        threadId,
        toAddrs,
        subject: subject.match(/^re:/i) ? subject : `Re: ${subject}`,
      });
      return;
    }

    // Try the HTML body first — if it exists, the stripped version is more
    // faithful than text_body (which can be Quoted-Printable munged) and
    // certainly better than a 200-char snippet for HTML-only mail. The
    // endpoint 404s when html_r2_key is null, in which case we just use
    // the text we already had.
    setLoading(true);
    let quotedText = quoted.text;
    try {
      const res = await fetch(`/api/messages/${replyToMessageId}/html`, {
        cache: "no-store",
      });
      if (res.ok) {
        const html = await res.text();
        const stripped = htmlToQuotedText(html);
        if (stripped) quotedText = stripped;
      }
    } catch {
      // Network hiccup — fall through with the snippet/text we already had.
    } finally {
      setLoading(false);
    }

    compose.open({
      replyToMessageId,
      preferredMailboxId,
      threadId,
      toAddrs,
      subject: subject.match(/^re:/i) ? subject : `Re: ${subject}`,
      quotedHtml: buildQuotedHtml({ ...quoted, text: quotedText }),
    });
  }

  return (
    <button
      type="button"
      data-action="reply"
      onClick={onClick}
      disabled={loading}
      className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-60"
    >
      {loading ? "Loading…" : "Reply"}
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
