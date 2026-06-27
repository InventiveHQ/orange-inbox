import { getDb } from "./db";
import { getActiveMailDbs, getMailDbForThread } from "./mail-db";

export interface DomainRow {
  id: string;
  name: string;
  display_name: string | null;
}

// Domains the user can see — they have access to at least one mailbox on the
// domain. Admins should use `listAllDomains` instead so they can manage
// domains they have no mailbox access on.
export async function listDomainsForUser(userId: string): Promise<DomainRow[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT DISTINCT d.id, d.name, d.display_name
         FROM domains d
         INNER JOIN mailboxes mb ON mb.domain_id = d.id
         INNER JOIN user_mailbox_access uma
           ON uma.mailbox_id = mb.id AND uma.user_id = ?
        ORDER BY d.name`,
    )
    .bind(userId)
    .all<DomainRow>();
  return results ?? [];
}

// Every domain in the system. Admin-only entry point for the management UI.
export async function listAllDomains(): Promise<DomainRow[]> {
  const { results } = await getDb()
    .prepare(`SELECT id, name, display_name FROM domains ORDER BY name`)
    .all<DomainRow>();
  return results ?? [];
}

export interface MailboxRow {
  id: string;
  domain_id: string;
  domain_name: string;
  local_part: string;
  display_name: string | null;
  is_catch_all: number;
  role: "owner" | "member" | "reader";
  member_count: number;
  is_shared: number;
  // Number of unread threads currently visible in this mailbox's inbox view —
  // i.e. matching the same archived filter as `listThreads`. Muted
  // threads are intentionally counted: a per-mailbox badge that ignores muted
  // can leave the user wondering where the unread count came from on the "all
  // inboxes" badge. The per-mailbox listing hides muted, but the count keeps
  // them so the badge math is consistent across views.
  unread_count: number;
  // User's manual sort position from drag-to-reorder (issue #52). 0 means
  // "unordered" — keep alphabetical default. Non-zero values lead the
  // alphabetical tail in the sidebar.
  sort_order: number;
}

// Mailboxes the user can read from. The sidebar groups these under domain
// headers. `is_shared` is just `member_count > 1`, surfaced for the UI badge.
//
// `unread_count` is the number of threads in `threads_index` for this mailbox
// that have unread_count > 0 and are visible in the inbox listing (not
// archived). Computed via a correlated subquery so
// each row stays a single round-trip — `threads_index` already has
// `(mailbox_id, archived, last_message_at)` covered by the listing index.
export async function listMailboxesForUser(userId: string): Promise<MailboxRow[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT mb.id, mb.domain_id, d.name AS domain_name, mb.local_part,
              mb.display_name, mb.is_catch_all, uma.role, uma.sort_order,
              (SELECT COUNT(*) FROM user_mailbox_access WHERE mailbox_id = mb.id) AS member_count,
              CASE WHEN (SELECT COUNT(*) FROM user_mailbox_access WHERE mailbox_id = mb.id) > 1
                   THEN 1 ELSE 0 END AS is_shared,
              (SELECT COUNT(*) FROM threads_index ti
                WHERE ti.mailbox_id = mb.id
                  AND ti.unread_count > 0
                  AND ti.archived = 0
              ) AS unread_count
         FROM mailboxes mb
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = mb.id
         INNER JOIN domains d ON d.id = mb.domain_id
        WHERE uma.user_id = ?
        -- sort_order = 0 is the "unordered" default → those rows fall
        -- through to the alphabetical tie-break below. Any row the user
        -- has explicitly dragged (sort_order >= 1) leads.
        ORDER BY CASE WHEN uma.sort_order = 0 THEN 1 ELSE 0 END,
                 uma.sort_order, d.name, mb.local_part`,
    )
    .bind(userId)
    .all<MailboxRow>();
  return results ?? [];
}

export interface ThreadListItem {
  id: string;
  subject_normalized: string;
  last_message_at: number;
  message_count: number;
  unread_count: number;
  starred: number;
  archived: number;
  muted: number;
  pinned: number;
  // Follow-up (issue #26). When `follow_up_enabled = 1` the thread is
  // a candidate for the Follow-ups view: it surfaces once `last_message_at`
  // is older than the configured cadence AND the most-recent message is
  // outbound (latter check happens at listDueFollowups time — not stored
  // here). `follow_up_minutes` (migration 0051) supersedes `follow_up_days`
  // when set; NULL on both means "use the global default" (4 days = 5760
  // minutes). The legacy days column lingers so older callers keep working
  // until they migrate to minutes.
  follow_up_enabled: number;
  follow_up_days: number | null;
  follow_up_minutes: number | null;
  domain_id: string;
  domain_name: string;
  mailbox_id: string;
  mailbox_local_part: string;
  last_subject: string | null;
  last_from_addr: string | null;
  last_from_name: string | null;
  last_snippet: string | null;
  // Labels applied to any message in this thread, deduped by label id.
  // Populated by listThreads via JSON_GROUP_ARRAY; see ThreadList rendering.
  labels: { id: string; name: string; color: string | null }[];
}

interface ThreadListRow extends Omit<ThreadListItem, "labels"> {
  labels_json: string | null;
}

// Auto-categorization buckets (#68). NULL category on a message means "this
// row predates the categorizer" and is treated as Primary by the listing
// query — see the category filter below.
export type MessageCategory =
  | "primary"
  | "promotions"
  | "updates"
  | "social"
  | "forums";

// Threads in mailboxes the user has read access to. `mailboxId` filters to
// a single mailbox; absence means "everything I can see" (the All inboxes
// view). Joining user_mailbox_access enforces visibility, so an unauthorised
// mailboxId silently returns empty.
//
// This reads exclusively from the control DB (`threads_index` + `thread_labels`
// + `mailboxes` + `domains` + `user_mailbox_access`). The actual messages live
// in whichever mail DB the thread was created in (resolved per-thread via
// `thread_locations`); listing never has to fan out across mail DBs because
// every field needed for a row in the inbox view is denormalised here.
//
// Exception: when `category` is set, we fan out across active mail DBs to
// collect thread IDs that have ANY message in the requested category, then
// filter the control-DB listing to that set. NULL-category messages are
// treated as Primary so the migration didn't need a backfill.
// Triage predicate (#3 / #7). Filters the listing to threads with at least
// one inbound message whose (is_marketing, is_action_item) pair matches.
// Same "any message in the thread matches" semantics the category filter
// uses — passed in by `listThreadsForTriage` after mapping a quadrant
// label to a (0|1, 0|1) pair.
export interface TriageFilter {
  isMarketing: 0 | 1;
  isActionItem: 0 | 1;
}

