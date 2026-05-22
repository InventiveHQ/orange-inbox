"use client";

import { useEffect, useRef, useState } from "react";
import { useCompose } from "./ComposeProvider";
import { htmlToQuotedText } from "@/lib/html-text";
import { sanitizeQuotedHtml } from "@/lib/quoted-html";

// Combined Reply / Reply-all primary CTA. The label-only main button
// runs Reply; the chevron beside it opens a tiny menu offering Reply
// and Reply-all. Reply-all is the second menu item only when there's
// actually somebody else on the thread (>1 distinct recipient across
// from + To + Cc) — otherwise the chevron is suppressed and the
// component renders as a plain Reply button.
//
// Behaviour matches the previous separate ReplyButton / ReplyAllButton
// pair: HTML-body fetch for the quote, recipient-count guard at >5
// for reply-all, "Send and archive" thread-id forwarding through the
// composer.

interface QuotedOriginal {
  fromAddr: string;
  fromName: string | null;
  // Unix seconds (matches ThreadMessage.date).
  date: number;
  // Plain-text body fallback. We try fetching the HTML body first and
  // strip it; this string is what we use when that fetch fails or the
  // message is text-only.
  text: string;
}

const RECIPIENT_GUARD_THRESHOLD = 5;

interface Props {
  replyToMessageId: string;
  preferredMailboxId: string;
  threadId?: string;
  // Reply payload — original sender goes here as the To recipient.
  replyToAddrs: string[];
  // Reply-all payload — when omitted (or yields 0 distinct extras),
  // the chevron + reply-all menu item are suppressed.
  fromAddr: string;
  originalToAddrs: string[];
  originalCcAddrs: string[];
  subject: string;
  quoted?: QuotedOriginal;
}

export default function ReplySplitButton({
  replyToMessageId,
  preferredMailboxId,
  threadId,
  replyToAddrs,
  fromAddr,
  originalToAddrs,
  originalCcAddrs,
  subject,
  quoted,
}: Props) {
  const compose = useCompose();
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | {
    nextTo: string[];
    nextCc: string[];
  }>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Outside-click + Escape dismiss for the chevron menu — same pattern
  // the rest of the toolbar's popovers use.
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  function computeReplyAllRecipients(): { nextTo: string[]; nextCc: string[] } {
    const myAddrs = new Set(
      compose.identities.map(i => `${i.local_part}@${i.domain_name}`.toLowerCase()),
    );
    const senderLc = fromAddr.toLowerCase();
    const seen = new Set<string>([senderLc]);
    const nextCc: string[] = [];
    for (const addr of [...originalToAddrs, ...originalCcAddrs]) {
      const trimmed = addr.trim();
      if (!trimmed) continue;
      const lc = trimmed.toLowerCase();
      if (myAddrs.has(lc)) continue;
      if (seen.has(lc)) continue;
      seen.add(lc);
      nextCc.push(trimmed);
    }
    return { nextTo: [fromAddr], nextCc };
  }

  // Whether reply-all is meaningful — at least one distinct recipient
  // beyond the original sender survives our self-mailbox + dedupe filter.
  const replyAllAvailable = (() => {
    const { nextCc } = computeReplyAllRecipients();
    return nextCc.length > 0;
  })();

  async function openComposer(args: {
    toAddrs: string[];
    ccAddrs?: string[];
  }) {
    const baseArgs = {
      replyToMessageId,
      preferredMailboxId,
      threadId,
      toAddrs: args.toAddrs,
      ccAddrs: args.ccAddrs,
      subject: subject.match(/^re:/i) ? subject : `Re: ${subject}`,
    };
    if (!quoted) {
      compose.open(baseArgs);
      return;
    }
    setLoading(true);
    // Prefer quoting the original HTML body so tables/lists/formatting
    // survive into the composer; fall back to a plain-text quote when the
    // body is text-only, too large, or the fetch fails.
    let quotedText = quoted.text;
    let quotedBodyHtml: string | null = null;
    try {
      const res = await fetch(`/api/messages/${replyToMessageId}/html`, {
        cache: "no-store",
      });
      if (res.ok) {
        const html = await res.text();
        quotedBodyHtml = sanitizeQuotedHtml(html);
        if (!quotedBodyHtml) {
          const stripped = htmlToQuotedText(html);
          if (stripped) quotedText = stripped;
        }
      }
    } catch {
      // Network hiccup — fall through with the snippet/text we already had.
    } finally {
      setLoading(false);
    }
    compose.open({
      ...baseArgs,
      quotedHtml: buildQuotedHtml({
        ...quoted,
        text: quotedText,
        bodyHtml: quotedBodyHtml,
      }),
    });
  }

  function doReply() {
    setMenuOpen(false);
    void openComposer({ toAddrs: replyToAddrs });
  }

  function doReplyAll() {
    setMenuOpen(false);
    const { nextTo, nextCc } = computeReplyAllRecipients();
    if (nextTo.length + nextCc.length > RECIPIENT_GUARD_THRESHOLD) {
      setConfirm({ nextTo, nextCc });
      return;
    }
    void openComposer({ toAddrs: nextTo, ccAddrs: nextCc });
  }

  return (
    <>
      <div className="relative inline-flex" ref={menuRef}>
        <button
          type="button"
          data-action="reply"
          onClick={doReply}
          disabled={loading}
          className={`inline-flex h-8 items-center justify-center px-3 text-sm font-medium text-white bg-[var(--color-brand)] hover:brightness-95 disabled:opacity-60 ${
            replyAllAvailable ? "rounded-l-md" : "rounded-md"
          }`}
        >
          {loading ? "Loading…" : "Reply"}
        </button>
        {replyAllAvailable && (
          <button
            type="button"
            data-action="reply-menu"
            onClick={() => setMenuOpen(o => !o)}
            disabled={loading}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Reply options"
            title="Reply options"
            className="inline-flex h-8 w-7 items-center justify-center rounded-r-md text-sm font-medium text-white bg-[var(--color-brand)] hover:brightness-95 border-l border-white/20 disabled:opacity-60"
          >
            ▾
          </button>
        )}
        {menuOpen && replyAllAvailable && (
          <div
            role="menu"
            aria-label="Reply options"
            className="absolute right-0 top-full mt-1 z-30 w-40 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg"
          >
            <button
              type="button"
              role="menuitem"
              onClick={doReply}
              className="block w-full text-left px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 focus:outline-none"
            >
              Reply
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={doReplyAll}
              className="block w-full text-left px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 focus:outline-none"
            >
              Reply all
            </button>
          </div>
        )}
      </div>
      {confirm && (
        <RecipientGuardDialog
          nextTo={confirm.nextTo}
          nextCc={confirm.nextCc}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const { nextTo, nextCc } = confirm;
            setConfirm(null);
            void openComposer({ toAddrs: nextTo, ccAddrs: nextCc });
          }}
        />
      )}
    </>
  );
}

