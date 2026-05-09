import { getDb } from "./db";
import { getMailDbForThread } from "./mail-db";

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
}

// Mailboxes the user can read from. The sidebar groups these under domain
// headers. `is_shared` is just `member_count > 1`, surfaced for the UI badge.
export async function listMailboxesForUser(userId: string): Promise<MailboxRow[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT mb.id, mb.domain_id, d.name AS domain_name, mb.local_part,
              mb.display_name, mb.is_catch_all, uma.role,
              (SELECT COUNT(*) FROM user_mailbox_access WHERE mailbox_id = mb.id) AS member_count,
              CASE WHEN (SELECT COUNT(*) FROM user_mailbox_access WHERE mailbox_id = mb.id) > 1
                   THEN 1 ELSE 0 END AS is_shared
         FROM mailboxes mb
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = mb.id
         INNER JOIN domains d ON d.id = mb.domain_id
        WHERE uma.user_id = ?
        ORDER BY d.name, mb.local_part`,
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
export async function listThreads(
  userId: string,
  opts: { mailboxId?: string; limit?: number } = {},
): Promise<ThreadListItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  // Hide threads that are still in a future-snooze. The cron clears
  // snoozed_until once it elapses, but if the cron is briefly behind we still
  // don't want to show those rows — hence the explicit `> unixepoch()` check.
  const where = [
    "uma.user_id = ?",
    "ti.archived = 0",
    "(ti.snoozed_until IS NULL OR ti.snoozed_until <= unixepoch())",
  ];
  const binds: unknown[] = [userId];

  if (opts.mailboxId) {
    where.push("ti.mailbox_id = ?");
    binds.push(opts.mailboxId);
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
    ORDER BY ti.last_message_at DESC
    LIMIT ?
  `;
  binds.push(limit);

  const { results } = await getDb().prepare(sql).bind(...binds).all<ThreadListRow>();
  return (results ?? []).map(parseThreadListRow);
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
    domain_name: string;
    mailbox_id: string;
    mailbox_local_part: string;
    // Caller's role on the thread's mailbox — drives "can the Reply button
    // appear" and similar gates in the reader UI.
    user_role: "owner" | "member" | "reader";
    snoozed_until: number | null;
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
  attachments: AttachmentRow[];
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
              ti.snoozed_until,
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
  type RawMessageRow = Omit<ThreadMessage, "attachments" | "sent_by_email" | "sent_by_display_name"> & {
    sent_by_user_id: string | null;
  };

  const { results } = await mailDb
    .prepare(
      `SELECT m.id, m.message_id_header, m.direction, m.from_addr, m.from_name,
              m.to_json, m.cc_json, m.subject, m.date, m.snippet, m.text_body,
              m.html_r2_key, m.read, m.starred, m.sent_by_user_id
         FROM messages m
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
      `SELECT a.id, a.message_id, a.filename, a.content_type, a.size, a.inline_cid
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

  const messages: ThreadMessage[] = messageRows.map(m => {
    const sender = m.sent_by_user_id ? senderMap.get(m.sent_by_user_id) ?? null : null;
    const { sent_by_user_id: _drop, ...rest } = m;
    void _drop;
    return {
      ...rest,
      sent_by_email: sender?.email ?? null,
      sent_by_display_name: sender?.display_name ?? null,
      attachments: attachmentsByMessage.get(m.id) ?? [],
    };
  });

  return { thread: head, messages };
}