export async function listThreads(
  userId: string,
  opts: {
    mailboxId?: string;
    domainId?: string;
    limit?: number;
    includeMuted?: boolean;
    // "Show all" should truly show all — including archived threads. Other
    // views (per-mailbox inbox, triage quadrants) keep archived hidden.
    includeArchived?: boolean;
    // Dedicated Archived view — show ONLY archived threads, overriding
    // includeArchived. Used by the /inbox/archived scope so users can browse
    // and restore archived mail.
    archivedOnly?: boolean;
    category?: MessageCategory;
    triage?: TriageFilter;
  } = {},
): Promise<ThreadListItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = ["uma.user_id = ?"];
  if (opts.archivedOnly) {
    where.push("ti.archived = 1");
  } else if (!opts.includeArchived) {
    where.push("ti.archived = 0");
  }
  const binds: unknown[] = [userId];

  // Muted threads are visible in the unified "all" view but hidden from
  // per-mailbox inboxes — caller decides which by passing includeMuted.
  if (!opts.includeMuted) {
    where.push("ti.muted = 0");
  }

  if (opts.mailboxId) {
    where.push("ti.mailbox_id = ?");
    binds.push(opts.mailboxId);
  }

  if (opts.domainId) {
    where.push("mb.domain_id = ?");
    binds.push(opts.domainId);
  }

  // Category filter (#68). Cross-DB: fan out to every active mail DB,
  // collect thread IDs whose messages match the requested category, and use
  // the union as a `ti.thread_id IN (...)` predicate. Primary treats NULL
  // category as "primary" so old rows surface in the default tab.
  if (opts.category) {
    const threadIds = await collectThreadIdsForCategory(opts.category);
    if (threadIds.length === 0) return [];
    // SQLite parameter limit is generous (default 100), but we cap the
    // listing at 200 anyway so a per-mailbox view cannot blow past it. The
    // up-front cap keeps the IN-list bounded; if more are requested we
    // truncate to the first N (most-recent — see the per-DB ORDER BY).
    const capped = threadIds.slice(0, 1000);
    const placeholders = capped.map(() => "?").join(",");
    where.push(`ti.thread_id IN (${placeholders})`);
    binds.push(...capped);
  }

  // Triage filter (#3 / #7). Same cross-DB fan-out shape as category — fetch
  // thread IDs whose inbound messages match the (is_marketing, is_action_item)
  // pair, intersect into a `ti.thread_id IN (...)` predicate.
  if (opts.triage) {
    const threadIds = await collectThreadIdsForTriage(opts.triage);
    if (threadIds.length === 0) return [];
    const capped = threadIds.slice(0, 1000);
    const placeholders = capped.map(() => "?").join(",");
    where.push(`ti.thread_id IN (${placeholders})`);
    binds.push(...capped);
  }

  // Labels per thread come from `thread_labels` (the cache maintained by the
  // label-apply path). Aggregated via JSON_GROUP_ARRAY to keep the row shape
  // flat — same wire format as before.
  const sql = `
    SELECT
      ti.thread_id AS id,
      ti.subject_normalized,
      ti.last_message_at,
      ti.message_count,
      ti.unread_count,
      ti.starred,
      ti.archived,
      ti.muted,
      ti.pinned,
      ti.follow_up_enabled,
      ti.follow_up_days,
      ti.follow_up_minutes,
      d.id   AS domain_id,
      d.name AS domain_name,
      mb.id  AS mailbox_id,
      mb.local_part AS mailbox_local_part,
      ti.last_subject   AS last_subject,
      ti.last_from_addr AS last_from_addr,
      ti.last_from_name AS last_from_name,
      ti.last_snippet   AS last_snippet,
      (
        SELECT JSON_GROUP_ARRAY(
                 JSON_OBJECT('id', l.id, 'name', l.name, 'color', l.color)
               )
          FROM (
            SELECT l.id, l.name, l.color
              FROM thread_labels tl
              INNER JOIN labels l ON l.id = tl.label_id
             WHERE tl.thread_id = ti.thread_id
             ORDER BY l.name
          ) AS l
      ) AS labels_json
    FROM threads_index ti
    INNER JOIN mailboxes mb ON mb.id = ti.mailbox_id
    INNER JOIN domains d   ON d.id = mb.domain_id
    INNER JOIN user_mailbox_access uma ON uma.mailbox_id = ti.mailbox_id
    WHERE ${where.join(" AND ")}
    ORDER BY ti.pinned DESC, ti.last_message_at DESC
    LIMIT ?
  `;
  binds.push(limit);

  const { results } = await getDb().prepare(sql).bind(...binds).all<ThreadListRow>();
  return (results ?? []).map(parseThreadListRow);
}

