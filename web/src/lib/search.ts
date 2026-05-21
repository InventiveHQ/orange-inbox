import { getDb } from "./db";
import { getActiveMailDbs } from "./mail-db";

// Sentinel markers wrapped around matched terms in FTS5 snippet() output.
//
// FTS5 snippet() returns the RAW indexed column text and inserts these marker
// strings verbatim — it performs NO HTML escaping. Using `<mark>`/`</mark>` as
// markers would therefore mean attacker-controlled email text (a subject or
// body containing `<img src=x onerror=...>`) lands in an HTML string that, if
// rendered with dangerouslySetInnerHTML, executes script in our origin.
//
// To make that class of bug impossible we use ASCII control characters that
// (a) cannot legitimately appear in real subject/body text and (b) have no
// meaning in HTML. The snippet string is then split on these sentinels and
// rendered as auto-escaped React text + real <mark> elements — never as HTML.
// U+0001 (Start of Heading) / U+0002 (Start of Text) are unused, non-printing
// control codes.
export const SNIPPET_MARK_START = "";
export const SNIPPET_MARK_END = "";

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
  // FTS5 snippet() output. Contains RAW, attacker-controlled text from the
  // indexed columns (subject/snippet/text_body — all stored verbatim from
  // inbound email). snippet() does NOT HTML-escape its input, so this string
  // MUST NEVER be treated as HTML / passed to dangerouslySetInnerHTML.
  //
  // Matched terms are wrapped with the non-HTML sentinel control characters
  // SNIPPET_MARK_START / SNIPPET_MARK_END (see below) — never with `<mark>`
  // tags. Consumers split on those sentinels and render the highlighted
  // segments as real, auto-escaped React <mark> elements. See
  // renderSnippet() in web/src/app/search/page.tsx.
  match_snippet: string;
}

// ─── Operator parser ────────────────────────────────────────────────────────
// Splits a raw search box query like `from:alice has:attachment quarterly`
// into structured filters plus the freeText that goes through FTS5.

export interface ParsedSearch {
  freeText: string;
  filters: SearchFilters;
}

export interface SearchFilters {
  from?: string[];
  to?: string[];
  subject?: string[];
  hasAttachment?: boolean;
  isUnread?: boolean;
  isStarred?: boolean;
  // Unix-seconds bounds. `before` is exclusive upper, `after` is inclusive lower.
  beforeTs?: number;
  afterTs?: number;
  // Raw mailbox tokens (local_part or local_part@domain). Resolved to
  // mailbox_ids in searchThreads against the caller's accessible mailboxes.
  mailbox?: string[];
}

// Recognised operator keys. Anything else stays in freeText so a stray colon
// (e.g. "URL: https://...") doesn't accidentally become a filter.
const OPERATOR_KEYS = new Set([
  "from",
  "to",
  "subject",
  "has",
  "is",
  "before",
  "after",
  "mailbox",
]);

// Tokeniser that respects double-quoted phrases so `from:"Long Name"` keeps
// its space. Returns the raw token strings (no dequoting).
function tokeniseQuery(raw: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    let token = "";
    let inQuote = false;
    while (i < raw.length) {
      const c = raw[i];
      if (c === '"') {
        inQuote = !inQuote;
        token += c;
        i++;
        continue;
      }
      if (!inQuote && /\s/.test(c)) break;
      token += c;
      i++;
    }
    if (token) out.push(token);
  }
  return out;
}

// Strip surrounding quotes and unescape doubled `""`. Used after we've split
// `key:value` apart so a value like `"Long Name"` becomes `Long Name`.
function dequote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/""/g, '"');
  }
  return s;
}

// Treat a YYYY-MM-DD value as midnight UTC. We deliberately avoid the local
// timezone so two users searching `before:2024-01-01` see the same cutoff.
function parseYmdToUnix(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [, y, mo, d] = m;
  const ts = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  if (Number.isNaN(ts)) return null;
  return Math.floor(ts / 1000);
}

