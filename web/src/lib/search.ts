import { getDb } from "./db";
import { getActiveMailDbs } from "./mail-db";

export interface SearchResult {
  // Thread fields — enough to render a result row that links to the thread.
  thread_id: string;
  subject_normalized: string;
  last_message_at: number;
  mailbox_id: string;
  mailbox_local_part: string;
  domain_name: string;
  // The specific message whose text matched.
  message_id: string;
  message_subject: string | null;
  from_addr: string;
  from_name: string | null;
  // FTS5 snippet() output. Contains plain text from subject/snippet/text_body
  // with `<mark>...</mark>` markers around the matched terms — and nothing
  // else. See sanitiseQuery() / the SQL below for why this is XSS-safe to
  // dangerouslySetInnerHTML.
  match_snippet: string;
}

/**
 * Sanitise a user-supplied query string for FTS5 MATCH.
 *
 * FTS5 query syntax interprets `"`, `*`, `(`, `)`, `:` and bare keywords
 * AND/OR/NOT/NEAR specially. Letting raw user input through can throw a
 * "fts5: syntax error" SQL error or, worse, behave surprisingly.
 *
 * Strategy:
 *  1. If the query is "boring" (only word chars, digits, spaces and a few
 *     safe punctuation marks like `-`/`_`/`.`/`@`), pass it through. FTS5
 *     treats space-separated bare words as implicit AND, which is what
 *     a typical search box user expects.
 *  2. Otherwise, split on whitespace, drop empty pieces, escape any embedded
 *     `"` by doubling it, and wrap each token in double quotes. FTS5 phrase
 *     syntax (`"..."`) treats the contents as a literal token, neutralising
 *     all special characters. Joining the quoted phrases with a space again
 *     gives an implicit AND across them.
 *
 * This deliberately drops FTS5's power-user features (boolean operators,
 * column filters, prefix `*`, NEAR) — the search bar is for end users, not
 * SQL admins. If we want operator support later, we'll add it as a separate
 * "advanced" mode rather than trying to detect intent.
 */
function sanitiseQuery(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const SAFE_RE = /^[\p{L}\p{N}\s\-_.@]+$/u;
  if (SAFE_RE.test(trimmed)) {
    return trimmed;
  }

  const tokens = trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map(t => `"${t.replace(/"/g, '""')}"`);
  if (tokens.length === 0) return null;
  return tokens.join(" ");
}

interface MailDbHit {
  message_id: string;
  thread_id: string;
  mailbox_id: string;
  from_addr: string;
  from_name: string | null;
  message_subject: string | null;
  message_date: number;
  match_snippet: string;
}