// Digest count for the auto-archive banner (0055). How many threads the
// opt-in sweep has filed to Archive across the user's accessible mailboxes
// within the last `windowSeconds`. Drives the "N filed in the last day ·
// Review" reassurance banner; only counts threads still archived so a thread
// the user has since pulled back into the inbox doesn't inflate the number.
// The time window is evaluated in SQL (unixepoch()) so callers don't need a
// clock — keeps server components free of impure Date.now() reads.
export async function countRecentAutoArchived(
  userId: string,
  windowSeconds: number,
): Promise<number> {
  const row = await getDb()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM threads_index ti
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = ti.mailbox_id
        WHERE uma.user_id = ?
          AND ti.auto_archived_at IS NOT NULL
          AND ti.auto_archived_at >= unixepoch() - ?
          AND ti.archived = 1`,
    )
    .bind(userId, windowSeconds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function parseThreadListRow(row: ThreadListRow): ThreadListItem {
  let labels: ThreadListItem["labels"] = [];
  if (row.labels_json) {
    try {
      const parsed = JSON.parse(row.labels_json) as ThreadListItem["labels"];
      if (Array.isArray(parsed)) labels = parsed;
    } catch {
      labels = [];
    }
  }
  const { labels_json: _unused, ...rest } = row;
  void _unused;
  return { ...rest, labels };
}

export interface ThreadDetail {
  thread: {
    id: string;
    subject_normalized: string;
    last_message_at: number;
    message_count: number;
    unread_count: number;
    starred: number;
    archived: number;
    muted: number;
    pinned: number;
    domain_name: string;
    mailbox_id: string;
    mailbox_local_part: string;
    // Caller's role on the thread's mailbox — drives "can the Reply button
    // appear" and similar gates in the reader UI.
    user_role: "owner" | "member" | "reader";
    // Follow-up state (issue #26 + sub-day cadences via migration 0051).
    // `follow_up_enabled` is the per-thread opt-in; `follow_up_minutes`
    // is the cadence override (preferred); `follow_up_days` is the
    // legacy column kept for read-fallback.
    follow_up_enabled: number;
    follow_up_days: number | null;
    follow_up_minutes: number | null;
  };
  messages: ThreadMessage[];
}

export interface AttachmentRow {
  id: string;
  message_id: string;
  filename: string | null;
  content_type: string | null;
  size: number;
  inline_cid: string | null;
  // 1 = parser flagged as executable / dangerous (see email-worker's
  // attachment-safety.ts). UI uses this to render a warning badge and gate
  // the download behind a confirm modal.
  is_executable: number;
}

// Calendar invite (#70). Populated for messages that arrived with a
// parseable text/calendar attachment — the email-worker drops the parsed
// VEVENT into message_calendar_events at ingest, the reader LEFT JOINs it
// back here so ThreadView can render an inline RSVP card without a second
// round-trip.
//
// #77 adds per-user state on top: once the user has opened the thread we
// promote the invite into `calendar_events` (control DB) and surface the
// caller's rsvp_status + cancelled flag + the per-user event id alongside
// the mail-DB parse. The reader uses these to render an RSVP pill (so
// page reload doesn't re-prompt) and a "Cancelled" badge.
export interface CalendarEvent {
  starts_at: number;          // unix seconds
  ends_at: number | null;
  summary: string | null;
  location: string | null;
  organizer: string | null;
  uid: string | null;
  method: string | null;
  // #89: parsed RRULE + originating TZID lifted at ingest. Threaded through
  // promoteInvitesForThread so calendar_events gets the same values and
  // recurring inbound invites render every occurrence in-window.
  // NULL on single-shot / floating / UTC-only invites.
  rrule: string | null;
  tz: string | null;
  // Per-user state (NULL until the user opens the thread once, then
  // promoted lazily). When NULL the reader falls back to the v1 stateless
  // behaviour — Accept/Tentative/Decline buttons.
  rsvp_status: "NEEDS-ACTION" | "ACCEPTED" | "TENTATIVE" | "DECLINED" | null;
  cancelled: number;          // 1 when a METHOD=CANCEL has arrived for this UID
  event_id: string | null;    // control-DB calendar_events.id, NULL pre-promotion
}

export interface ThreadMessage {
  id: string;
  message_id_header: string;
  direction: "inbound" | "outbound";
  from_addr: string;
  from_name: string | null;
  to_json: string;
  cc_json: string | null;
  subject: string | null;
  date: number;
  snippet: string | null;
  text_body: string | null;
  html_r2_key: string | null;
  read: number;
  starred: number;
  // Internal attribution for shared mailboxes — populated for outbound only.
  sent_by_email: string | null;
  sent_by_display_name: string | null;
  // 0018: trust signals. Populated for inbound only; outbound rows leave
  // these as null/0 since we don't compute auth on our own sends.
  //   auth_results   — JSON {spf,dkim,dmarc,from_domain} or null
  //   first_contact  — 1 the first time this from_addr was seen in the mailbox
  //   reply_to_addr  — bare Reply-To, only when it differs from from_addr
  auth_results: string | null;
  first_contact: number;
  reply_to_addr: string | null;
  // 0019: newsletter unsubscribe metadata extracted at ingest from RFC 2369 /
  // RFC 8058 headers. The reader UI surfaces an Unsubscribe chip when one
  // of the URL fields is present and unsubscribed_at is null; once stamped,
  // the chip flips to "Unsubscribed" and the API short-circuits.
  list_unsub_url: string | null;
  list_unsub_mailto: string | null;
  list_unsub_one_click: number;
  unsubscribed_at: number | null;
  attachments: AttachmentRow[];
  // 0026: parsed VEVENT from a text/calendar attachment, if any. NULL when
  // the message had no .ics, the .ics was unparseable, or the attachment
  // didn't carry a DTSTART. Drives the inline calendar card + RSVP buttons.
  calendar_event: CalendarEvent | null;
  // 0033: opt-in read receipt. Non-null on outbound messages where the
  // sender enabled "Track opens" in the composer. The reader uses
  // read_count + last_opened_at to render the "Read N times · last {when}"
  // pill on the sender's view of the outbound message. NULL for messages
  // sent before the feature shipped or with the toggle off.
  tracking_token: string | null;
  read_count: number;
  last_opened_at: number | null;
}

// The thread head (visibility check + listing-style fields) comes from the
// control DB — `threads_index` already has everything the reader header
// needs, and joining mailboxes/domains/uma there enforces access.
//
// Messages and attachments live in the thread's mail DB, which we resolve
// via `thread_locations` (defaulting to 'primary' when no row exists). The
// `users` join — needed for `sent_by_email/display_name` on outbound
// messages — happens in the control DB after the message rows come back,
// rather than as a JOIN, since users live in control and messages don't.
export async function getThreadDetail(userId: string, threadId: string): Promise<ThreadDetail | null> {
  const head = await getDb()
    .prepare(
      `SELECT ti.thread_id AS id, ti.subject_normalized, ti.last_message_at,
              ti.message_count, ti.unread_count, ti.starred, ti.archived,
              ti.muted, ti.pinned,
              ti.follow_up_enabled, ti.follow_up_days, ti.follow_up_minutes,
              d.name AS domain_name,
              mb.id AS mailbox_id, mb.local_part AS mailbox_local_part,
              uma.role AS user_role
         FROM threads_index ti
         INNER JOIN mailboxes mb ON mb.id = ti.mailbox_id
         INNER JOIN domains d ON d.id = mb.domain_id
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = ti.mailbox_id
        WHERE ti.thread_id = ? AND uma.user_id = ?`,
    )
    .bind(threadId, userId)
    .first<ThreadDetail["thread"]>();
  if (!head) return null;

  const mailDb = await getMailDbForThread(threadId);

  // Mail-DB row shape — sent_by_user_id stays here; we resolve it to email +
  // display_name via a follow-up control-DB lookup since users live there.
  // Calendar fields come from a LEFT JOIN against message_calendar_events
  // and are repacked into the nested `calendar_event` shape below. The
  // per-user state (rsvp_status, cancelled, event_id from calendar_events
  // in the CONTROL DB) is layered on after this fetch — the mail DB and
  // control DB are independent D1 instances so we can't join across them.
  type RawMessageRow = Omit<
    ThreadMessage,
    | "attachments"
    | "sent_by_email"
    | "sent_by_display_name"
    | "calendar_event"
    | "read_count"
    | "last_opened_at"
  > & {
    sent_by_user_id: string | null;
    cal_starts_at: number | null;
    cal_ends_at: number | null;
    cal_summary: string | null;
    cal_location: string | null;
    cal_organizer: string | null;
    cal_uid: string | null;
    cal_method: string | null;
    cal_rrule: string | null;
    cal_tz: string | null;
  };

  const { results } = await mailDb
    .prepare(
      `SELECT m.id, m.message_id_header, m.direction, m.from_addr, m.from_name,
              m.to_json, m.cc_json, m.subject, m.date, m.snippet, m.text_body,
              m.html_r2_key, m.read, m.starred, m.sent_by_user_id,
              m.auth_results, m.first_contact, m.reply_to_addr,
              m.list_unsub_url, m.list_unsub_mailto, m.list_unsub_one_click,
              m.unsubscribed_at, m.tracking_token,
              ce.starts_at AS cal_starts_at,
              ce.ends_at   AS cal_ends_at,
              ce.summary   AS cal_summary,
              ce.location  AS cal_location,
              ce.organizer AS cal_organizer,
              ce.uid       AS cal_uid,
              ce.method    AS cal_method,
              ce.rrule     AS cal_rrule,
              ce.tz        AS cal_tz
         FROM messages m
         LEFT JOIN message_calendar_events ce ON ce.message_id = m.id
        WHERE m.thread_id = ?
        ORDER BY m.date ASC`,
    )
    .bind(threadId)
    .all<RawMessageRow>();

  const messageRows = results ?? [];

  // Resolve sent_by_user_id → email/display_name via the control DB. Done
  // with a single `WHERE id IN (...)` query rather than N+1.
  const senderIds = Array.from(
    new Set(messageRows.map(m => m.sent_by_user_id).filter((x): x is string => !!x)),
  );
  const senderMap = new Map<string, { email: string | null; display_name: string | null }>();
  if (senderIds.length > 0) {
    const placeholders = senderIds.map(() => "?").join(",");
    const { results: userRows } = await getDb()
      .prepare(
        `SELECT id, email, display_name FROM users WHERE id IN (${placeholders})`,
      )
      .bind(...senderIds)
      .all<{ id: string; email: string | null; display_name: string | null }>();
    for (const u of userRows ?? []) {
      senderMap.set(u.id, { email: u.email, display_name: u.display_name });
    }
  }

  // One round-trip for all attachments in the thread; bucket by message_id.
  // Avoids an N+1 across messages without joining/duplicating message columns.
  const { results: attachmentRows } = await mailDb
    .prepare(
      `SELECT a.id, a.message_id, a.filename, a.content_type, a.size, a.inline_cid,
              a.is_executable
         FROM attachments a
         INNER JOIN messages m ON m.id = a.message_id
        WHERE m.thread_id = ?
        ORDER BY a.id ASC`,
    )
    .bind(threadId)
    .all<AttachmentRow>();

  const attachmentsByMessage = new Map<string, AttachmentRow[]>();
  for (const a of attachmentRows ?? []) {
    const list = attachmentsByMessage.get(a.message_id);
    if (list) list.push(a);
    else attachmentsByMessage.set(a.message_id, [a]);
  }

  // Per-user calendar state (#77). For each message that carries an invite
  // with a UID, pull the caller's matching calendar_events row from the
  // control DB so the reader can render the RSVP pill / Cancelled badge
  // without a second round-trip on the client. Skips messages with no UID
  // — those can't be matched and stay stateless (the v1 RSVP-via-reply
  // path is unaffected).
  const uids = Array.from(
    new Set(
      messageRows
        .map(m => m.cal_uid)
        .filter((u): u is string => !!u),
    ),
  );
  const stateByUid = new Map<
    string,
    {
      rsvp_status: CalendarEvent["rsvp_status"];
      cancelled: number;
      event_id: string;
    }
  >();
  if (uids.length > 0) {
    const placeholders = uids.map(() => "?").join(",");
    const { results: stateRows } = await getDb()
      .prepare(
        `SELECT id, ical_uid, rsvp_status, cancelled
           FROM calendar_events
          WHERE user_id = ? AND ical_uid IN (${placeholders})`,
      )
      .bind(userId, ...uids)
      .all<{
        id: string;
        ical_uid: string;
        rsvp_status: CalendarEvent["rsvp_status"];
        cancelled: number;
      }>();
    for (const r of stateRows ?? []) {
      stateByUid.set(r.ical_uid, {
        rsvp_status: r.rsvp_status,
        cancelled: r.cancelled,
        event_id: r.id,
      });
    }
  }

  // Read-receipt counts (#69). Outbound messages with a tracking_token get a
  // (count, last_opened_at) lookup from the control DB so the reader can
  // render the "Read N times · last {when}" pill. Inbound and no-token
  // outbound messages skip the round-trip entirely.
  const trackedMessageIds = messageRows
    .filter(m => m.direction === "outbound" && !!m.tracking_token)
    .map(m => m.id);
  const readStatsByMessageId = new Map<
    string,
    { count: number; last: number | null }
  >();
  if (trackedMessageIds.length > 0) {
    const placeholders = trackedMessageIds.map(() => "?").join(",");
    const { results: statRows } = await getDb()
      .prepare(
        `SELECT message_id, COUNT(*) AS count, MAX(opened_at) AS last
           FROM message_read_events
          WHERE message_id IN (${placeholders})
          GROUP BY message_id`,
      )
      .bind(...trackedMessageIds)
      .all<{ message_id: string; count: number; last: number | null }>();
    for (const s of statRows ?? []) {
      readStatsByMessageId.set(s.message_id, { count: s.count, last: s.last });
    }
  }

  const messages: ThreadMessage[] = messageRows.map(m => {
    const sender = m.sent_by_user_id ? senderMap.get(m.sent_by_user_id) ?? null : null;
    const {
      sent_by_user_id: _drop,
      cal_starts_at, cal_ends_at, cal_summary, cal_location,
      cal_organizer, cal_uid, cal_method, cal_rrule, cal_tz,
      ...rest
    } = m;
    void _drop;
    const stats = readStatsByMessageId.get(m.id);
    // The LEFT JOIN nulls every cal_* field for messages without a row in
    // message_calendar_events. cal_starts_at is NOT NULL in the table, so
    // a non-null value there is the unambiguous "we have an event" signal.
    const state = cal_uid ? stateByUid.get(cal_uid) ?? null : null;
    const calendar_event: CalendarEvent | null =
      cal_starts_at != null
        ? {
            starts_at: cal_starts_at,
            ends_at: cal_ends_at,
            summary: cal_summary,
            location: cal_location,
            organizer: cal_organizer,
            uid: cal_uid,
            method: cal_method,
            rrule: cal_rrule,
            tz: cal_tz,
            rsvp_status: state?.rsvp_status ?? null,
            cancelled: state?.cancelled ?? 0,
            event_id: state?.event_id ?? null,
          }
        : null;
    return {
      ...rest,
      sent_by_email: sender?.email ?? null,
      sent_by_display_name: sender?.display_name ?? null,
      attachments: attachmentsByMessage.get(m.id) ?? [],
      calendar_event,
      read_count: stats?.count ?? 0,
      last_opened_at: stats?.last ?? null,
    };
  });

  return { thread: head, messages };
}

// ─── Subscriptions (issue #76) ───────────────────────────────────────────
//
// One row per (mailbox, sender) where at least one inbound message advertises
// a List-Unsubscribe mechanism. The page lets the user unsubscribe in bulk:
// pick a sender → POST the per-message unsubscribe action against the most
// recent message that still has an unsubscribe target → archive everything
// from that sender.
//
// Aggregation lives in the mail DB(s); we fan out across active DBs and
// merge in JS so the cross-DB single-D1 case stays trivial. The mailbox
// access check is applied via a control-DB pre-filter so a sender visible
// only on a mailbox the user can't see never appears in the result.

export interface SubscriptionRow {
  mailbox_id: string;
  mailbox_local_part: string;
  domain_name: string;
  from_addr: string;
  from_name: string | null;
  message_count: number;
  unsubscribed_count: number;
  last_message_at: number;
  // The latest message from this sender that still has an actionable
  // unsubscribe target and hasn't already been unsubscribed. NULL if every
  // such message has already been unsubscribed — UI shows an "All
  // unsubscribed" badge instead of a button.
  latest_actionable_message_id: string | null;
}

export async function listSubscriptionsForUser(
  userId: string,
): Promise<SubscriptionRow[]> {
  // Visible mailboxes — also doubles as the local_part / domain_name lookup
  // for the result rows so we don't have to re-join the control DB later.
  const mailboxes = await listMailboxesForUser(userId);
  if (mailboxes.length === 0) return [];

  const mailboxIds = new Set(mailboxes.map(mb => mb.id));
  const mailboxMeta = new Map(
    mailboxes.map(mb => [
      mb.id,
      { local_part: mb.local_part, domain_name: mb.domain_name },
    ]),
  );

  // Fan out across mail DBs. Each DB returns its slice of (mailbox, addr)
  // aggregates; we merge by composite key in JS.
  const { getActiveMailDbs } = await import("./mail-db");
  const dbs = await getActiveMailDbs();

  type DbRow = {
    mailbox_id: string;
    from_addr: string;
    from_name: string | null;
    message_count: number;
    unsubscribed_count: number;
    last_message_at: number;
    latest_actionable_message_id: string | null;
  };

  const merged = new Map<string, DbRow>();
  for (const { db } of dbs) {
    const { results } = await db
      .prepare(
        // Two aggregates in one pass:
        //   - count + unsubscribed_count + last_message_at: GROUP BY math.
        //   - latest_actionable_message_id: id of the most recent message
        //     from this sender where the unsubscribe target is still
        //     available AND we haven't already unsubscribed. Picked via a
        //     correlated subquery; avoids a second round-trip.
        `SELECT m.mailbox_id,
                LOWER(m.from_addr) AS from_addr,
                MAX(m.from_name)   AS from_name,
                COUNT(*)           AS message_count,
                SUM(CASE WHEN m.unsubscribed_at IS NULL THEN 0 ELSE 1 END) AS unsubscribed_count,
                MAX(m.date)        AS last_message_at,
                (
                  SELECT m2.id
                    FROM messages m2
                   WHERE m2.mailbox_id = m.mailbox_id
                     AND LOWER(m2.from_addr) = LOWER(m.from_addr)
                     AND m2.unsubscribed_at IS NULL
                     AND (m2.list_unsub_url IS NOT NULL OR m2.list_unsub_mailto IS NOT NULL)
                   ORDER BY m2.date DESC
                   LIMIT 1
                ) AS latest_actionable_message_id
           FROM messages m
          WHERE m.direction = 'inbound'
            AND (m.list_unsub_url IS NOT NULL OR m.list_unsub_mailto IS NOT NULL)
          GROUP BY m.mailbox_id, LOWER(m.from_addr)`,
      )
      .all<DbRow>();
    for (const r of results ?? []) {
      if (!mailboxIds.has(r.mailbox_id)) continue; // access filter
      const key = `${r.mailbox_id}|${r.from_addr}`;
      const prev = merged.get(key);
      if (!prev) {
        merged.set(key, r);
      } else {
        // Same (mailbox, sender) split across DBs is unusual — would happen
        // only if a thread has been migrated mid-conversation — but merge
        // defensively so the surface stays correct.
        merged.set(key, {
          mailbox_id: r.mailbox_id,
          from_addr: r.from_addr,
          from_name: prev.from_name ?? r.from_name,
          message_count: prev.message_count + r.message_count,
          unsubscribed_count: prev.unsubscribed_count + r.unsubscribed_count,
          last_message_at: Math.max(prev.last_message_at, r.last_message_at),
          // Pick whichever side has the more recent actionable id; tie
          // broken arbitrarily on prev (stable-ish across calls).
          latest_actionable_message_id:
            prev.latest_actionable_message_id ?? r.latest_actionable_message_id,
        });
      }
    }
  }

  const out: SubscriptionRow[] = [];
  for (const r of merged.values()) {
    const meta = mailboxMeta.get(r.mailbox_id);
    if (!meta) continue;
    out.push({
      mailbox_id: r.mailbox_id,
      mailbox_local_part: meta.local_part,
      domain_name: meta.domain_name,
      from_addr: r.from_addr,
      from_name: r.from_name,
      message_count: r.message_count,
      unsubscribed_count: r.unsubscribed_count,
      last_message_at: r.last_message_at,
      latest_actionable_message_id: r.latest_actionable_message_id,
    });
  }
  // Most-recent senders first — typical "manage your subscriptions" sort.
  out.sort((a, b) => b.last_message_at - a.last_message_at);
  return out;
}

// Threads currently assigned to the given user (issue #27). Powers the
// "Assigned to me" sidebar entry + view. Cross-mailbox by design: a single
// user can be a member of multiple shared mailboxes, and the dashboard wants
// "all the threads I owe somebody a response on" regardless of which mailbox
// the work landed in.
//
// Access is implicit: thread_assignments is gated on assignThread checking
// that the assignee is a member of the mailbox, so anything returned here is
// already visible to `userId`. We still join user_mailbox_access defensively
// in case the user has been removed from a mailbox after being assigned a
// thread there — without the join we'd surface threads the user can no
// longer read.
export async function listAssignedToUser(
  userId: string,
  opts: { limit?: number } = {},
): Promise<ThreadListItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const sql = `
    SELECT
      ti.thread_id AS id,
      ti.subject_normalized,
      ti.last_message_at,
      ti.message_count,
      ti.unread_count,
      ti.starred,
      ti.archived,
      ti.muted,
      ti.pinned,
      d.id   AS domain_id,
      d.name AS domain_name,
      mb.id  AS mailbox_id,
      mb.local_part AS mailbox_local_part,
      ti.last_subject   AS last_subject,
      ti.last_from_addr AS last_from_addr,
      ti.last_from_name AS last_from_name,
      ti.last_snippet   AS last_snippet,
      (
        SELECT JSON_GROUP_ARRAY(
                 JSON_OBJECT('id', l.id, 'name', l.name, 'color', l.color)
               )
          FROM (
            SELECT l.id, l.name, l.color
              FROM thread_labels tl
              INNER JOIN labels l ON l.id = tl.label_id
             WHERE tl.thread_id = ti.thread_id
             ORDER BY l.name
          ) AS l
      ) AS labels_json
    FROM thread_assignments ta
    INNER JOIN threads_index ti ON ti.thread_id = ta.thread_id
    INNER JOIN mailboxes mb     ON mb.id = ti.mailbox_id
    INNER JOIN domains d        ON d.id = mb.domain_id
    INNER JOIN user_mailbox_access uma
            ON uma.mailbox_id = ti.mailbox_id AND uma.user_id = ?1
    WHERE ta.assignee_id = ?1
      AND ta.resolved_at IS NULL
      AND ti.archived = 0
    ORDER BY ti.pinned DESC, ta.assigned_at DESC
    LIMIT ?
  `;
  const { results } = await getDb()
    .prepare(sql)
    .bind(userId, limit)
    .all<ThreadListRow>();
  return (results ?? []).map(parseThreadListRow);
}

// Count of threads currently assigned to the given user. Used by the sidebar
// "Assigned to me" badge. Mirrors the listing's filters (non-archived, user
// still has mailbox access) so the badge can't out-of-sync the view.
export async function countAssignedToUser(userId: string): Promise<number> {
  const row = await getDb()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM thread_assignments ta
         INNER JOIN threads_index ti ON ti.thread_id = ta.thread_id
         INNER JOIN user_mailbox_access uma
                 ON uma.mailbox_id = ti.mailbox_id AND uma.user_id = ?1
        WHERE ta.assignee_id = ?1
          AND ta.resolved_at IS NULL
          AND ti.archived = 0`,
    )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// VIP sender list for a user (issue #73). Stored lowercase on insert so this