export function parseSearchQuery(raw: string): ParsedSearch {
  const filters: SearchFilters = {};
  const freeParts: string[] = [];
  const tokens = tokeniseQuery(raw);

  for (const tok of tokens) {
    // Only split on the FIRST colon — values can contain colons (URLs etc).
    const colon = tok.indexOf(":");
    if (colon <= 0) {
      freeParts.push(tok);
      continue;
    }
    const key = tok.slice(0, colon).toLowerCase();
    const rawValue = tok.slice(colon + 1);
    if (!OPERATOR_KEYS.has(key) || rawValue === "") {
      freeParts.push(tok);
      continue;
    }
    const value = dequote(rawValue).trim();
    if (!value) {
      freeParts.push(tok);
      continue;
    }

    switch (key) {
      case "from":
        (filters.from ??= []).push(value);
        break;
      case "to":
        (filters.to ??= []).push(value);
        break;
      case "subject":
        (filters.subject ??= []).push(value);
        break;
      case "has":
        if (value.toLowerCase() === "attachment" || value.toLowerCase() === "attachments") {
          filters.hasAttachment = true;
        } else {
          freeParts.push(tok);
        }
        break;
      case "is": {
        const v = value.toLowerCase();
        if (v === "unread") filters.isUnread = true;
        else if (v === "starred") filters.isStarred = true;
        else freeParts.push(tok);
        break;
      }
      case "before": {
        const ts = parseYmdToUnix(value);
        if (ts !== null) filters.beforeTs = ts;
        else freeParts.push(tok);
        break;
      }
      case "after": {
        const ts = parseYmdToUnix(value);
        if (ts !== null) filters.afterTs = ts;
        else freeParts.push(tok);
        break;
      }
      case "mailbox":
        (filters.mailbox ??= []).push(value);
        break;
    }
  }

  return { freeText: freeParts.join(" "), filters };
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
 * SQL admins. Structured operators (from:, is:, etc.) are handled separately
 * by parseSearchQuery; this function only sees the residual freeText.
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
//
// Operator filters split by the same DB boundary:
//   - mail-DB-side: from/to/subject/has:attachment/before/after — applied
//     inside searchOneDb so they shrink the per-DB result set.
//   - control-DB-side: is:unread/starred and mailbox: — applied here
//     after the fan-out, since threads_index lives in the control DB.
export async function searchThreads(
  userId: string,
  query: string,
  opts: { limit?: number; mailboxId?: string } = {},
): Promise<SearchResult[]> {
  const { freeText, filters } = parseSearchQuery(query);
  // Empty MATCH is invalid in FTS5, so operator-only queries take a
  // different path that skips messages_fts entirely.
  const match = sanitiseQuery(freeText);
  if (!match && !hasAnyFilter(filters)) return [];

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const mailDbs = await getActiveMailDbs();

  // Resolve `mailbox:` tokens to concrete mailbox_ids the user can read.
  // Done up-front so the per-DB fan-out can filter on m.mailbox_id directly,
  // and so an unknown mailbox: token short-circuits to zero results rather
  // than silently widening the search.
  const accessible = await loadAccessibleMailboxes(userId);
  let mailboxIdFilter: string[] | undefined;
  if (filters.mailbox?.length) {
    const resolved = resolveMailboxTokens(filters.mailbox, accessible);
    if (resolved.length === 0) return [];
    mailboxIdFilter = resolved;
  }
  // The legacy `scope` dropdown still wins — it's an explicit user choice and
  // narrows further than a free-text mailbox: token.
  if (opts.mailboxId) {
    if (mailboxIdFilter && !mailboxIdFilter.includes(opts.mailboxId)) return [];
    mailboxIdFilter = [opts.mailboxId];
  }

  // Per-DB query. Pull `limit * 4` from each so per-thread dedup +
  // visibility filtering still leaves enough rows.
  const perDbLimit = limit * 4;
  const hitsPerDb = await Promise.all(
    mailDbs.map(({ db }) =>
      searchOneDb(db, match, perDbLimit, mailboxIdFilter, filters),
    ),
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

  // Thread metadata from threads_index (control DB). For is:* filters we
  // pull the columns we need to filter on alongside the display fields.
  const threadIds = Array.from(new Set(allHits.map(h => h.thread_id)));
  const tiPlaceholders = threadIds.map(() => "?").join(",");
  const { results: tiRows } = await getDb()
    .prepare(
      `SELECT thread_id, subject_normalized, last_message_at,
              unread_count, starred
         FROM threads_index
        WHERE thread_id IN (${tiPlaceholders})`,
    )
    .bind(...threadIds)
    .all<{
      thread_id: string;
      subject_normalized: string;
      last_message_at: number;
      unread_count: number;
      starred: number;
    }>();
  const tiMap = new Map((tiRows ?? []).map(t => [t.thread_id, t]));

  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const h of allHits) {
    if (seen.has(h.thread_id)) continue;
    const mb = mailboxMap.get(h.mailbox_id);
    if (!mb) continue; // mailbox not accessible to this user — drop the hit
    const ti = tiMap.get(h.thread_id);
    if (!ti) continue; // orphan hit (thread_index missing) — skip

    // Control-DB-only filters. Cheaper to apply here than to denormalise
    // these onto every message row.
    if (filters.isUnread && ti.unread_count <= 0) continue;
    if (filters.isStarred && !ti.starred) continue;

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

function hasAnyFilter(f: SearchFilters): boolean {
  return Boolean(
    f.from?.length ||
      f.to?.length ||
      f.subject?.length ||
      f.hasAttachment ||
      f.isUnread ||
      f.isStarred ||
      f.beforeTs ||
      f.afterTs ||
      f.mailbox?.length,
  );
}

interface MailboxLookup {
  id: string;
  local_part: string;
  domain_name: string;
}

async function loadAccessibleMailboxes(userId: string): Promise<MailboxLookup[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT mb.id, mb.local_part, d.name AS domain_name
         FROM mailboxes mb
         INNER JOIN domains d ON d.id = mb.domain_id
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = mb.id
        WHERE uma.user_id = ?`,
    )
    .bind(userId)
    .all<MailboxLookup>();
  return results ?? [];
}

// `mailbox:hello` matches every accessible mailbox with local_part="hello"
// across every domain. `mailbox:hello@example.com` matches only that exact
// address. Comparison is case-insensitive — addresses are case-insensitive
// in practice and our schema stores them lowercased.
function resolveMailboxTokens(tokens: string[], accessible: MailboxLookup[]): string[] {
  const ids = new Set<string>();
  for (const tok of tokens) {
    const lc = tok.toLowerCase();
    if (lc.includes("@")) {
      const [lp, dom] = lc.split("@", 2);
      for (const mb of accessible) {
        if (mb.local_part.toLowerCase() === lp && mb.domain_name.toLowerCase() === dom) {
          ids.add(mb.id);
        }
      }
    } else {
      for (const mb of accessible) {
        if (mb.local_part.toLowerCase() === lc) ids.add(mb.id);
      }
    }
  }
  return Array.from(ids);
}

async function searchOneDb(
  db: D1Database,
  match: string | null,
  limit: number,
  mailboxIds: string[] | undefined,
  filters: SearchFilters,
): Promise<MailDbHit[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  // Mailbox scoping. IN (?,?,...) keeps us inside the parameteriser even
  // when the list has 50+ entries.
  if (mailboxIds && mailboxIds.length > 0) {
    const placeholders = mailboxIds.map(() => "?").join(",");
    where.push(`m.mailbox_id IN (${placeholders})`);
    params.push(...mailboxIds);
  }

  // String operators. LIKE with %-wraps does substring matching, which is
  // what users expect from `from:alice` (matches alice@*, *Alice* in name).
  // We escape `%`/`_`/`\` so a value like `from:50%off` doesn't turn into a
  // wildcard match.
  for (const v of filters.from ?? []) {
    where.push(
      `(LOWER(m.from_addr) LIKE ? ESCAPE '\\' OR LOWER(IFNULL(m.from_name,'')) LIKE ? ESCAPE '\\')`,
    );
    const pat = `%${escapeLike(v.toLowerCase())}%`;
    params.push(pat, pat);
  }
  for (const v of filters.to ?? []) {
    // to_json/cc_json are JSON arrays of {addr,name}. A LIKE on the raw text
    // is good enough for the search box and avoids JSON1 functions which
    // aren't guaranteed in every D1 build.
    where.push(
      `(LOWER(m.to_json) LIKE ? ESCAPE '\\' OR LOWER(IFNULL(m.cc_json,'')) LIKE ? ESCAPE '\\')`,
    );
    const pat = `%${escapeLike(v.toLowerCase())}%`;
    params.push(pat, pat);
  }
  for (const v of filters.subject ?? []) {
    where.push(`LOWER(IFNULL(m.subject,'')) LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(v.toLowerCase())}%`);
  }
  if (filters.hasAttachment) {
    where.push(`EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)`);
  }
  if (filters.beforeTs !== undefined) {
    where.push(`m.date < ?`);
    params.push(filters.beforeTs);
  }
  if (filters.afterTs !== undefined) {
    where.push(`m.date >= ?`);
    params.push(filters.afterTs);
  }

  if (match) {
    return runFtsQuery(db, match, where, params, limit);
  }
  return runFilterOnlyQuery(db, where, params, limit);
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, c => `\\${c}`);
}

async function runFtsQuery(
  db: D1Database,
  match: string,
  extraWhere: string[],
  extraParams: unknown[],
  limit: number,
): Promise<MailDbHit[]> {
  // FTS5 auxiliary functions like snippet() require messages_fts to be the
  // outermost source in the SELECT they live in. We keep the FTS query in a
  // standalone subquery (only source = messages_fts) and join messages
  // outside — this is the only structure that doesn't trip
  // "D1_ERROR: unable to use function snippet in the requested context".
  //
  // The snippet() start/end markers are non-HTML sentinel control characters
  // (SNIPPET_MARK_START / SNIPPET_MARK_END), NOT `<mark>` tags. snippet()
  // does not HTML-escape the raw indexed text, so emitting HTML tags here
  // would make the column unsafe to render. The sentinels are inert in HTML
  // and are converted to real React <mark> elements by renderSnippet() at the
  // render site. They are bound as a SQL parameter (not interpolated) so the
  // characters reach SQLite literally.
  const whereSql = extraWhere.length > 0 ? `AND ${extraWhere.join(" AND ")}` : "";
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
             snippet(messages_fts, -1, ?, ?, '…', 12) AS match_snippet
        FROM messages_fts
       WHERE messages_fts MATCH ?
    ) AS hit
    INNER JOIN messages m ON m.rowid = hit.rowid
    WHERE 1=1 ${whereSql}
    ORDER BY m.date DESC
    LIMIT ?
  `;
  const stmt = db
    .prepare(sql)
    .bind(SNIPPET_MARK_START, SNIPPET_MARK_END, match, ...extraParams, limit);
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

async function runFilterOnlyQuery(
  db: D1Database,
  extraWhere: string[],
  extraParams: unknown[],
  limit: number,
): Promise<MailDbHit[]> {
  // Operator-only path: no MATCH, no snippet — synthesise an empty snippet
  // so the result row still renders. Pulling latest message per thread is
  // good enough for "what's new in this filter" without a window function.
  const whereSql = extraWhere.length > 0 ? `WHERE ${extraWhere.join(" AND ")}` : "";
  const sql = `
    SELECT
      m.id          AS message_id,
      m.thread_id   AS thread_id,
      m.mailbox_id  AS mailbox_id,
      m.from_addr   AS from_addr,
      m.from_name   AS from_name,
      m.subject     AS message_subject,
      m.date        AS message_date,
      ''            AS match_snippet
    FROM messages m
    ${whereSql}
    ORDER BY m.date DESC
    LIMIT ?
  `;
  const stmt = db.prepare(sql).bind(...extraParams, limit);
  try {
    const { results } = await stmt.all<MailDbHit>();
    return results ?? [];
  } catch (e) {
    console.error("search fan-out: per-DB filter query failed", e);
    return [];
  }
}
