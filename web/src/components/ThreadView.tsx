import type { AttachmentRow, ThreadDetail, ThreadMessage } from "@/lib/queries";
import type { ContactsLookup } from "@/lib/contacts";
import type { ThreadAssignment } from "@/lib/assignments";
import type { ThreadNote } from "@/lib/thread-notes";
import { formatFullDate, senderLabel } from "@/lib/format";
import { checkLookalike, type LookalikeFinding } from "@/lib/lookalike";
import ApplyLabelButton from "./ApplyLabelButton";
import AttachmentPreview from "./AttachmentPreview";
import Avatar from "./Avatar";
import BackToListButton from "./BackToListButton";
import CalendarEventCard from "./CalendarEventCard";
import ExecutableAttachment from "./ExecutableAttachment";
import MessageThread, { type MessageSummary } from "./MessageThread";
import ReplySplitButton from "./ReplySplitButton";
import RelativeTime from "./RelativeTime";
import ThreadActions from "./ThreadActions";
import ThreadNotes from "./ThreadNotes";
import ThreadSummary from "./ThreadSummary";
import AddToCalendarButton from "./AddToCalendarButton";
import MessageHtmlFrame from "./MessageHtmlFrame";
import MessageMenu from "./MessageMenu";
import UnsubscribeButton from "./UnsubscribeButton";

interface Props {
  detail: ThreadDetail;
  mailboxId: string;
  // Set of from-addresses (lowercase) the current user has marked VIP.
  // Empty set when the user has no VIPs. Drives the avatar halo and the
  // "Add to / Remove from VIPs" item in MessageMenu.
  vipAddrs: Set<string>;
  // Address-book lookup. Drives the "In contacts" sender badge and the
  // contact-domain comparison inside checkLookalike (warns when a sender's
  // domain is a typo of a domain you actually correspond with).
  contacts: ContactsLookup;
  // Team workflow (#27). currentUserId for "Claim" vs "Reassign" rendering;
  // assignment is the SSR'd snapshot (null when unassigned); notes is the
  // SSR'd internal-notes list (empty array when no notes).
  currentUserId: string;
  assignment: ThreadAssignment | null;
  notes: ThreadNote[];
}