// is just a direct read — callers compare with the same normalisation.
export async function listVipAddresses(userId: string): Promise<string[]> {
  const { results } = await getDb()
    .prepare("SELECT addr FROM vip_senders WHERE user_id = ? ORDER BY added_at DESC")
    .bind(userId)
    .all<{ addr: string }>();
  return (results ?? []).map(r => r.addr);
}

// Threads where any message's last_from_addr is in the user's VIP list.
// Cross-mailbox by design: VIPs are a per-user concept, not per-mailbox, so
// this view spans every mailbox the user has access to. The thread's
// `last_from_addr` is what the inbox row already shows — matching on that
// keeps the listing consistent with what the user sees in other views.
//
// We currently match on the most recent inbound sender only (via
// threads_index.last_from_addr). A thread where a VIP appeared earlier in the
// chain but isn't the most recent sender won't surface here — acceptable
// trade-off for keeping this an indexed equality lookup.
export async function listVipThreads(
  userId: string,
  opts: { limit?: number } = {},
): Promise<ThreadListItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const sql = `
    SELECT
      ti.thread_id AS id,
      ti.subject_normalized,
      ti.last_message_at,
      ti.message_count,
      ti.unread_count,
      ti.starred,
      ti.archived,
      ti.muted,
      ti.pinned,
      ti.follow_up_enabled,
      ti.follow_up_days,
      ti.follow_up_minutes,
      d.id   AS domain_id,
      d.name AS domain_name,
      mb.id  AS mailbox_id,
      mb.local_part AS mailbox_local_part,
      ti.last_subject   AS last_subject,
      ti.last_from_addr AS last_from_addr,
      ti.last_from_name AS last_from_name,
      ti.last_snippet   AS last_snippet,
      (
        SELECT JSON_GROUP_ARRAY(
                 JSON_OBJECT('id', l.id, 'name', l.name, 'color', l.color)
               )
          FROM (
            SELECT l.id, l.name, l.color
              FROM thread_labels tl
              INNER JOIN labels l ON l.id = tl.label_id
             WHERE tl.thread_id = ti.thread_id
             ORDER BY l.name
          ) AS l
      ) AS labels_json
    FROM threads_index ti
    INNER JOIN mailboxes mb ON mb.id = ti.mailbox_id
    INNER JOIN domains d   ON d.id = mb.domain_id
    INNER JOIN user_mailbox_access uma ON uma.mailbox_id = ti.mailbox_id
    INNER JOIN vip_senders v
            ON v.user_id = uma.user_id
           AND v.addr = LOWER(ti.last_from_addr)
    WHERE uma.user_id = ?
      AND ti.archived = 0
    ORDER BY ti.last_message_at DESC
    LIMIT ?
  `;
  const { results } = await getDb()
    .prepare(sql)
    .bind(userId, limit)
    .all<ThreadListRow>();
  return (results ?? []).map(parseThreadListRow);
}

