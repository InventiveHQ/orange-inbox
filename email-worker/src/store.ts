import { maybeAutoReply } from "./autoresponder";
import { categorize } from "./categorize";
import { parseIcs } from "./ics-parse";
import {
  getMailDbForNewThread,
  getMailDbForThread,
  isThreadMuted,
  registerThreadLocation,
  upsertThreadIndex,
} from "./mail-db";
import { isFirstContact } from "./parse";
import { evaluateRules } from "./rules";
import { classify, type TriageContext } from "./triage";
import type { Env, ParsedMessage } from "./types";
import type { Recipient } from "./route";
import type { ThreadMatch } from "./thread";

export interface StoreResult {
  messageId: string;
  threadId: string;
  duplicate: boolean;
}

export async function storeMessage(
  env: Env,
  ctx: ExecutionContext,
  recipient: Recipient,
  thread: ThreadMatch,
  parsed: ParsedMessage,
  rawBytes: ArrayBuffer,
): Promise<StoreResult> {
  // Resolve which mail DB this message should land in. New threads pick the
  // emptiest DB under its soft cap (or hard cap in degraded mode); existing
  // threads route to whichever DB the thread is pinned to.
  let mailDb: D1Database;
  let mailDbId: string;
  if (thread.isNew) {
    const picked = await getMailDbForNewThread(env);
    if (!picked) {
      // Every mail DB is over its hard cap and we have nowhere to put this.
      // Reject so Cloudflare retries / requeues the inbound — better than
      // silently dropping it.
      throw new Error(
        "all mail DBs are at hard cap; provision an overflow DB before continuing",
      );
    }
    mailDb = picked.db;
    mailDbId = picked.mailDbId;
  } else {
    mailDb = await getMailDbForThread(env, thread.threadId);
    mailDbId = ""; // not needed for upsertThreadIndex on UPDATE branch
  }

  // If the user has muted this thread, new replies stay archived and
  // don't increment unread_count. New threads can't be muted.
  const muted = thread.isNew ? false : await isThreadMuted(env, thread.threadId);

  // Blocked-sender check (#74). We still store the message — the user can
  // unblock and recover from "All mail" — but force the thread into
  // archived state and skip the unread bump and push fan-out so it never
  // reaches the inbox or the user's device. Lowercased to match the
  // case-insensitive insert at the API site.
  const fromAddrLower = parsed.from.addr.toLowerCase();
  const blockedRow = await env.DB
    .prepare("SELECT 1 AS hit FROM blocked_senders WHERE mailbox_id = ? AND addr = ?")
    .bind(recipient.mailboxId, fromAddrLower)
    .first<{ hit: number }>();
  const blocked = blockedRow !== null;

  // Either signal suppresses the inbox surface; behaviourally identical
  // downstream so we collapse them.
  const suppress = muted || blocked;

  // Idempotency: if this Message-ID is already stored for this mailbox in
  // the target mail DB, bail. (We're past the threading step, so the right
  // mail DB to check is the one we're about to write to — same DB the
  // existing message would live in if it's a true duplicate.)
  const existing = await mailDb
    .prepare("SELECT id, thread_id FROM messages WHERE mailbox_id = ? AND message_id_header = ?")
    .bind(recipient.mailboxId, parsed.messageId)
    .first<{ id: string; thread_id: string }>();
  if (existing) {
    return { messageId: existing.id, threadId: existing.thread_id, duplicate: true };
  }

  const messageId = crypto.randomUUID();
  const dateSeconds = Math.floor(parsed.date / 1000);
  const rawKey = `mailbox/${recipient.mailboxId}/${messageId}.eml`;

  await env.RAW_MAIL.put(rawKey, rawBytes, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: { mailbox: recipient.mailboxId, messageId },
  });

  // If the message has an HTML body, store it alongside the raw .eml in R2.
  // The DB row keeps the key; the body itself can be huge, so it lives in R2.
  let htmlR2Key: string | null = null;
  if (parsed.html) {
    htmlR2Key = `mailbox/${recipient.mailboxId}/${messageId}.html`;
    await env.RAW_MAIL.put(htmlR2Key, parsed.html, {
      httpMetadata: { contentType: "text/html" },
      customMetadata: { mailbox: recipient.mailboxId, messageId },
    });
  }

  const attachmentInserts: Array<{ id: string; r2Key: string; a: ParsedMessage["attachments"][number] }> = [];
  for (const a of parsed.attachments) {
    const id = crypto.randomUUID();
    const r2Key = `mailbox/${recipient.mailboxId}/${messageId}/${id}`;
    await env.ATTACHMENTS.put(r2Key, a.bytes, {
      httpMetadata: { contentType: a.contentType },
      customMetadata: a.filename ? { filename: a.filename } : undefined,
    });
    attachmentInserts.push({ id, r2Key, a });
  }

  const stmts: D1PreparedStatement[] = [];

  if (thread.isNew) {
    stmts.push(
      mailDb
        .prepare(
          `INSERT INTO threads (id, mailbox_id, subject_normalized, last_message_at, message_count, unread_count)
           VALUES (?, ?, ?, ?, 0, 0)`,
        )
        .bind(thread.threadId, recipient.mailboxId, thread.subjectNormalized, dateSeconds),
    );
  }

  // First-contact lookup: is this the first time we've seen mail from
  // this address in this mailbox? Lookup runs against the same mail DB
  // we're about to insert into; if the existing prior message is in a
  // different (overflow) mail DB, we'll mis-flag this as first contact.
  // Acceptable trade-off — overflow is rare, and the alternative is
  // fanning out across every mail DB on every inbound. Old rows pre-0018
  // are never first_contact (DEFAULT 0), so the very first inbound after
  // migration may render the banner — that's expected.
  const firstContact = await isFirstContact(
    mailDb,
    recipient.mailboxId,
    fromAddrLower,
  );

  // Serialize auth_results once; null roundtrips to SQL NULL.
  const authResultsJson = parsed.authResults
    ? JSON.stringify(parsed.authResults)
    : null;

  // Heuristic auto-categorization (#68). Pure function over ParsedMessage —
  // no I/O, so we run it inline rather than burning a prepare/bind for it.
  // Pre-categorizer rows have NULL category and are treated as Primary by
  // the listing query, so we never need a backfill.
  const category = categorize(parsed);

  // Two-axis triage classifier (#3, #7). parse.ts produced a first pass
  // from headers-only signals; here we re-run with the per-user context
  // (VIP / contacts / mailbox-ownership / first-contact) the email-worker
  // can resolve via control-DB lookups. Best-effort — a lookup failure
  // degrades to the headers-only classification rather than blocking
  // ingest.
  const triageCtx = await loadTriageContext(env, recipient.mailboxId, fromAddrLower, firstContact);
  const triage = classify(parsed, triageCtx);

  // Opt-in auto-archive (0055). If the mailbox owner turned it on, file new
  // marketing/quiet threads straight to archived — same inbox suppression as
  // muted mail (no unread bump, no push), plus a timestamp the digest banner
  // reads. Restricted to NEW threads so a stray bulk message can never sweep
  // an active human conversation, and to (marketing & !action) so receipts /
  // verifies that still want a click (the "Bulk action" lane) stay visible.
  const autoArchive =
    thread.isNew &&
    triage.isMarketing &&
    !triage.isActionItem &&
    (await ownerWantsAutoArchive(env, recipient.mailboxId));

  stmts.push(
    mailDb
      .prepare(
        `INSERT INTO messages
         (id, thread_id, mailbox_id, message_id_header, in_reply_to, references_chain,
          direction, from_addr, from_name, to_json, cc_json, bcc_json,
          subject, date, snippet, raw_r2_key, html_r2_key, text_body, read, starred,
          auth_results, first_contact, reply_to_addr,
          list_unsub_url, list_unsub_mailto, list_unsub_one_click, category,
          is_marketing, is_action_item)
         VALUES (?, ?, ?, ?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0,
                 ?, ?, ?,
                 ?, ?, ?, ?,
                 ?, ?)`,
      )
      .bind(
        messageId,
        thread.threadId,
        recipient.mailboxId,
        parsed.messageId,
        parsed.inReplyTo ?? null,
        parsed.references.length ? parsed.references.join(" ") : null,
        parsed.from.addr,
        parsed.from.name ?? null,
        JSON.stringify(parsed.to),
        parsed.cc.length ? JSON.stringify(parsed.cc) : null,
        parsed.bcc.length ? JSON.stringify(parsed.bcc) : null,
        parsed.subject || null,
        dateSeconds,
        parsed.snippet,
        rawKey,
        htmlR2Key,
        parsed.text ?? null,
        authResultsJson,
        firstContact ? 1 : 0,
        parsed.replyToAddr,
        parsed.listUnsubUrl,
        parsed.listUnsubMailto,
        parsed.listUnsubOneClick ? 1 : 0,
        category,
        triage.isMarketing ? 1 : 0,
        triage.isActionItem ? 1 : 0,
      ),
  );

  for (const { id, r2Key, a } of attachmentInserts) {
    stmts.push(
      mailDb
        .prepare(
          `INSERT INTO attachments (id, message_id, filename, content_type, size, inline_cid, r2_key, is_executable)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          messageId,
          a.filename,
          a.contentType,
          a.bytes.byteLength,
          a.contentId ?? null,
          r2Key,
          a.isExecutable ? 1 : 0,
        ),
    );
  }

  // Calendar invite (#70). The first text/calendar attachment we can parse
  // populates message_calendar_events for the inline RSVP card. Wrapped in
  // try/catch — a malformed .ics must never block ingest of an otherwise
  // perfectly good message.
  const calendarParse = buildCalendarInsert(mailDb, messageId, parsed.attachments);
  if (calendarParse) stmts.push(calendarParse.stmt);

  // Bump thread counters on the mail-DB threads row. Source of truth for the
  // listing UI is threads_index in control (upserted just below); this keeps
  // the local thread row consistent so internal joins (next reply lookup,
  // etc.) see fresh data.
  stmts.push(
    mailDb
      .prepare(
        `UPDATE threads
           SET message_count = message_count + 1,
               unread_count  = unread_count  + ?,
               last_message_at = MAX(last_message_at, ?)
         WHERE id = ?`,
      )
      .bind(suppress ? 0 : 1, dateSeconds, thread.threadId),
  );

  await mailDb.batch(stmts);

  // Calendar CANCEL handling (#77). A METHOD=CANCEL invite marks every
  // promoted `calendar_events` row for the same ical_uid as cancelled —
  // cross-user, since a shared mailbox can have many subscribers. Done
  // against env.DB (control plane) because that's where per-user state
  // lives. Best-effort: a failure here can't roll back the message, and
  // worst case the user's calendar still shows the original event until
  // they clear it manually.
  //
  // Security: the UPDATE is additionally scoped by organizer_email.
  // `calendar_events` is one shared table and the same ical_uid exists as a
  // separate row per user who promoted the invite; without the organizer
  // predicate anyone who knows a UID (co-recipients of a real invite do)
  // could cancel everyone's copy by mailing themselves a forged CANCEL. We
  // require the CANCEL's ORGANIZER to match the stored organizer_email. A
  // CANCEL with no parseable ORGANIZER cannot be authenticated against the
  // stored event, so we skip the update entirely.
  if (calendarParse && calendarParse.parsedMethod === "CANCEL" && calendarParse.parsedUid) {
    if (!calendarParse.parsedOrganizer) {
      console.warn(
        "calendar CANCEL skipped: no ORGANIZER to authenticate against stored event",
      );
    } else {
      try {
        await env.DB
          .prepare(
            `UPDATE calendar_events
                SET cancelled = 1, updated_at = unixepoch()
              WHERE ical_uid = ? AND organizer_email = ?`,
          )
          .bind(calendarParse.parsedUid, calendarParse.parsedOrganizer)
          .run();
      } catch (err) {
        console.warn("calendar CANCEL propagate failed", err);
      }
    }
  }

  // Calendar REPLY handling (#81). When an attendee replies to a
  // self-event invite, the inbound mail carries METHOD=REPLY plus the
  // ATTENDEE's PARTSTAT. We flip calendar_event_attendees.rsvp_status on
  // the matching (ical_uid, email) row instead of the user-RSVP path —
  // the user-RSVP path is for THIS user RSVPing to someone ELSE's invite,
  // not the other way around. Best-effort: a missing attendee row just
  // means the REPLY arrived for an event we don't own, which is fine to
  // silently ignore.
  if (
    calendarParse &&
    calendarParse.parsedMethod === "REPLY" &&
    calendarParse.parsedUid &&
    calendarParse.replyAttendee &&
    calendarParse.replyPartstat
  ) {
    try {
      await env.DB
        .prepare(
          `UPDATE calendar_event_attendees
              SET rsvp_status = ?, responded_at = unixepoch()
            WHERE email = ?
              AND event_id IN (
                SELECT id FROM calendar_events WHERE ical_uid = ? AND source = 'self'
              )`,
        )
        .bind(
          calendarParse.replyPartstat,
          calendarParse.replyAttendee,
          calendarParse.parsedUid,
        )
        .run();
    } catch (err) {
      console.warn("calendar REPLY routing failed", err);
    }
  }

  // Control-side bookkeeping. Independent of the mail batch — failures here
  // mean the message is still on disk and visible via the next read; we just
  // log so a sweeper can reconcile.
  if (thread.isNew) {
    try {
      await registerThreadLocation(env, thread.threadId, mailDbId);
    } catch (err) {
      console.error("registerThreadLocation failed", err);
    }
  }

  try {
    await upsertThreadIndex(env, {
      threadId: thread.threadId,
      mailboxId: recipient.mailboxId,
      mailDbId: mailDbId || "primary",
      subjectNormalized: thread.subjectNormalized,
      lastMessageAt: dateSeconds,
      // Muted threads and mail from blocked senders don't bump unread and
      // stay archived — they shouldn't re-surface in the inbox just because
      // a new message arrived.
      unreadDelta: suppress || autoArchive ? 0 : 1,
      forceArchived: suppress || autoArchive,
      autoArchivedAt: autoArchive ? dateSeconds : undefined,
      lastMessageId: messageId,
      lastSubject: parsed.subject || null,
      lastFromAddr: parsed.from.addr,
      lastFromName: parsed.from.name ?? null,
      lastSnippet: parsed.snippet,
      createdAt: thread.isNew ? dateSeconds : undefined,
    });
  } catch (err) {
    console.error("upsertThreadIndex failed", err);
  }

  // Run user-defined filter rules. Skipped for muted/blocked-sender mail
  // (already suppressed; rules would only churn flags that don't matter)
  // — actual evaluation is best-effort, so a rule failure can't block
  // ingestion. Done synchronously before push fan-out so an "archive" or
  // "delete" rule has a chance to suppress the notification.
  let ruleApplied = false;
  if (!suppress) {
    try {
      // recipient.mailboxId is the local-part owner; fetch it once for
      // matching against `to_contains` rules. Lowercased so the matcher
      // can do plain substring checks.
      const mb = await env.DB
        .prepare("SELECT local_part FROM mailboxes WHERE id = ?")
        .bind(recipient.mailboxId)
        .first<{ local_part: string }>();
      const localPart = (mb?.local_part ?? "").toLowerCase();
      const subjectLower = (parsed.subject ?? "").toLowerCase();

      // Detect "real" attachments — postal-mime hands us inline images and
      // signature parts in the same array, but for matching purposes the
      // useful definition is "non-inline".
      const hasAttachment = parsed.attachments.some(a => a.disposition !== "inline");

      // Snapshot threads_index BEFORE rules so we can detect a terminal
      // (archive/delete) action and suppress the push fan-out below.
      await evaluateRules(env, {
        mailboxId: recipient.mailboxId,
        threadId: thread.threadId,
        messageId,
        mailDb,
        mailDbId: mailDbId || "primary",
        fromAddrLower,
        subjectLower,
        recipientLocalPartLower: localPart,
        hasAttachment,
      });
      ruleApplied = true;
    } catch (err) {
      console.error("rule evaluation failed", err);
    }
  }

  // If a terminal rule fired (archive/delete), the thread row is either
  // archived or gone — neither case wants a push notification. Detect by
  // re-reading threads_index; missing or archived = suppress.
  let suppressPush = suppress || autoArchive;
  if (ruleApplied && !suppressPush) {
    const post = await env.DB
      .prepare("SELECT archived FROM threads_index WHERE thread_id = ?")
      .bind(thread.threadId)
      .first<{ archived: number }>();
    if (!post || post.archived === 1) suppressPush = true;
  }

  // Fire-and-forget Web Push fan-out via the web worker. Wrapped in
  // ctx.waitUntil so the email handler returns fast; failures here never
  // affect mail ingestion. Muted threads, blocked senders, and rule-archived
  // threads suppress push too — same reason we keep them archived.
  if (!suppressPush) {
    ctx.waitUntil(notifyWebOfNewMessage(env, recipient.mailboxId, thread.threadId, messageId, parsed));
  }

  // Vacation auto-responder. Independent of suppress/push gating — even
  // muted/blocked-sender mail can fire a canned reply in principle, but in
  // practice the anti-loop checks inside maybeAutoReply (RFC 3834 +
  // cooldown) keep it sane. waitUntil so we never block ingestion on the
  // round-trip back to the web worker.
  ctx.waitUntil(maybeAutoReply(env, recipient.mailboxId, parsed));

  return { messageId, threadId: thread.threadId, duplicate: false };
}

interface CalendarParseResult {
  stmt: D1PreparedStatement;
  parsedUid: string | null;
  parsedMethod: string | null;   // uppercase: REQUEST | CANCEL | REPLY | …
  // ORGANIZER mailbox (bare email, already lowercased by parseIcs). Used to
  // scope the cross-user CANCEL UPDATE so an attacker can't cancel events
  // they don't organise just by knowing the ical_uid. NULL when the .ics
  // has no parseable ORGANIZER.
  parsedOrganizer: string | null;
  // METHOD=REPLY only — surface so the caller can route the rsvp flip
  // without re-parsing. Both null on REQUEST/CANCEL/PUBLISH.
  replyAttendee: string | null;
  replyPartstat: "ACCEPTED" | "TENTATIVE" | "DECLINED" | "NEEDS-ACTION" | null;
}

// Build the message_calendar_events INSERT for the first text/calendar
// attachment we can parse, or return null if the message has none / nothing
// parseable. Decoding is wrapped in try/catch so a hostile/malformed .ics
// can't poison the ingest pipeline — we'd rather lose the calendar card
// than the message.
//
// Returns the statement plus the parsed METHOD + UID so the caller can act
// on CANCEL (cross-user UPDATE on the control-DB calendar_events table)
// without re-decoding the .ics.
function buildCalendarInsert(
  mailDb: D1Database,
  messageId: string,
  attachments: ParsedMessage["attachments"],
): CalendarParseResult | null {
  for (const a of attachments) {
    const ct = (a.contentType || "").toLowerCase();
    if (!ct.startsWith("text/calendar")) continue;
    try {
      const ics = new TextDecoder().decode(a.bytes);
      const parsed = parseIcs(ics);
      if (!parsed) continue;
      // #89: rrule + tz threaded onto the row so promoteInvitesForThread
      // can carry recurrence and the originating IANA zone into the per-user
      // calendar_events table. Both are already on ParsedIcs and may be
      // NULL (single-shot / floating / UTC-only invites).
      const stmt = mailDb
        .prepare(
          `INSERT INTO message_calendar_events
             (message_id, starts_at, ends_at, summary, location, organizer, uid, method, raw_ics, rrule, tz)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (message_id) DO NOTHING`,
        )
        .bind(
          messageId,
          parsed.startsAt,
          parsed.endsAt,
          parsed.summary,
          parsed.location,
          parsed.organizer,
          parsed.uid,
          parsed.method,
          ics,
          parsed.rrule,
          parsed.tz,
        );
      return {
        stmt,
        parsedUid: parsed.uid,
        parsedMethod: parsed.method ? parsed.method.toUpperCase() : null,
        // parseIcs already lowercases the organizer mailbox; keep it as-is so
        // it lines up with the lowercased calendar_events.organizer_email.
        parsedOrganizer: parsed.organizer,
        replyAttendee: parsed.replyAttendee,
        replyPartstat: parsed.replyPartstat,
      };
    } catch (err) {
      console.warn("ics parse failed", err);
      continue;
    }
  }
  return null;
}

// Per-message context for the triage classifier (#3 / #7). All three of
// the lookups (VIP membership, sender-domain-in-contacts, mailbox
// ownership) hit the control DB; any one of them failing falls back to
// `false` for that signal so a degraded control DB can never block mail
// ingestion. firstContact is computed upstream and passed in unchanged.
async function loadTriageContext(
  env: Env,
  mailboxId: string,
  fromAddrLower: string,
  firstContact: boolean,
): Promise<TriageContext> {
  let fromAddrIsVip = false;
  let senderDomainInContacts = false;
  let mailboxIsOwned = false;

  try {
    // VIP is keyed on (user_id, addr) but we don't have a user here — VIPs
    // are a per-recipient construct. For shared mailboxes there may be
    // multiple users; we count the address as VIP if ANY owner of this
    // mailbox has it on their list. That's the same liberal definition the
    // notification path uses for VIP-bypass-DnD.
    const vip = await env.DB
      .prepare(
        `SELECT 1 AS hit
           FROM vip_senders v
           INNER JOIN user_mailbox_access uma
                   ON uma.user_id = v.user_id
                  AND uma.mailbox_id = ?
          WHERE v.addr = ?
          LIMIT 1`,
      )
      .bind(mailboxId, fromAddrLower)
      .first<{ hit: number }>();
    fromAddrIsVip = vip !== null;
  } catch (err) {
    console.warn("triage: VIP lookup failed", err);
  }

  try {
    const atIdx = fromAddrLower.lastIndexOf("@");
    const fromDomain = atIdx > 0 ? fromAddrLower.slice(atIdx + 1) : "";
    if (fromDomain) {
      const row = await env.DB
        .prepare(
          `SELECT 1 AS hit FROM contacts
            WHERE mailbox_id = ? AND email_lc LIKE ?
            LIMIT 1`,
        )
        .bind(mailboxId, `%@${fromDomain}`)
        .first<{ hit: number }>();
      senderDomainInContacts = row !== null;
    }
  } catch (err) {
    console.warn("triage: contacts lookup failed", err);
  }

  try {
    // Mailbox is "owned" if at least one user has owner role on it. That
    // matches the semantics the spec calls out — replies-expected business
    // mail to a mailbox you control.
    const row = await env.DB
      .prepare(
        `SELECT 1 AS hit FROM user_mailbox_access
          WHERE mailbox_id = ? AND role = 'owner'
          LIMIT 1`,
      )
      .bind(mailboxId)
      .first<{ hit: number }>();
    mailboxIsOwned = row !== null;
  } catch (err) {
    console.warn("triage: mailbox-owner lookup failed", err);
  }

  return {
    senderDomainInContacts,
    fromAddrIsVip,
    firstContact,
    mailboxIsOwned,
  };
}

// Auto-archive opt-in (0055). True when an OWNER of this mailbox has turned on
// auto_archive_marketing in their preferences. Best-effort: a lookup failure
// degrades to "off" so a transient DB hiccup never silently files mail away.
// Scoped to role='owner' so a shared viewer's preference can't change what the
// owner sees in their own inbox.
async function ownerWantsAutoArchive(env: Env, mailboxId: string): Promise<boolean> {
  try {
    const row = await env.DB
      .prepare(
        `SELECT up.auto_archive_marketing AS v
           FROM user_mailbox_access uma
           JOIN user_preferences up ON up.user_id = uma.user_id
          WHERE uma.mailbox_id = ? AND uma.role = 'owner'
            AND up.auto_archive_marketing = 1
          LIMIT 1`,
      )
      .bind(mailboxId)
      .first<{ v: number }>();
    return row?.v === 1;
  } catch (err) {
    console.error("ownerWantsAutoArchive lookup failed", err);
    return false;
  }
}

async function notifyWebOfNewMessage(
  env: Env,
  mailboxId: string,
  threadId: string,
  messageId: string,
  parsed: ParsedMessage,
): Promise<void> {
  if (!env.WEB || !env.INTERNAL_SECRET) return;
  try {
    const res = await env.WEB.fetch(
      new Request("https://internal/api/internal/notify-new-message", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-secret": env.INTERNAL_SECRET,
        },
        body: JSON.stringify({
          mailboxId,
          threadId,
          messageId,
          fromAddr: parsed.from.addr,
          fromName: parsed.from.name ?? null,
          subject: parsed.subject || null,
        }),
      }),
    );
    if (!res.ok) {
      console.warn(`notify-new-message ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  } catch (err) {
    console.warn("notify-new-message threw", err);
  }
}
