import { getDb } from "./db";

export interface DomainRow {
  id: string;
  name: string;
  display_name: string | null;
  role: "admin" | "member" | "reader";
}

export async function listDomainsForUser(userId: string): Promise<DomainRow[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT d.id, d.name, d.display_name, uda.role
         FROM domains d
         INNER JOIN user_domain_access uda ON uda.domain_id = d.id
        WHERE uda.user_id = ?
        ORDER BY d.name`,
    )
    .bind(userId)
    .all<DomainRow>();
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
  last_subject: string | null;
  last_from_addr: string | null;
  last_from_name: string | null;
  last_snippet: string | null;
}

// Threads visible to a user, optionally filtered to one domain. The "last
// message" denormalisation joins on the most recent message via a subquery so
// the thread list can render snippet + sender in one round trip.
export async function listThreads(
  userId: string,
  opts: { domainName?: string; limit?: number } = {},
): Promise<ThreadListItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = ["uda.user_id = ?", "t.archived = 0"];
  const binds: unknown[] = [userId];

  if (opts.domainName) {
    where.push("d.name = ?");
    binds.push(opts.domainName);
  }

  const sql = `
    SELECT
      t.id, t.subject_normalized, t.last_message_at, t.message_count,
      t.unread_count, t.starred, t.archived,
      d.id AS domain_id, d.name AS domain_name,
      mb.id AS mailbox_id,
      m.subject AS last_subject,
      m.from_addr AS last_from_addr,
      m.from_name AS last_from_name,
      m.snippet AS last_snippet
    FROM threads t
    INNER JOIN mailboxes mb ON mb.id = t.mailbox_id
    INNER JOIN domains d ON d.id = mb.domain_id
    INNER JOIN user_domain_access uda ON uda.domain_id = d.id
    LEFT JOIN messages m ON m.id = (
      SELECT id FROM messages WHERE thread_id = t.id ORDER BY date DESC LIMIT 1
    )
    WHERE ${where.join(" AND ")}
    ORDER BY t.last_message_at DESC
    LIMIT ?
  `;
  binds.push(limit);

  const { results } = await getDb().prepare(sql).bind(...binds).all<ThreadListItem>();
  return results ?? [];
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
    mailbox_local_part: string;
  };
  messages: ThreadMessage[];
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
  read: number;
  starred: number;
}

export async function getThreadDetail(userId: string, threadId: string): Promise<ThreadDetail | null> {
  const head = await getDb()
    .prepare(
      `SELECT t.id, t.subject_normalized, t.last_message_at, t.message_count,
              t.unread_count, t.starred, t.archived,
              d.name AS domain_name, mb.local_part AS mailbox_local_part
         FROM threads t
         INNER JOIN mailboxes mb ON mb.id = t.mailbox_id
         INNER JOIN domains d ON d.id = mb.domain_id
         INNER JOIN user_domain_access uda ON uda.domain_id = d.id
        WHERE t.id = ? AND uda.user_id = ?`,
    )
    .bind(threadId, userId)
    .first<ThreadDetail["thread"]>();
  if (!head) return null;

  const { results } = await getDb()
    .prepare(
      `SELECT id, message_id_header, direction, from_addr, from_name, to_json, cc_json,
              subject, date, snippet, text_body, read, starred
         FROM messages
        WHERE thread_id = ?
        ORDER BY date ASC`,
    )
    .bind(threadId)
    .all<ThreadMessage>();

  return { thread: head, messages: results ?? [] };
}