// Threads the user has starred via the ★ button in the reader toolbar.
// Cross-mailbox by design — the star is a personal-organisation primitive
// (analogous to VIPs), so the view spans every mailbox the user can read.
// Archived threads stay in scope: starring is how users save things they
// want to revisit independently of inbox/archive state.
export async function listStarredThreads(
  userId: string,
  opts: { limit?: number } = {},
): Promise<ThreadListItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const sql = `
    SELECT
      ti.thread_id AS id,
      ti.subject_normalized,
      ti.last_message_at,
      ti.message_count,
      ti.unread_count,
      ti.starred,
      ti.archived,
      ti.muted,
      ti.pinned,
      ti.follow_up_enabled,
      ti.follow_up_days,
      ti.follow_up_minutes,
      d.id   AS domain_id,
      d.name AS domain_name,
      mb.id  AS mailbox_id,
      mb.local_part AS mailbox_local_part,
      ti.last_subject   AS last_subject,
      ti.last_from_addr AS last_from_addr,
      ti.last_from_name AS last_from_name,
      ti.last_snippet   AS last_snippet,
      (
        SELECT JSON_GROUP_ARRAY(
                 JSON_OBJECT('id', l.id, 'name', l.name, 'color', l.color)
               )
          FROM (
            SELECT l.id, l.name, l.color
              FROM thread_labels tl
              INNER JOIN labels l ON l.id = tl.label_id
             WHERE tl.thread_id = ti.thread_id
             ORDER BY l.name
          ) AS l
      ) AS labels_json
    FROM threads_index ti
    INNER JOIN mailboxes mb ON mb.id = ti.mailbox_id
    INNER JOIN domains d   ON d.id = mb.domain_id
    INNER JOIN user_mailbox_access uma ON uma.mailbox_id = ti.mailbox_id
    WHERE uma.user_id = ?
      AND ti.starred = 1
    ORDER BY ti.last_message_at DESC
    LIMIT ?
  `;
  const { results } = await getDb()
    .prepare(sql)
    .bind(userId, limit)
    .all<ThreadListRow>();
  return (results ?? []).map(parseThreadListRow);
}

