import { getDb } from "./db";

export interface DomainRow {
  id: string;
  name: string;
  display_name: string | null;
  is_admin: number;
}

// Domains the user can see at all — they have access to at least one mailbox
// on the domain, OR they're a domain admin (so they can administer it even
// before granting themselves any mailbox access).
export async function listDomainsForUser(userId: string): Promise<DomainRow[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT d.id, d.name, d.display_name,
              CASE WHEN MAX(CASE WHEN uda.role = 'admin' THEN 1 ELSE 0 END) = 1 THEN 1 ELSE 0 END AS is_admin
         FROM domains d
         LEFT JOIN user_domain_access uda
           ON uda.domain_id = d.id AND uda.user_id = ?1
         LEFT JOIN mailboxes mb ON mb.domain_id = d.id
         LEFT JOIN user_mailbox_access uma
           ON uma.mailbox_id = mb.id AND uma.user_id = ?1
        WHERE uda.user_id IS NOT NULL OR uma.user_id IS NOT NULL
        GROUP BY d.id, d.name, d.display_name
        ORDER BY d.name`,
    )
    .bind(userId)
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
    "t.archived = 0",
    "(t.snoozed_until IS NULL OR t.snoozed_until <= unixepoch())",
  ];
  const binds: unknown[] = [userId];

  if (opts.mailboxId) {
    where.push("t.mailbox_id = ?");
    binds.push(opts.mailboxId);
  }

  // Labels per thread come from a correlated subquery that aggregates the
  // distinct labels attached to any message in the thread. Using a
  // correlated subquery (vs. a LEFT JOIN + GROUP BY) keeps the rest of the
  // shape unchanged and dodges duplicating the aggregate columns.
  const sql = `
    SELECT
      t.id, t.subject_normalized, t.last_message_at, t.message_count,
      t.unread_count, t.starred, t.archived,
      d.id AS domain_id, d.name AS domain_name,
      mb.id AS mailbox_id, mb.local_part AS mailbox_local_part,
      m.subject AS last_subject,
      m.from_addr AS last_from_addr,
      m.from_name AS last_from_name,
      m.snippet AS last_snippet,
      (
        SELECT JSON_GROUP_ARRAY(
                 JSON_OBJECT('id', tl.id, 'name', tl.name, 'color', tl.color)
               )
          FROM (
            SELECT DISTINCT l.id AS id, l.name AS name, l.color AS color
              FROM labels l
              INNER JOIN message_labels ml ON ml.label_id = l.id
              INNER JOIN messages mm ON mm.id = ml.message_id
             WHERE mm.thread_id = t.id
             ORDER BY l.name
          ) AS tl
      ) AS labels_json
    FROM threads t
    INNER JOIN mailboxes mb ON mb.id = t.mailbox_id
    INNER JOIN domains d ON d.id = mb.domain_id
    INNER JOIN user_mailbox_access uma ON uma.mailbox_id = t.mailbox_id
    LEFT JOIN messages m ON m.id = (
      SELECT id FROM messages WHERE thread_id = t.id ORDER BY date DESC LIMIT 1
    )
    WHERE ${where.join(" AND ")}
    ORDER BY t.last_message_at DESC
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

export async function getThreadDetail(userId: string, threadId: string): Promise<ThreadDetail | null> {
  const head = await getDb()
    .prepare(
      `SELECT t.id, t.subject_normalized, t.last_message_at, t.message_count,
              t.unread_count, t.starred, t.archived, t.snoozed_until,
              d.name AS domain_name, mb.id AS mailbox_id, mb.local_part AS mailbox_local_part,
              uma.role AS user_role
         FROM threads t
         INNER JOIN mailboxes mb ON mb.id = t.mailbox_id
         INNER JOIN domains d ON d.id = mb.domain_id
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = t.mailbox_id
        WHERE t.id = ? AND uma.user_id = ?`,
    )
    .bind(threadId, userId)
    .first<ThreadDetail["thread"]>();
  if (!head) return null;

  // Wire format from D1 — attachments load separately and get bucketed in.
  type MessageRow = Omit<ThreadMessage, "attachments">;

  const { results } = await getDb()
    .prepare(
      `SELECT m.id, m.message_id_header, m.direction, m.from_addr, m.from_name,
              m.to_json, m.cc_json, m.subject, m.date, m.snippet, m.text_body,
              m.html_r2_key, m.read, m.starred,
              u.email AS sent_by_email, u.display_name AS sent_by_display_name
         FROM messages m
         LEFT JOIN users u ON u.id = m.sent_by_user_id
        WHERE m.thread_id = ?
        ORDER BY m.date ASC`,
    )
    .bind(threadId)
    .all<MessageRow>();

  const messageRows = results ?? [];

  // One round-trip for all attachments in the thread; bucket by message_id.
  // Avoids an N+1 across messages without joining/duplicating message columns.
  const { results: attachmentRows } = await getDb()
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

  const messages: ThreadMessage[] = messageRows.map(m => ({
    ...m,
    attachments: attachmentsByMessage.get(m.id) ?? [],
  }));

  return { thread: head, messages };
}
