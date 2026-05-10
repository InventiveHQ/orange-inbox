import type { AttachmentRow, ThreadDetail, ThreadMessage } from "@/lib/queries";
import { formatFullDate, senderLabel } from "@/lib/format";
import ApplyLabelButton from "./ApplyLabelButton";
import AttachmentPreview from "./AttachmentPreview";
import Avatar from "./Avatar";
import BackToListButton from "./BackToListButton";
import CalendarEventCard from "./CalendarEventCard";
import ExecutableAttachment from "./ExecutableAttachment";
import ReplyButton from "./ReplyButton";
import ReplyAllButton from "./ReplyAllButton";
import SnoozeButton from "./SnoozeButton";
import ThreadActions from "./ThreadActions";
import MessageHtmlFrame from "./MessageHtmlFrame";
import MessageMenu from "./MessageMenu";
import UnsubscribeButton from "./UnsubscribeButton";
import ReminderDueBanner from "./ReminderDueBanner";

interface Props {
  detail: ThreadDetail;
  mailboxId: string;
  // Set of from-addresses (lowercase) the current user has marked VIP.
  // Empty set when the user has no VIPs. Drives the avatar halo and the
  // "Add to / Remove from VIPs" item in MessageMenu.
  vipAddrs: Set<string>;
}

export default function ThreadView({ detail, mailboxId, vipAddrs }: Props) {
  const { thread, messages } = detail;
  const subject = messages[0]?.subject || thread.subject_normalized;
  const lastInbound = [...messages].reverse().find(m => m.direction === "inbound");
  // Server-side "is the reminder due" check. The query already returns
  // `remind_at` in unix seconds — comparing against Date.now() at render
  // time means the banner shows up the first time the user opens the
  // thread after the timestamp elapses, without needing a polling cron.
  const nowSec = Math.floor(Date.now() / 1000);
  const reminderDue = thread.remind_at != null && thread.remind_at <= nowSec;
  const reminderUpcoming = thread.remind_at != null && thread.remind_at > nowSec;

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
              {reminderUpcoming && thread.remind_at != null && (
                <span
                  className="ml-2 align-middle inline-flex items-center gap-1 rounded-md bg-sky-100 dark:bg-sky-900/30 px-2 py-0.5 text-xs font-medium text-sky-800 dark:text-sky-300"
                  title={`Reminder set for ${formatRemindAt(thread.remind_at)}`}
                >
                  🔔 Reminder set for {formatRemindAt(thread.remind_at)}
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
            initialRemindAt={thread.remind_at}
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

      {reminderDue && (
        <ReminderDueBanner threadId={thread.id} remindAt={thread.remind_at!} />
      )}

      {thread.muted === 1 && (
        <div className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50 px-4 py-2 sm:px-6 text-xs text-neutral-600 dark:text-neutral-400">
          Muted — new replies stay archived and won&apos;t show in your inbox.
        </div>
      )}

      <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
        {messages.map(m => (
          <MessageBlock
            key={m.id}
            m={m}
            threadId={thread.id}
            isVip={vipAddrs.has(m.from_addr.trim().toLowerCase())}
          />
        ))}
      </div>
    </article>
  );
}

function MessageBlock({
  m,
  threadId,
  isVip,
}: {
  m: ThreadMessage;
  threadId: string;
  isVip: boolean;
}) {
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

  // Trust signals — inbound only. Outbound messages we wrote ourselves
  // never get a chip or banner; auth_results/first_contact/reply_to_addr
  // are populated by the email worker on inbound ingest only.
  const isInbound = m.direction === "inbound";
  const auth = isInbound ? parseAuthResults(m.auth_results) : null;
  const showFirstContact = isInbound && m.first_contact === 1;
  const showReplyToWarn =
    isInbound && !!m.reply_to_addr && m.reply_to_addr !== m.from_addr;
  // RFC 2369/8058 unsubscribe chip — appears for inbound newsletters when
  // we extracted at least one unsubscribe target at ingest. Outbound
  // messages don't carry unsubscribe metadata so the chip never renders.
  const hasUnsubTarget =
    isInbound && (m.list_unsub_url || m.list_unsub_mailto);
  const showUnsub = hasUnsubTarget && m.unsubscribed_at == null;
  const showUnsubbedPill = hasUnsubTarget && m.unsubscribed_at != null;

  return (
    <section className="px-4 py-4 sm:px-6 sm:py-5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <Avatar seed={avatarSeed} label={senderText} size="lg" title={m.from_addr} vip={isVip} />
          <div className="min-w-0">
            <div className="text-sm font-medium break-words flex flex-wrap items-center gap-x-2 gap-y-1">
              {m.from_name && m.from_name.trim() ? (
                <span>
                  {m.from_name.trim()}{" "}
                  <span className="font-normal text-neutral-500 break-all">
                    &lt;{m.from_addr}&gt;
                  </span>
                </span>
              ) : (
                <span>{m.from_addr || "Unknown"}</span>
              )}
              {auth && <AuthChip auth={auth} fromAddr={m.from_addr} />}
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
        <div className="flex items-center gap-2 shrink-0">
          {(showUnsub || showUnsubbedPill) && (
            <UnsubscribeButton
              messageId={m.id}
              alreadyUnsubscribed={!!showUnsubbedPill}
            />
          )}
          <span className="text-xs text-neutral-500">{formatFullDate(m.date)}</span>
          <MessageMenu messageId={m.id} fromAddr={m.from_addr} direction={m.direction} isVip={isVip} />
        </div>
      </div>

      {(showFirstContact || showReplyToWarn) && (
        <TrustBanner
          firstContact={showFirstContact}
          replyToAddr={showReplyToWarn ? m.reply_to_addr : null}
        />
      )}

      {m.calendar_event && (
        <CalendarEventCard
          event={m.calendar_event}
          threadId={threadId}
          messageId={m.id}
        />
      )}

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

// ─── Trust signals (#5 + #22) ───────────────────────────────────────────────
//
// AuthChip renders a tiny pill matching LabelChip's `xs` size next to the
// From line. Three states map to colors (green/red/gray) with no third-
// party styling — same Tailwind utilities the rest of the reader uses.

interface ParsedAuth {
  spf: string;
  dkim: string;
  dmarc: string;
  from_domain: string | null;
}

function parseAuthResults(json: string | null): ParsedAuth | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<ParsedAuth>;
    if (
      typeof parsed.spf === "string" &&
      typeof parsed.dkim === "string" &&
      typeof parsed.dmarc === "string"
    ) {
      return {
        spf: parsed.spf,
        dkim: parsed.dkim,
        dmarc: parsed.dmarc,
        from_domain:
          typeof parsed.from_domain === "string" ? parsed.from_domain : null,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

function AuthChip({ auth, fromAddr }: { auth: ParsedAuth; fromAddr: string }) {
  const allPass =
    auth.spf === "pass" && auth.dkim === "pass" && auth.dmarc === "pass";
  const dmarcBad = auth.dmarc === "fail" || auth.dmarc === "softfail";

  const tooltip = `SPF: ${auth.spf} · DKIM: ${auth.dkim} · DMARC: ${auth.dmarc}`;
  const sizing = "px-1.5 py-px text-[10px]";

  if (allPass) {
    // Use the verdict's from_domain when present (DMARC alignment), else
    // fall back to the visible From's domain part — same thing in 99% of
    // cases, but the alignment-checked one is the one we want to show.
    const domain = auth.from_domain || domainOf(fromAddr) || "";
    return (
      <span
        className={`inline-flex items-center rounded-full font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 ${sizing}`}
        title={tooltip}
      >
        <span aria-hidden className="mr-0.5">{"✓"}</span>
        Verified{domain ? ` · ${domain}` : ""}
      </span>
    );
  }

  if (dmarcBad) {
    return (
      <span
        className={`inline-flex items-center rounded-full font-medium bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300 ${sizing}`}
        title={tooltip}
      >
        <span aria-hidden className="mr-0.5">{"⚠"}</span>
        DMARC failed
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center rounded-full font-medium bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 ${sizing}`}
      title={tooltip}
    >
      Unverified
    </span>
  );
}

function domainOf(addr: string): string | null {
  const at = addr.lastIndexOf("@");
  if (at === -1) return null;
  return addr.slice(at + 1).toLowerCase() || null;
}

function TrustBanner({
  firstContact,
  replyToAddr,
}: {
  firstContact: boolean;
  replyToAddr: string | null;
}) {
  // Single yellow box — both signals collapse into one banner so the
  // reader doesn't get two stacked warnings about the same message.
  return (
    <div
      className="mt-3 rounded-md border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
      role="note"
    >
      <ul className="space-y-1">
        {firstContact && (
          <li>
            <span aria-hidden className="mr-1">{"⚠"}</span>
            First time you&apos;ve heard from this sender.
          </li>
        )}
        {replyToAddr && (
          <li>
            <span aria-hidden className="mr-1">{"⚠"}</span>
            Reply-To differs from From:{" "}
            <span className="font-mono break-all">{replyToAddr}</span>
          </li>
        )}
      </ul>
    </div>
  );
}

function AttachmentsList({ attachments }: { attachments: AttachmentRow[] }) {
  // Split: images and PDFs are handed to the client previewer (thumbnails +
  // chip+Preview button + lightbox); executables go through the confirm-
  // modal client component; everything else stays as a plain download chip
  // rendered server-side.
  //
  // An executable image/pdf is unusual but possible (e.g. a renamed payload
  // with a misleading content-type) — the safety flag wins over previewable
  // so we never auto-render the bytes.
  const executable = attachments.filter(a => a.is_executable === 1);
  const safe = attachments.filter(a => a.is_executable !== 1);
  const previewable = safe.filter(a => isPreviewable(a.content_type));
  const other = safe.filter(a => !isPreviewable(a.content_type));

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
      {(other.length > 0 || executable.length > 0) && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {executable.map(a => (
            <li key={a.id}>
              <ExecutableAttachment
                id={a.id}
                filename={a.filename}
                size={a.size}
              />
            </li>
          ))}
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

// "Mon, May 12 at 5:00 PM" — long format for the reminder indicator on the
// header. Same shape SnoozeButton uses for its banner so the wording stays
// consistent.
function formatRemindAt(secs: number): string {
  const d = new Date(secs * 1000);
  const date = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} at ${time}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
