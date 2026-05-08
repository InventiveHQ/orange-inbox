import { getDb } from "./db";

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

  // Conservative "safe" character set. Lower-case and upper-case letters,
  // digits, whitespace, and a handful of punctuation that's harmless inside
  // a bare FTS5 query.
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

interface Row {
  thread_id: string;
  subject_normalized: string;
  last_message_at: number;
  mailbox_id: string;
  mailbox_local_part: string;
  domain_name: string;
  message_id: string;
  message_subject: string | null;
  from_addr: string;
  from_name: string | null;
  match_snippet: string;
}

export async function searchThreads(
  userId: string,
  query: string,
  opts: { limit?: number } = {},
): Promise<SearchResult[]> {
  const match = sanitiseQuery(query);
  if (!match) return [];

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  // FTS5 auxiliary functions like snippet() require messages_fts to be the
  // *outermost* table reference in the SELECT they live in. Wrapping the FTS
  // query in a CTE and then joining/aggregating from it triggers
  // "D1_ERROR: unable to use function snippet in the requested context".
  // So we keep snippet() in an inner subquery whose only source is
  // messages_fts, then join everything else outside.
  //
  // Per-thread dedup (one row per thread, latest match wins) is done in JS
  // after the fact — keeps the SQL FTS5-clean and avoids GROUP BY across the
  // join.
  //
  // snippet() args:
  //   index column = -1  (search all indexed columns)
  //   start/end   = <mark>...</mark>  (we control these literals; no other
  //                                    HTML appears in snippet's output, so
  //                                    dangerouslySetInnerHTML is safe)
  //   ellipsis    = …
  //   tokens      = 12
  const sql = `
    SELECT
      m.id          AS message_id,
      m.thread_id   AS thread_id,
      m.from_addr   AS from_addr,
      m.from_name   AS from_name,
      m.subject     AS message_subject,
      m.date        AS message_date,
      hit.match_snippet,
      t.subject_normalized,
      t.last_message_at,
      mb.id          AS mailbox_id,
      mb.local_part  AS mailbox_local_part,
      d.name         AS domain_name
    FROM (
      SELECT rowid,
             snippet(messages_fts, -1, '<mark>', '</mark>', '…', 12) AS match_snippet
        FROM messages_fts
       WHERE messages_fts MATCH ?2
    ) AS hit
    INNER JOIN messages m          ON m.rowid = hit.rowid
    INNER JOIN threads t           ON t.id = m.thread_id
    INNER JOIN mailboxes mb        ON mb.id = t.mailbox_id
    INNER JOIN domains d           ON d.id = mb.domain_id
    INNER JOIN user_mailbox_access uma
            ON uma.mailbox_id = t.mailbox_id AND uma.user_id = ?1
    ORDER BY m.date DESC
    LIMIT ?3
  `;

  const { results } = await getDb()
    .prepare(sql)
    .bind(userId, match, limit * 4) // pull a few extra so per-thread dedup still leaves `limit` rows
    .all<Row & { message_date: number }>();
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results ?? []) {
    if (seen.has(r.thread_id)) continue;
    seen.add(r.thread_id);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}
