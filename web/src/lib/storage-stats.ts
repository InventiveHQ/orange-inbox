import { getDb } from "./db";
import { getAllMailDbs } from "./mail-db";

// Storage Explorer aggregations. Read-only, admin-only — surfaced via
// /inbox/storage. Bytes per message are computed from columns that live in
// the mail DBs: LENGTH(text_body) + sum(attachments.size). Two known
// exclusions, called out in the UI:
//   - Raw .eml stored in R2 (raw_r2_key) — no `size` column on messages.
//   - HTML body stored in R2 (html_r2_key) — same reason.
// So the numbers shown are best treated as a relative ranking, not a true
// "bytes on disk" figure.
//
// We fan out across every registered mail DB via getAllMailDbs (NOT
// getActiveMailDbs — sealed/inactive DBs still consume bytes and are exactly
// what an admin wants visibility into). For ranked queries (top-N senders /
// threads) we over-fetch limit*dbCount per DB then re-aggregate by key in
// JS, since "top N globally" can't be expressed as N-per-DB without losing
// senders/threads that are #51 in DB A but would land top-50 if A had been
// the only DB.
//
// Performance: this is a deliberately heavy page. On a large mailbox these
// queries scan the entire messages + attachments tables per DB. Acceptable
// for v1 — it's an admin-only page that's only loaded on demand.

export interface SenderRow {
  from_addr: string;
  msg_count: number;
  bytes: number;
}

export interface ThreadRow {
  thread_id: string;
  subject: string | null;
  mailbox_label: string | null; // "local_part@domain", or null when the thread isn't in threads_index
  msg_count: number;
  bytes: number;
}

export interface DomainRow {
  domain: string;
  thread_count: number;
  msg_count: number;
  bytes: number;
}

interface RawSenderRow {
  from_addr: string;
  msg_count: number;
  body_bytes: number;
  attachment_bytes: number;
}

interface RawThreadRow {
  thread_id: string;
  msg_count: number;
  body_bytes: number;
  attachment_bytes: number;
}

export async function getTopSenders(limit = 50): Promise<SenderRow[]> {
  const dbs = await getAllMailDbs();
  if (dbs.length === 0) return [];
  // Over-fetch per DB so the global re-aggregation has a fair chance of
  // landing the true top-N — see header comment.
  const perDbLimit = Math.max(limit, limit * dbs.length);

  const sql = `
    SELECT m.from_addr,
           COUNT(DISTINCT m.id) AS msg_count,
           COALESCE(SUM(LENGTH(COALESCE(m.text_body,''))), 0) AS body_bytes,
           COALESCE(SUM(a.size), 0) AS attachment_bytes
      FROM messages m
      LEFT JOIN attachments a ON a.message_id = m.id
     GROUP BY m.from_addr
     ORDER BY (body_bytes + attachment_bytes) DESC
     LIMIT ?
  `;

  const perDb = await Promise.all(
    dbs.map(async ({ db }) => {
      const { results } = await db.prepare(sql).bind(perDbLimit).all<RawSenderRow>();
      return results ?? [];
    }),
  );

  const byAddr = new Map<string, SenderRow>();
  for (const rows of perDb) {
    for (const r of rows) {
      const key = r.from_addr ?? "";
      const cur = byAddr.get(key);
      const bytes = (r.body_bytes ?? 0) + (r.attachment_bytes ?? 0);
      if (cur) {
        cur.msg_count += r.msg_count ?? 0;
        cur.bytes += bytes;
      } else {
        byAddr.set(key, {
          from_addr: key,
          msg_count: r.msg_count ?? 0,
          bytes,
        });
      }
    }
  }

  return [...byAddr.values()]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit);
}