export default function ThreadView({
  detail,
  mailboxId,
  vipAddrs,
  contacts,
  currentUserId,
  assignment,
  notes,
}: Props) {
  const { thread, messages } = detail;
  const subject = messages[0]?.subject || thread.subject_normalized;
  const lastInbound = [...messages].reverse().find(m => m.direction === "inbound");
  // Only attempt a summary for threads where one earns its keep — a multi-
  // message conversation, or a single long message. Short single notes are
  // already their own summary, so we skip the fetch entirely. Mirrors the
  // server-side guard in getThreadSummary.
  const worthSummarising =
    messages.length > 1 || (messages[0]?.text_body?.length ?? 0) >= 600;

  return (
    <article className="flex-1 overflow-y-auto">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-200 dark:border-neutral-800 px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex items-start gap-1 min-w-0 w-full sm:w-auto sm:flex-1 sm:min-w-[16rem]">
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
              {assignment && (() => {
                const isMine = assignment.assignee_id === currentUserId;
                const assigneeLabel =
                  assignment.assignee_display_name?.trim() ||
                  assignment.assignee_email ||
                  "user";
                if (assignment.resolved_at != null) {
                  const resolverLabel =
                    assignment.resolved_by_display_name?.trim() ||
                    assignment.resolved_by_email ||
                    "someone";
                  const resolvedByMe = assignment.resolved_by === currentUserId;
                  const text = resolvedByMe
                    ? "Resolved by you"
                    : `Resolved by ${resolverLabel}`;
                  return (
                    <span
                      className="ml-2 align-middle inline-flex items-center gap-1 rounded-md bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:text-neutral-300"
                      title={`Originally assigned to ${isMine ? "you" : assigneeLabel}`}
                    >
                      ✓ {text}
                    </span>
                  );
                }
                return (
                  <span
                    className={`ml-2 align-middle inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${
                      isMine
                        ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-300"
                        : "bg-sky-100 dark:bg-sky-900/30 text-sky-800 dark:text-sky-300"
                    }`}
                    title={
                      isMine
                        ? "Assigned to you"
                        : `Assigned to ${assigneeLabel}`
                    }
                  >
                    {isMine ? "Assigned to you" : `Assigned to ${assigneeLabel}`}
                  </span>
                );
              })()}
            </h1>
            <div
              className="mt-1 text-xs text-neutral-500 truncate"
              title={`${thread.mailbox_local_part}@${thread.domain_name}`}
            >
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
            initialFollowUpEnabled={thread.follow_up_enabled === 1}
            initialFollowUpMinutes={
              thread.follow_up_minutes ??
              (thread.follow_up_days != null ? thread.follow_up_days * 1440 : null)
            }
            mailboxId={thread.mailbox_id}
            currentUserId={currentUserId}
            initialAssignment={
              assignment
                ? {
                    assignee_id: assignment.assignee_id,
                    assignee_email: assignment.assignee_email,
                    assignee_display_name: assignment.assignee_display_name,
                    resolved_at: assignment.resolved_at,
                    resolved_by: assignment.resolved_by,
                    resolved_by_email: assignment.resolved_by_email,
                    resolved_by_display_name: assignment.resolved_by_display_name,
                  }
                : null
            }
          />
          <ApplyLabelButton threadId={thread.id} />
          <AddToCalendarButton threadId={thread.id} subject={subject} />
          {lastInbound && thread.user_role !== "reader" && (() => {
            const originalTo = parseAddrs(lastInbound.to_json).map(a => a.addr);
            const originalCc = lastInbound.cc_json
              ? parseAddrs(lastInbound.cc_json).map(a => a.addr)
              : [];
            const quoted = {
              fromAddr: lastInbound.from_addr,
              fromName: lastInbound.from_name,
              date: lastInbound.date,
              // text_body is missing for HTML-only messages — fall back to
              // the snippet so the user at least sees a preview of what
              // they're replying to.
              text: lastInbound.text_body || lastInbound.snippet || "",
            };
            // ReplySplitButton suppresses the reply-all chevron internally
            // when there's only one distinct recipient (the original sender),
            // so we don't need to gate it here.
            return (
              <ReplySplitButton
                replyToMessageId={lastInbound.id}
                preferredMailboxId={mailboxId}
                threadId={thread.id}
                // Reply goes to the Reply-To header when the sender set one
                // (e.g. a form notification whose Reply-To is the submitter),
                // falling back to the From address otherwise.
                replyToAddrs={[lastInbound.reply_to_addr || lastInbound.from_addr]}
                fromAddr={lastInbound.from_addr}
                originalToAddrs={originalTo}
                originalCcAddrs={originalCc}
                subject={lastInbound.subject || ""}
                quoted={quoted}
              />
            );
          })()}
        </div>
      </header>

      {worthSummarising && <ThreadSummary threadId={thread.id} />}

      {thread.muted === 1 && (
        <div className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50 px-4 py-2 sm:px-6 text-xs text-neutral-600 dark:text-neutral-400">
          Muted — new replies stay archived and won&apos;t show in your inbox.
        </div>
      )}

      {/*
        Internal notes (#27) render above the message list with a yellow tint
        so they read as "team scratchpad" rather than part of the email thread.
        Always mounted — even when notes is empty — so the "Add note" button
        is always one click away for mailbox members.
      */}
      <ThreadNotes
        threadId={thread.id}
        currentUserId={currentUserId}
        initialNotes={notes.map(n => ({
          id: n.id,
          thread_id: n.thread_id,
          user_id: n.user_id,
          body: n.body,
          created_at: n.created_at,
          user_email: n.user_email,
          user_display_name: n.user_display_name,
        }))}
      />

      {/*
        Collapsed-conversation view (#37). MessageThread is a client
        component that owns per-message expand/collapse state. Default-expanded:
        the last message in the thread, plus any `?focus=<id>` match (handled
        inside MessageThread via the `next-url` shim). For 1- and 2-message
        threads everything is expanded and the toolbar is hidden.
      */}
      <MessageThread
        defaultExpandedIds={defaultExpandedIds(messages)}
        messages={messages.map(m => ({
          summary: summarizeMessage(m, vipAddrs),
          full: (
            <MessageBlock
              m={m}
              threadId={thread.id}
              isVip={vipAddrs.has(m.from_addr.trim().toLowerCase())}
              contacts={contacts}
            />
          ),
        }))}
      />
    </article>
  );
}

