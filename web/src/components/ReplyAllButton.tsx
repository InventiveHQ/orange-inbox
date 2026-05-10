"use client";

import { useState } from "react";
import { useCompose } from "./ComposeProvider";
import { htmlToQuotedText } from "@/lib/html-text";

interface QuotedOriginal {
  fromAddr: string;
  fromName: string | null;
  date: number;
  text: string;
}

// Threshold above which we surface a confirmation dialog before opening the
// composer. Cheap insurance against the classic "reply-all to a 200-person
// distribution list" footgun.
const RECIPIENT_GUARD_THRESHOLD = 5;

export default function ReplyAllButton({
  replyToMessageId,
  preferredMailboxId,
  threadId,
  fromAddr,
  toAddrs,
  ccAddrs,
  subject,
  quoted,
}: {
  replyToMessageId: string;
  preferredMailboxId: string;
  // Thread id is forwarded to the composer so the "Send and archive" option
  // knows which thread to PATCH after send. Optional — reply-all from
  // contexts without a thread (none today) just gets a plain reply-all.
  threadId?: string;
  // Original sender address — always lands in To.
  fromAddr: string;
  // Original message's To recipients.
  toAddrs: string[];
  // Original message's Cc recipients (may be empty).
  ccAddrs: string[];
  subject: string;
  quoted?: QuotedOriginal;
}) {
  const compose = useCompose();
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState<null | {
    nextTo: string[];
    nextCc: string[];
  }>(null);

  // Build the reply-all recipient lists. Original sender goes in To; the
  // remaining original recipients (To + Cc) go in Cc, minus the user's own
  // mailbox addresses (we don't want to email ourselves) and minus the
  // sender (already in To). De-duped, case-insensitive.
  function computeRecipients(): { nextTo: string[]; nextCc: string[] } {
    const myAddrs = new Set(
      compose.identities.map(i => `${i.local_part}@${i.domain_name}`.toLowerCase()),
    );
    const senderLc = fromAddr.toLowerCase();
    const seen = new Set<string>([senderLc]);

    const nextCc: string[] = [];
    for (const addr of [...toAddrs, ...ccAddrs]) {
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

  async function openComposer(nextTo: string[], nextCc: string[]) {
    const baseArgs = {
      replyToMessageId,
      preferredMailboxId,
      threadId,
      toAddrs: nextTo,
      ccAddrs: nextCc,
      subject: subject.match(/^re:/i) ? subject : `Re: ${subject}`,
    };

    if (!quoted) {
      compose.open(baseArgs);
      return;
    }

    // Mirror ReplyButton: prefer the stripped HTML body for the quote when
    // available, fall back to the snippet/text we already had.
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
      // Network hiccup — fall through with what we already had.
    } finally {
      setLoading(false);
    }

    compose.open({
      ...baseArgs,
      quotedHtml: buildQuotedHtml({ ...quoted, text: quotedText }),
    });
  }

  function onClick() {
    const { nextTo, nextCc } = computeRecipients();
    const total = nextTo.length + nextCc.length;
    if (total > RECIPIENT_GUARD_THRESHOLD) {
      // Defer opening the composer until the user confirms — this is the
      // recipient-count guard.
      setConfirm({ nextTo, nextCc });
      return;
    }
    void openComposer(nextTo, nextCc);
  }

  return (
    <>
      <button
        type="button"
        data-action="reply-all"
        onClick={onClick}
        disabled={loading}
        className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900 disabled:opacity-60"
      >
        {loading ? "Loading…" : "Reply all"}
      </button>
      {confirm && (
        <RecipientGuardDialog
          nextTo={confirm.nextTo}
          nextCc={confirm.nextCc}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const { nextTo, nextCc } = confirm;
            setConfirm(null);
            void openComposer(nextTo, nextCc);
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