function RecipientGuardDialog({
  nextTo,
  nextCc,
  onCancel,
  onConfirm,
}: {
  nextTo: string[];
  nextCc: string[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const all = [...nextTo, ...nextCc];
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="reply-all-guard-title"
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-md rounded-lg bg-white dark:bg-neutral-950 shadow-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
          <h2 id="reply-all-guard-title" className="text-sm font-semibold">
            Reply to {all.length} people?
          </h2>
        </div>
        <div className="px-4 py-3 space-y-2 text-sm">
          <p className="text-neutral-700 dark:text-neutral-300">
            This will go to {all.length} recipients:
          </p>
          <ul className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 px-3 py-2 max-h-40 overflow-y-auto text-xs space-y-0.5">
            {all.map(addr => (
              <li key={addr} className="break-all">
                {addr}
              </li>
            ))}
          </ul>
        </div>
        <div className="px-4 py-3 flex justify-end gap-2 border-t border-neutral-200 dark:border-neutral-800">
          <button
            type="button"
            onClick={onCancel}
            autoFocus
            className="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-white hover:brightness-95"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildQuotedHtml({
  fromAddr,
  fromName,
  date,
  text,
  bodyHtml,
}: QuotedOriginal & { bodyHtml?: string | null }): string {
  const dateStr = new Date(date * 1000).toLocaleString();
  const senderRaw = fromName?.trim()
    ? `${fromName.trim()} <${fromAddr}>`
    : fromAddr;
  const intro = `On ${escapeHtml(dateStr)}, ${escapeHtml(senderRaw)} wrote:`;
  // bodyHtml is a sanitised fragment of the original message — embed it
  // verbatim so the editor imports real tables/lists. Otherwise quote the
  // plain text, escaped, with newlines as <br>.
  const body = bodyHtml ?? escapeHtml(text || "").replace(/\r?\n/g, "<br>");
  return (
    `<p>${intro}</p>` +
    `<blockquote type="cite" style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex;">` +
    body +
    `</blockquote>`
  );
}