// Default-expanded heuristic: short threads (≤2 messages) start fully open
// — collapsing one of two messages is more friction than value. For longer
// threads only the most-recent inbound message expands by default (the
// thing the user most likely wants to read / reply to), matching Gmail.
// If there's no inbound (e.g. a sent-only thread) we fall back to the last
// message overall so the user still sees *something* without clicking. The
// `?focus=<id>` override is layered on inside MessageThread once the URL
// is available on the client.
function defaultExpandedIds(messages: ThreadMessage[]): string[] {
  if (messages.length === 0) return [];
  if (messages.length <= 2) return messages.map(m => m.id);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].direction === "inbound") return [messages[i].id];
  }
  return [messages[messages.length - 1].id];
}

function summarizeMessage(m: ThreadMessage, vipAddrs: Set<string>): MessageSummary {
  return {
    id: m.id,
    senderText: senderLabel(m.from_addr, m.from_name),
    senderAddr: m.from_addr || "",
    snippet: (m.snippet || m.text_body || "").replace(/\s+/g, " ").trim(),
    date: formatFullDate(m.date),
    isVip: vipAddrs.has(m.from_addr.trim().toLowerCase()),
  };
}

function MessageBlock({
  m,
  threadId,
  isVip,
  contacts,
}: {
  m: ThreadMessage;
  threadId: string;
  isVip: boolean;
  contacts: ContactsLookup;
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
  // Lookalike-domain check: punycode / mixed-script / brand-spoof. Runs
  // independently of auth-results — DKIM/DMARC can pass on the attacker's
  // own lookalike domain, so a green "Verified" chip alone isn't enough.
  // Prefer the auth-aligned from_domain (DMARC d=) when available; fall
  // back to the visible From header's domain.
  const senderDomain = auth?.from_domain || domainOf(m.from_addr) || "";
  const lookalike = isInbound && senderDomain
    ? checkLookalike(senderDomain, contacts.domains)
    : null;
  // "In contacts" badge — rendered only for inbound, only when the sender's
  // exact email is in the user's address book. Domain match alone isn't
  // enough since the whole point is to verify the *person*, not a coworker.
  const fromAddrLc = m.from_addr.trim().toLowerCase();
  const inAddressBook = isInbound && contacts.emails.has(fromAddrLc);
  // "Their local time" pill (#88) — same gating as the In-contacts badge:
  // only inbound senders, and only when we have a resolved tz on the
  // matching contact row. Outbound from the user themselves never gets a
  // pill (that's *your* time).
  const senderTz = isInbound ? contacts.tzByEmail.get(fromAddrLc) : undefined;
  // RFC 2369/8058 unsubscribe chip — appears for inbound newsletters when
  // we extracted at least one unsubscribe target at ingest. Outbound
  // messages don't carry unsubscribe metadata so the chip never renders.
  const hasUnsubTarget =
    isInbound && (m.list_unsub_url || m.list_unsub_mailto);
  const showUnsub = hasUnsubTarget && m.unsubscribed_at == null;
  const showUnsubbedPill = hasUnsubTarget && m.unsubscribed_at != null;

  return (
    <section className="px-4 py-4 sm:px-6 sm:py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-start gap-3 min-w-0 flex-1">
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
              {inAddressBook && <InContactsChip />}
              {senderTz && (
                <RelativeTime tz={senderTz.tz} source={senderTz.source} />
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
        <div className="flex items-center gap-2 shrink-0">
          {(showUnsub || showUnsubbedPill) && (
            <UnsubscribeButton
              messageId={m.id}
              alreadyUnsubscribed={!!showUnsubbedPill}
            />
          )}
          {isOutbound && m.tracking_token && (
            <ReadReceiptPill count={m.read_count} lastOpenedAt={m.last_opened_at} />
          )}
          <span className="text-xs text-neutral-500">{formatFullDate(m.date)}</span>
          <MessageMenu messageId={m.id} fromAddr={m.from_addr} direction={m.direction} isVip={isVip} />
        </div>
      </div>

      {(showFirstContact || showReplyToWarn || lookalike) && (
        <TrustBanner
          firstContact={showFirstContact}
          replyToAddr={showReplyToWarn ? m.reply_to_addr : null}
          lookalike={lookalike}
          senderDomain={senderDomain}
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

// Read-receipt pill (#69). Rendered only on outbound messages whose
// tracking_token is non-null — i.e. the sender had "Track opens" enabled
// when this message went out. We deliberately do NOT render anything when
// count=0; an empty pill saying "Not yet read" reads as noise on every
// just-sent outbound, and "still ✓ pending" is the obvious default. Once
// the recipient opens, the pill flips on.
//
// Note (limitation): some mail clients fetch images through privacy proxies
// (Gmail does this by default). We see the proxy's IP, not the recipient's,
// and the count still increments. Mail clients that strip remote images
// outright (orange-inbox itself does this — see issue #11) won't fire the
// open at all, so a "0 reads" pill against an actually-read message is the
// expected outcome there. Worth documenting; no way around it.
function ReadReceiptPill({
  count,
  lastOpenedAt,
}: {
  count: number;
  lastOpenedAt: number | null;
}) {
  if (count === 0) {
    return (
      <span
        className="inline-flex items-center rounded-full bg-neutral-100 dark:bg-neutral-800 px-1.5 py-px text-[10px] font-medium text-neutral-600 dark:text-neutral-400"
        title="You enabled read receipts on this message. The pill will update when (and if) the recipient's mail client loads remote images."
      >
        <span aria-hidden className="mr-0.5">{"◌"}</span>
        Track opens
      </span>
    );
  }
  const lastLabel = lastOpenedAt ? formatLastOpened(lastOpenedAt) : null;
  const tooltip = lastOpenedAt
    ? `Last opened ${new Date(lastOpenedAt * 1000).toLocaleString()}`
    : undefined;
  return (
    <span
      className="inline-flex items-center rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 px-1.5 py-px text-[10px] font-medium"
      title={tooltip}
    >
      <span aria-hidden className="mr-0.5">{"✓"}</span>
      Read {count}× {lastLabel ? `· ${lastLabel}` : ""}
    </span>
  );
}

function formatLastOpened(unixSec: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  const d = new Date(unixSec * 1000);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function InContactsChip() {
  return (
    <span
      className="inline-flex items-center rounded-full font-medium bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300 px-1.5 py-px text-[10px]"
      title="Sender is in your address book"
    >
      <span aria-hidden className="mr-0.5">{"👤"}</span>
      In contacts
    </span>
  );
}

function TrustBanner({
  firstContact,
  replyToAddr,
  lookalike,
  senderDomain,
}: {
  firstContact: boolean;
  replyToAddr: string | null;
  lookalike: LookalikeFinding | null;
  senderDomain: string;
}) {
  // A skeleton-match (e.g. paypa1.com posing as paypal.com, or a domain that
  // resembles one in your address book) is the highest-confidence phishing
  // signal we have — escalate the whole banner to red so the user can't miss
  // it. Other signals (first-contact, reply-to mismatch, punycode,
  // mixed-script) stay amber.
  const severe = lookalike?.kind === "skeleton_match";
  const tone = severe
    ? "border-rose-300 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-900/20 text-rose-900 dark:text-rose-200"
    : "border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200";
  return (
    <div
      className={`mt-3 rounded-md border px-3 py-2 text-xs ${tone}`}
      role={severe ? "alert" : "note"}
    >
      <ul className="space-y-1">
        {lookalike?.kind === "skeleton_match" && (
          <li>
            <span aria-hidden className="mr-1">{"⚠"}</span>
            <strong>Possible impersonation:</strong>{" "}
            <span className="font-mono break-all">{senderDomain}</span> looks
            like{" "}
            <span className="font-mono break-all">{lookalike.resembles}</span>
            {" "}but isn&apos;t.
          </li>
        )}
        {lookalike?.kind === "punycode" && (
          <li>
            <span aria-hidden className="mr-1">{"⚠"}</span>
            Sender domain uses non-ASCII characters{" "}
            <span className="font-mono break-all">({senderDomain})</span> —
            could disguise a lookalike.
          </li>
        )}
        {lookalike?.kind === "mixed_script" && (
          <li>
            <span aria-hidden className="mr-1">{"⚠"}</span>
            Sender domain mixes scripts{" "}
            <span className="font-mono break-all">({senderDomain})</span> —
            classic homograph attack.
          </li>
        )}
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