// Fan-out search across every active mail DB. Each DB runs its own FTS
// query (snippet() restricted to a sub-select against messages_fts only —
// see comment in searchOneDb for the FTS5 "must-be-outermost" gotcha).
//
// Visibility is enforced *after* the fan-out via a single control-DB query
// that joins user_mailbox_access — D1 has no cross-DB joins, so we can't
// JOIN that into the FTS query directly. Same for thread metadata
// (subject_normalized, last_message_at) which now lives on threads_index
// in the control DB.
//
// For single-DB deploys this is one parallel call to one DB plus two small
// control-DB lookups — same cost as the old single-query path, give or take.
export async function searchThreads(
  userId: string,
  query: string,
  opts: { limit?: number; mailboxId?: string } = {},
): Promise<SearchResult[]> {
  const match = sanitiseQuery(query);
  if (!match) return [];

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const mailDbs = await getActiveMailDbs();

  // Per-DB FTS query. Pull `limit * 4` from each so per-thread dedup +
  // visibility filtering still leaves enough rows.
  const perDbLimit = limit * 4;
  const hitsPerDb = await Promise.all(
    mailDbs.map(({ db }) => searchOneDb(db, match, perDbLimit, opts.mailboxId)),
  );

  // Merge + sort by message_date desc.
  const allHits = hitsPerDb.flat().sort((a, b) => b.message_date - a.message_date);
  if (allHits.length === 0) return [];

  // Resolve mailbox + domain labels and visibility from control DB. One
  // query, keyed by the mailbox_ids that came back from the fan-out, gates
  // visibility (only return hits on mailboxes the user can read) and gives
  // us mailbox_local_part / domain_name without per-row lookups.
  const mailboxIds = Array.from(new Set(allHits.map(h => h.mailbox_id)));
  const mbPlaceholders = mailboxIds.map(() => "?").join(",");
  const { results: mbRows } = await getDb()
    .prepare(
      `SELECT mb.id, mb.local_part, d.name AS domain_name
         FROM mailboxes mb
         INNER JOIN domains d ON d.id = mb.domain_id
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = mb.id
        WHERE uma.user_id = ?
          AND mb.id IN (${mbPlaceholders})`,
    )
    .bind(userId, ...mailboxIds)
    .all<{ id: string; local_part: string; domain_name: string }>();
  const mailboxMap = new Map((mbRows ?? []).map(m => [m.id, m]));

  // Thread metadata from threads_index (control DB).
  const threadIds = Array.from(new Set(allHits.map(h => h.thread_id)));
  const tiPlaceholders = threadIds.map(() => "?").join(",");
  const { results: tiRows } = await getDb()
    .prepare(
      `SELECT thread_id, subject_normalized, last_message_at
         FROM threads_index
        WHERE thread_id IN (${tiPlaceholders})`,
    )
    .bind(...threadIds)
    .all<{ thread_id: string; subject_normalized: string; last_message_at: number }>();
  const tiMap = new Map((tiRows ?? []).map(t => [t.thread_id, t]));

  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const h of allHits) {
    if (seen.has(h.thread_id)) continue;
    const mb = mailboxMap.get(h.mailbox_id);
    if (!mb) continue; // mailbox not accessible to this user — drop the hit
    const ti = tiMap.get(h.thread_id);
    if (!ti) continue; // orphan hit (thread_index missing) — skip
    seen.add(h.thread_id);
    out.push({
      thread_id: h.thread_id,
      subject_normalized: ti.subject_normalized,
      last_message_at: ti.last_message_at,
      mailbox_id: h.mailbox_id,
      mailbox_local_part: mb.local_part,
      domain_name: mb.domain_name,
      message_id: h.message_id,
      message_subject: h.message_subject,
      from_addr: h.from_addr,
      from_name: h.from_name,
      match_snippet: h.match_snippet,
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function searchOneDb(
  db: D1Database,
  match: string,
  limit: number,
  mailboxId: string | undefined,
): Promise<MailDbHit[]> {
  // FTS5 auxiliary functions like snippet() require messages_fts to be the
  // outermost source in the SELECT they live in. We keep the FTS query in a
  // standalone subquery (only source = messages_fts) and join messages
  // outside — this is the only structure that doesn't trip
  // "D1_ERROR: unable to use function snippet in the requested context".
  const mailboxFilter = mailboxId ? "AND m.mailbox_id = ?3" : "";
  const sql = `
    SELECT
      m.id          AS message_id,
      m.thread_id   AS thread_id,
      m.mailbox_id  AS mailbox_id,
      m.from_addr   AS from_addr,
      m.from_name   AS from_name,
      m.subject     AS message_subject,
      m.date        AS message_date,
      hit.match_snippet
    FROM (
      SELECT rowid,
             snippet(messages_fts, -1, '<mark>', '</mark>', '…', 12) AS match_snippet
        FROM messages_fts
       WHERE messages_fts MATCH ?1
    ) AS hit
    INNER JOIN messages m ON m.rowid = hit.rowid
    WHERE 1=1 ${mailboxFilter}
    ORDER BY m.date DESC
    LIMIT ?2
  `;
  const stmt = mailboxId
    ? db.prepare(sql).bind(match, limit, mailboxId)
    : db.prepare(sql).bind(match, limit);
  try {
    const { results } = await stmt.all<MailDbHit>();
    return results ?? [];
  } catch (e) {
    // One DB hiccup shouldn't kill the whole search. Log and skip — the
    // user gets results from the other active DBs.
    console.error("search fan-out: per-DB query failed", e);
    return [];
  }
}
