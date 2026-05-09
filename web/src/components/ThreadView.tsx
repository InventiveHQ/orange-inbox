import type { AttachmentRow, ThreadDetail, ThreadMessage } from "@/lib/queries";
import { formatFullDate, senderLabel } from "@/lib/format";
import ApplyLabelButton from "./ApplyLabelButton";
import BackToListButton from "./BackToListButton";
import ReplyButton from "./ReplyButton";
import SnoozeButton from "./SnoozeButton";
import ThreadActions from "./ThreadActions";
import MessageHtmlFrame from "./MessageHtmlFrame";

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
        <div className="flex items-start gap-1 min-w-0 flex-1">
          <BackToListButton label="Back to list" />
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-semibold tracking-tight break-words">
              {subject}
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
          />
          <ApplyLabelButton threadId={thread.id} />
          <SnoozeButton threadId={thread.id} initialSnoozedUntil={thread.snoozed_until} />
          {lastInbound && thread.user_role !== "reader" && (
            <ReplyButton
              replyToMessageId={lastInbound.id}
              preferredMailboxId={mailboxId}
              toAddrs={[lastInbound.from_addr]}
              subject={lastInbound.subject || ""}
            />
          )}
        </div>
      </header>

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

  return (
    <section className="px-4 py-4 sm:px-6 sm:py-5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium break-words">{senderLabel(m.from_addr, m.from_name)}</div>
          <div className="text-xs text-neutral-500 break-all">
            to {to.map(a => a.name || a.addr).join(", ")}
          </div>
          {sentByLabel && (
            <div
              className="text-xs text-neutral-500 italic mt-0.5"
              title="Internal attribution — recipients see only the mailbox address"
            >
              sent by {sentByLabel}
            </div>
          )}
        </div>
        <div className="text-xs text-neutral-500 shrink-0">{formatFullDate(m.date)}</div>
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
  return (
    <ul className="mt-3 flex flex-wrap gap-2">
      {attachments.map(a => (
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
  );
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
