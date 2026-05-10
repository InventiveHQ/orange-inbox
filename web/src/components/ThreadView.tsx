import type { AttachmentRow, ThreadDetail, ThreadMessage } from "@/lib/queries";
import { formatFullDate, senderLabel } from "@/lib/format";
import ApplyLabelButton from "./ApplyLabelButton";
import AttachmentPreview from "./AttachmentPreview";
import Avatar from "./Avatar";
import BackToListButton from "./BackToListButton";
import ReplyButton from "./ReplyButton";
import ReplyAllButton from "./ReplyAllButton";
import SnoozeButton from "./SnoozeButton";
import ThreadActions from "./ThreadActions";
import MessageHtmlFrame from "./MessageHtmlFrame";
import MessageMenu from "./MessageMenu";

interface Props {
  detail: ThreadDetail;
  mailboxId: string;
}

export default function ThreadView({ detail, mailboxId }: Props) {
  const { thread, messages } = detail;
  const subject = messages[0]?.subject || thread.subject_normalized;
  const lastInbound = [...messages].reverse().find(m => m.direction === "inbound");

  return (
    <article className="flex-1 overflow-y-auto">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-200 dark:border-neutral-800 px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex items-start gap-1 min-w-0 w-full sm:w-auto sm:flex-1">
          <BackToListButton label="Back to list" />
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-semibold tracking-tight break-words">
              {subject}
              {thread.pinned === 1 && (
                <span
                  className="ml-2 align-middle inline-flex items-center gap-1 rounded-md bg-amber-100 dark:bg-amber-900/30 px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-300"
                  title="Pinned to the top of the inbox"
                >
                  📌 Pinned
                </span>
              )}
            </h1>
            <div className="mt-1 text-xs text-neutral-500 break-all">
              {thread.mailbox_local_part}@{thread.domain_name} · {messages.length} message
              {messages.length === 1 ? "" : "s"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 sm:gap-2 flex-wrap">
          <ThreadActions
            threadId={thread.id}
            initialStarred={thread.starred === 1}
            initialArchived={thread.archived === 1}
            initialMuted={thread.muted === 1}
            initialPinned={thread.pinned === 1}
          />
          <ApplyLabelButton threadId={thread.id} />
          <SnoozeButton threadId={thread.id} initialSnoozedUntil={thread.snoozed_until} />
          {lastInbound && thread.user_role !== "reader" && (() => {
            const originalTo = parseAddrs(lastInbound.to_json).map(a => a.addr);
            const originalCc = lastInbound.cc_json
              ? parseAddrs(lastInbound.cc_json).map(a => a.addr)
              : [];
            // Reply-all surfaces only when there's actually somebody else on
            // the thread (i.e. >1 distinct address across the original
            // sender + To + Cc). For a 1:1 message we just show Reply.
            const distinct = new Set<string>(
              [lastInbound.from_addr, ...originalTo, ...originalCc]
                .map(a => a.trim().toLowerCase())
                .filter(Boolean),
            );
            const showReplyAll = distinct.size > 1;
            const quoted = {
              fromAddr: lastInbound.from_addr,
              fromName: lastInbound.from_name,
              date: lastInbound.date,
              // text_body is missing for HTML-only messages — fall back to
              // the snippet so the user at least sees a preview of what
              // they're replying to.
              text: lastInbound.text_body || lastInbound.snippet || "",
            };
            return (
              <>
                <ReplyButton
                  replyToMessageId={lastInbound.id}
                  preferredMailboxId={mailboxId}
                  threadId={thread.id}
                  toAddrs={[lastInbound.from_addr]}
                  subject={lastInbound.subject || ""}
                  quoted={quoted}
                />
                {showReplyAll && (
                  <ReplyAllButton
                    replyToMessageId={lastInbound.id}
                    preferredMailboxId={mailboxId}
                    threadId={thread.id}
                    fromAddr={lastInbound.from_addr}
                    toAddrs={originalTo}
                    ccAddrs={originalCc}
                    subject={lastInbound.subject || ""}
                    quoted={quoted}
                  />
                )}
              </>
            );
          })()}
        </div>
      </header>

      {thread.muted === 1 && (
        <div className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50 px-4 py-2 sm:px-6 text-xs text-neutral-600 dark:text-neutral-400">
          Muted — new replies stay archived and won&apos;t show in your inbox.
        </div>
      )}

      <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
        {messages.map(m => (
          <MessageBlock key={m.id} m={m} />
        ))}
      </div>
    </article>
  );
}

function MessageBlock({ m }: { m: ThreadMessage }) {
  const to = parseAddrs(m.to_json);
  const isOutbound = m.direction === "outbound";
  const sentByLabel =
    isOutbound && (m.sent_by_display_name || m.sent_by_email)
      ? m.sent_by_display_name || m.sent_by_email
      : null;

  // Inline (cid:) attachments are rewritten into the HTML body and hidden
  // from the explicit attachment list — Gmail-style.
  const inlineAtts = m.attachments.filter(a => a.inline_cid != null);
  const fileAtts = m.attachments.filter(a => a.inline_cid == null);

  // Address seeds the color (stable across display-name variants); label is
  // the first letter of whatever name we actually render.
  const senderText = senderLabel(m.from_addr, m.from_name);
  const avatarSeed = m.from_addr || senderText;

  return (
    <section className="px-4 py-4 sm:px-6 sm:py-5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <Avatar seed={avatarSeed} label={senderText} size="lg" title={m.from_addr} />
          <div className="min-w-0">
            <div className="text-sm font-medium break-words">
              {m.from_name && m.from_name.trim() ? (
                <>
                  {m.from_name.trim()}{" "}
                  <span className="font-normal text-neutral-500 break-all">
                    &lt;{m.from_addr}&gt;
                  </span>
                </>
              ) : (
                m.from_addr || "Unknown"
              )}
            </div>
            {to.length > 0 && (
              <div className="text-xs text-neutral-500 break-all">
                to {to.map(a => a.name || a.addr).join(", ")}
              </div>
            )}
            {sentByLabel && (
              <div
                className="text-xs text-neutral-500 italic mt-0.5"
                title="Internal attribution — recipients see only the mailbox address"
              >
                sent by {sentByLabel}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-xs text-neutral-500">{formatFullDate(m.date)}</span>
          <MessageMenu messageId={m.id} fromAddr={m.from_addr} direction={m.direction} />
        </div>
      </div>

      {m.html_r2_key ? (
        <MessageHtmlFrame
          messageId={m.id}
          inlineAttachments={inlineAtts.map(a => ({ id: a.id, cid: a.inline_cid! }))}
          fallback={m.text_body || m.snippet}
        />
      ) : (
        <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed text-neutral-800 dark:text-neutral-200">
          {m.text_body || m.snippet || "(no body)"}
        </pre>
      )}

      {fileAtts.length > 0 && <AttachmentsList attachments={fileAtts} />}
    </section>
  );
}

function AttachmentsList({ attachments }: { attachments: AttachmentRow[] }) {
  // Split: images and PDFs are handed to the client previewer (thumbnails +
  // chip+Preview button + lightbox); everything else stays as a plain
  // download chip rendered server-side.
  const previewable = attachments.filter(a => isPreviewable(a.content_type));
  const other = attachments.filter(a => !isPreviewable(a.content_type));

  return (
    <>
      {previewable.length > 0 && (
        <AttachmentPreview
          attachments={previewable.map(a => ({
            id: a.id,
            filename: a.filename,
            content_type: a.content_type,
            size: a.size,
          }))}
        />
      )}
      {other.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {other.map(a => (
            <li key={a.id}>
              <a
                href={`/api/attachments/${a.id}`}
                download={a.filename ?? undefined}
                className="inline-flex items-center gap-2 rounded-md border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 px-3 py-1.5 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <span className="font-medium truncate max-w-[16rem]">
                  {a.filename || "attachment"}
                </span>
                <span className="text-neutral-500">{formatBytes(a.size)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function isPreviewable(contentType: string | null): boolean {
  if (!contentType) return false;
  return contentType.startsWith("image/") || contentType === "application/pdf";
}

function parseAddrs(json: string): Array<{ addr: string; name?: string }> {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