// Threads where the user has personally hit "Report spam" on at least one
// message. Backs the /inbox/spam scope — the reported messages were already
// archived by the report-spam handler, so this is the only way to find them
// again. spam_reported_by_user_id lives in the mail-plane DBs, so we fan out
// across active mail DBs to collect candidate thread_ids, then resolve them
// back through threads_index in the control DB.
//
// Includes archived threads by design (every reported-spam thread is
// archived — that's the whole point of giving the user a place to review).
export async function listSpamReportedThreads(
  userId: string,
  opts: { limit?: number } = {},
): Promise<ThreadListItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const mailDbs = await getActiveMailDbs();
  const threadIds = new Set<string>();
  for (const { db } of mailDbs) {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT thread_id
           FROM messages
          WHERE spam_reported_by_user_id = ?`,
      )
      .bind(userId)
      .all<{ thread_id: string }>();
    for (const r of results ?? []) threadIds.add(r.thread_id);
  }
  if (threadIds.size === 0) return [];

  const ids = Array.from(threadIds);
  const placeholders = ids.map(() => "?").join(",");
  const sql = `
    SELECT
      ti.thread_id AS id,
      ti.subject_normalized,
      ti.last_message_at,
      ti.message_count,
      ti.unread_count,
      ti.starred,
      ti.archived,
      ti.muted,
      ti.pinned,
      d.id   AS domain_id,
      d.name AS domain_name,
      mb.id  AS mailbox_id,
      mb.local_part AS mailbox_local_part,
      ti.last_subject   AS last_subject,
      ti.last_from_addr AS last_from_addr,
      ti.last_from_name AS last_from_name,
      ti.last_snippet   AS last_snippet,
      (
        SELECT JSON_GROUP_ARRAY(
                 JSON_OBJECT('id', l.id, 'name', l.name, 'color', l.color)
               )
          FROM (
            SELECT l.id, l.name, l.color
              FROM thread_labels tl
              INNER JOIN labels l ON l.id = tl.label_id
             WHERE tl.thread_id = ti.thread_id
             ORDER BY l.name
          ) AS l
      ) AS labels_json
    FROM threads_index ti
    INNER JOIN mailboxes mb ON mb.id = ti.mailbox_id
    INNER JOIN domains d   ON d.id = mb.domain_id
    INNER JOIN user_mailbox_access uma
            ON uma.mailbox_id = ti.mailbox_id AND uma.user_id = ?
    WHERE ti.thread_id IN (${placeholders})
    ORDER BY ti.last_message_at DESC
    LIMIT ?
  `;
  const { results } = await getDb()
    .prepare(sql)
    .bind(userId, ...ids, limit)
    .all<ThreadListRow>();
  return (results ?? []).map(parseThreadListRow);
}

// ─── Follow-up (issue #26) ───────────────────────────────────────────────
//
// "You sent this N days ago and they haven't replied — bump?" Surfaces
// threads where:
//   - follow_up_enabled = 1 (user has opted this thread in)
//   - last_message_at is older than `follow_up_days` (per-thread override)
//     or `defaultDays` (global fallback)
//   - the thread isn't archived or muted (those views are deliberately
//     quiet — nudging them defeats the point)
//   - the most-recent message in the thread is outbound (we're waiting on
//     them, not the other way around)
//
// The first three conditions are decided in SQL against threads_index. The
// last one needs the mail DB: we fan out per-candidate using
// getMailDbForThread and check the most-recent message's direction. The
// candidate set is already filtered by the partial index from migration
// 0034 (only `follow_up_enabled = 1` rows), so this fan-out is bounded by
// "how many threads has the user marked for follow-up" rather than the
// inbox at large. A cached `last_direction` column on threads_index can
// land later if this query gets hot; for v1 the fan-out is fine.
export async function listDueFollowups(
  userId: string,
  // Default cadence in minutes (was days before migration 0051's
  // sub-day support). 4 days = 5760 minutes.
  defaultMinutes = 4 * 1440,
): Promise<ThreadListItem[]> {
  // Cap at 100 so the fan-out below stays bounded even if the user has
  // turned on follow-ups for hundreds of threads. Most-recently-due first
  // (i.e. oldest waiting threads sort to the top so the user attacks the
  // longest-waiting ones first).
  const limit = 100;
  const sql = `
    SELECT
      ti.thread_id AS id,
      ti.subject_normalized,
      ti.last_message_at,
      ti.message_count,
      ti.unread_count,
      ti.starred,
      ti.archived,
      ti.muted,
      ti.pinned,
      ti.follow_up_enabled,
      ti.follow_up_days,
      ti.follow_up_minutes,
      d.id   AS domain_id,
      d.name AS domain_name,
      mb.id  AS mailbox_id,
      mb.local_part AS mailbox_local_part,
      ti.last_subject   AS last_subject,
      ti.last_from_addr AS last_from_addr,
      ti.last_from_name AS last_from_name,
      ti.last_snippet   AS last_snippet,
      (
        SELECT JSON_GROUP_ARRAY(
                 JSON_OBJECT('id', l.id, 'name', l.name, 'color', l.color)
               )
          FROM (
            SELECT l.id, l.name, l.color
              FROM thread_labels tl
              INNER JOIN labels l ON l.id = tl.label_id
             WHERE tl.thread_id = ti.thread_id
             ORDER BY l.name
          ) AS l
      ) AS labels_json
    FROM threads_index ti
    INNER JOIN mailboxes mb ON mb.id = ti.mailbox_id
    INNER JOIN domains d   ON d.id = mb.domain_id
    INNER JOIN user_mailbox_access uma ON uma.mailbox_id = ti.mailbox_id
    WHERE uma.user_id = ?
      AND ti.follow_up_enabled = 1
      AND ti.archived = 0
      AND ti.muted = 0
      AND ti.last_message_at < (
        unixepoch() -
        (COALESCE(ti.follow_up_minutes, ti.follow_up_days * 1440, ?) * 60)
      )
    ORDER BY ti.last_message_at ASC
    LIMIT ?
  `;
  const { results } = await getDb()
    .prepare(sql)
    .bind(userId, defaultMinutes, limit)
    .all<ThreadListRow>();
  const candidates = (results ?? []).map(parseThreadListRow);
  if (candidates.length === 0) return [];

  // Filter to threads whose latest message is outbound. Per-thread fan-out
  // against each mail DB — single round-trip per candidate. We could batch
  // by mail DB id, but the candidate cap above plus the partial index keep
  // this O(opted-in threads), which is small in practice.
  const out: ThreadListItem[] = [];
  for (const t of candidates) {
    const db = await getMailDbForThread(t.id);
    const row = await db
      .prepare(
        `SELECT direction FROM messages
          WHERE thread_id = ?
          ORDER BY date DESC
          LIMIT 1`,
      )
      .bind(t.id)
      .first<{ direction: "inbound" | "outbound" }>();
    if (row?.direction === "outbound") out.push(t);
  }
  return out;
}

// ─── Category tabs (issue #68) ───────────────────────────────────────────
//
// Collect thread IDs that have at least one message in the requested
// category. Fan-out across active mail DBs; merge into a deduped array.
// Primary tab is special-cased because NULL category means "this row was
// ingested before the categorizer landed" and we treat that as Primary.
async function collectThreadIdsForCategory(
  category: MessageCategory,
): Promise<string[]> {
  const dbs = await getActiveMailDbs();
  const seen = new Set<string>();
  // Per-DB cap so a multi-DB deploy doesn't pull a huge list when only the
  // most-recent N matter. The control-DB filter respects ORDER BY anyway,
  // so we just need enough recent IDs to cover the visible page.
  const PER_DB_CAP = 1000;

  for (const { db } of dbs) {
    // GROUP BY + MAX(date) gives us one row per thread with a deterministic
    // sort key for the LIMIT. The control-DB query that consumes these IDs
    // will re-sort by threads_index.last_message_at, so we just need to be
    // sure we keep the most-recent N when we cap.
    let sql: string;
    if (category === "primary") {
      // Treat NULL category as Primary so old rows surface here without a
      // backfill. The OR keeps the index-only path available for the
      // explicit-primary subset; SQLite will OR-merge the two.
      sql = `SELECT thread_id, MAX(date) AS last_date FROM messages
              WHERE direction = 'inbound'
                AND (category IS NULL OR category = 'primary')
              GROUP BY thread_id
              ORDER BY last_date DESC
              LIMIT ${PER_DB_CAP}`;
    } else {
      sql = `SELECT thread_id, MAX(date) AS last_date FROM messages
              WHERE direction = 'inbound'
                AND category = ?
              GROUP BY thread_id
              ORDER BY last_date DESC
              LIMIT ${PER_DB_CAP}`;
    }
    const stmt =
      category === "primary"
        ? db.prepare(sql)
        : db.prepare(sql).bind(category);
    const { results } = await stmt.all<{ thread_id: string; last_date: number }>();
    for (const r of results ?? []) seen.add(r.thread_id);
  }
  return Array.from(seen);
}

// ─── Triage quadrants (issues #3 + #7) ───────────────────────────────────
//
// Collect thread IDs that have at least one inbound message matching the
// requested (is_marketing, is_action_item) pair. Same fan-out shape as the
// category collector — one query per active mail DB, dedup into a Set.
// Old rows pre-#3 default to (0, 0) so they all surface under the Quiet
// lane until the backfill runs.
async function collectThreadIdsForTriage(
  triage: TriageFilter,
): Promise<string[]> {
  const dbs = await getActiveMailDbs();
  const seen = new Set<string>();
  const PER_DB_CAP = 1000;
  const sql = `SELECT thread_id, MAX(date) AS last_date FROM messages
                WHERE direction = 'inbound'
                  AND is_marketing = ?
                  AND is_action_item = ?
                GROUP BY thread_id
                ORDER BY last_date DESC
                LIMIT ${PER_DB_CAP}`;
  for (const { db } of dbs) {
    const { results } = await db
      .prepare(sql)
      .bind(triage.isMarketing, triage.isActionItem)
      .all<{ thread_id: string; last_date: number }>();
    for (const r of results ?? []) seen.add(r.thread_id);
  }
  return Array.from(seen);
}