export async function getTopThreads(limit = 50): Promise<ThreadRow[]> {
  const dbs = await getAllMailDbs();
  if (dbs.length === 0) return [];
  const perDbLimit = Math.max(limit, limit * dbs.length);

  const sql = `
    SELECT m.thread_id,
           COUNT(DISTINCT m.id) AS msg_count,
           COALESCE(SUM(LENGTH(COALESCE(m.text_body,''))), 0) AS body_bytes,
           COALESCE(SUM(a.size), 0) AS attachment_bytes
      FROM messages m
      LEFT JOIN attachments a ON a.message_id = m.id
     GROUP BY m.thread_id
     ORDER BY (body_bytes + attachment_bytes) DESC
     LIMIT ?
  `;

  const perDb = await Promise.all(
    dbs.map(async ({ db }) => {
      const { results } = await db.prepare(sql).bind(perDbLimit).all<RawThreadRow>();
      return results ?? [];
    }),
  );

  // Threads are pinned to a single mail DB by thread_locations, so the same
  // thread_id never appears in two DBs. Still, keep a Map keyed by
  // thread_id and sum defensively rather than assuming uniqueness.
  const byThread = new Map<string, { msg_count: number; bytes: number }>();
  for (const rows of perDb) {
    for (const r of rows) {
      const cur = byThread.get(r.thread_id);
      const bytes = (r.body_bytes ?? 0) + (r.attachment_bytes ?? 0);
      if (cur) {
        cur.msg_count += r.msg_count ?? 0;
        cur.bytes += bytes;
      } else {
        byThread.set(r.thread_id, { msg_count: r.msg_count ?? 0, bytes });
      }
    }
  }

  // Pick the global top-N first so we only do the control-DB lookup for
  // threads we're actually rendering.
  const top = [...byThread.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, limit);

  if (top.length === 0) return [];

  // One round-trip to the control DB for subject + mailbox_label. threads_index
  // already joins mailboxes/domains conceptually (it stores mailbox_id), so
  // we join here to render a friendly "local_part@domain" label.
  const ids = top.map(([id]) => id);
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await getDb()
    .prepare(
      `SELECT ti.thread_id, ti.last_subject, ti.subject_normalized,
              mb.local_part, d.name AS domain_name
         FROM threads_index ti
         INNER JOIN mailboxes mb ON mb.id = ti.mailbox_id
         INNER JOIN domains d ON d.id = mb.domain_id
        WHERE ti.thread_id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{
      thread_id: string;
      last_subject: string | null;
      subject_normalized: string;
      local_part: string;
      domain_name: string;
    }>();

  const meta = new Map<string, { subject: string | null; mailbox_label: string }>();
  for (const r of results ?? []) {
    meta.set(r.thread_id, {
      subject: r.last_subject ?? r.subject_normalized ?? null,
      mailbox_label: `${r.local_part}@${r.domain_name}`,
    });
  }

  return top.map(([thread_id, agg]) => {
    const m = meta.get(thread_id);
    return {
      thread_id,
      subject: m?.subject ?? null,
      mailbox_label: m?.mailbox_label ?? null,
      msg_count: agg.msg_count,
      bytes: agg.bytes,
    };
  });
}

interface RawDomainRow {
  domain: string;
  thread_count: number;
  msg_count: number;
  body_bytes: number;
  attachment_bytes: number;
}

export async function getDomainSummary(): Promise<DomainRow[]> {
  const dbs = await getAllMailDbs();
  if (dbs.length === 0) return [];

  // SQLite has no inbuilt regex / split-on-char, so we extract the domain
  // with substr(...,instr(...,'@')+1). Empty / malformed addresses fall into
  // a single "(unknown)" bucket so they don't blow up the GROUP BY.
  const sql = `
    SELECT CASE
             WHEN m.from_addr IS NULL OR instr(m.from_addr,'@') = 0 THEN '(unknown)'
             ELSE LOWER(substr(m.from_addr, instr(m.from_addr,'@')+1))
           END AS domain,
           COUNT(DISTINCT m.thread_id) AS thread_count,
           COUNT(DISTINCT m.id) AS msg_count,
           COALESCE(SUM(LENGTH(COALESCE(m.text_body,''))), 0) AS body_bytes,
           COALESCE(SUM(a.size), 0) AS attachment_bytes
      FROM messages m
      LEFT JOIN attachments a ON a.message_id = m.id
     GROUP BY domain
  `;

  const perDb = await Promise.all(
    dbs.map(async ({ db }) => {
      const { results } = await db.prepare(sql).all<RawDomainRow>();
      return results ?? [];
    }),
  );

  const byDomain = new Map<string, DomainRow>();
  for (const rows of perDb) {
    for (const r of rows) {
      const cur = byDomain.get(r.domain);
      const bytes = (r.body_bytes ?? 0) + (r.attachment_bytes ?? 0);
      // thread_count: threads are pinned to a single DB, so summing across
      // DBs is correct (no thread is double-counted).
      if (cur) {
        cur.thread_count += r.thread_count ?? 0;
        cur.msg_count += r.msg_count ?? 0;
        cur.bytes += bytes;
      } else {
        byDomain.set(r.domain, {
          domain: r.domain,
          thread_count: r.thread_count ?? 0,
          msg_count: r.msg_count ?? 0,
          bytes,
        });
      }
    }
  }

  return [...byDomain.values()].sort((a, b) => b.bytes - a.bytes);
}
