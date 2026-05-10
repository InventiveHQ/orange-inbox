import { getDb, getEnv } from "./db";

// Mail-DB resolver. Single-DB deploys never call into anything beyond
// `getControlDb()`/`getMailDbForNewThread()` returning the primary D1, but
// every mail-plane query goes through this layer so adding overflow DBs
// later is purely an operational change.
//
// Routing rules:
//   - Replies / continued threads: same DB as the parent message.
//     thread_locations is consulted; missing rows default to 'primary' so
//     single-DB installs never write there.
//   - New threads: pick an `active=1` mail DB with capacity (max_bytes IS
//     NULL or byte_estimate < max_bytes), preferring the most-empty one to
//     spread load. The picked DB is recorded in thread_locations so every
//     subsequent reply on that thread routes back to it.

export interface MailDbRow {
  id: string;
  binding_name: string;
  display_name: string | null;
  soft_max_bytes: number | null;
  hard_max_bytes: number | null;
  byte_estimate: number;
  active: number;
}

export function getControlDb(): D1Database {
  return getDb();
}

export async function getMailDbForThread(threadId: string): Promise<D1Database> {
  const row = await getDb()
    .prepare("SELECT mail_db_id FROM thread_locations WHERE thread_id = ?")
    .bind(threadId)
    .first<{ mail_db_id: string }>();
  return resolveMailDbById(row?.mail_db_id ?? "primary");
}

export async function getMailDbForNewThread(): Promise<{ db: D1Database; mailDbId: string }> {
  const row = await pickActiveMailDb();
  if (!row) {
    throw new MailDbError(
      "no_active_db",
      "No mail DB has capacity. Provision an overflow DB or raise max_bytes.",
    );
  }
  return { db: resolveMailDbById(row.id), mailDbId: row.id };
}

// Used by search and any other "ask every DB" path. Excludes inactive ones —
// inactive means "no new threads" but reads still go through getMailDbForThread,
// so they're never excluded from per-thread lookups.
export async function getActiveMailDbs(): Promise<{ id: string; db: D1Database }[]> {
  const { results } = await getDb()
    .prepare("SELECT id, binding_name FROM mail_dbs WHERE active = 1")
    .all<{ id: string; binding_name: string }>();
  const out: { id: string; db: D1Database }[] = [];
  for (const r of results ?? []) {
    out.push({ id: r.id, db: resolveBinding(r.binding_name) });
  }
  return out;
}

// All registered mail DBs regardless of active flag. Used by admin UI and
// the "search even sealed-but-still-readable DBs" code path (which we
// currently treat the same as active for read purposes).
export async function getAllMailDbs(): Promise<{ id: string; db: D1Database; binding_name: string }[]> {
  const { results } = await getDb()
    .prepare("SELECT id, binding_name FROM mail_dbs ORDER BY created_at")
    .all<{ id: string; binding_name: string }>();
  return (results ?? []).map(r => ({
    id: r.id,
    binding_name: r.binding_name,
    db: resolveBinding(r.binding_name),
  }));
}

// Records the location of a freshly-created thread. Only writes a row when
// the thread isn't on 'primary' — that way single-DB deploys keep
// thread_locations empty and the resolver's default kicks in.
export async function registerThreadLocation(threadId: string, mailDbId: string): Promise<void> {
  if (mailDbId === "primary") return;
  await getDb()
    .prepare(
      "INSERT INTO thread_locations (thread_id, mail_db_id) VALUES (?, ?) ON CONFLICT (thread_id) DO NOTHING",
    )
    .bind(threadId, mailDbId)
    .run();
}

// Internal: ID lookup with a small per-request cache so a hot mail-list
// request doesn't re-fetch the row N times.
const idCache = new Map<string, MailDbRow>();

async function loadMailDb(id: string): Promise<MailDbRow> {
  const cached = idCache.get(id);
  if (cached) return cached;
  const row = await getDb()
    .prepare(
      "SELECT id, binding_name, display_name, soft_max_bytes, hard_max_bytes, byte_estimate, active FROM mail_dbs WHERE id = ?",
    )
    .bind(id)
    .first<MailDbRow>();
  if (!row) {
    throw new MailDbError(
      "unknown_db",
      `mail_db_id '${id}' is not registered. Check the mail_dbs table.`,
    );
  }
  idCache.set(id, row);
  return row;
}

function resolveMailDbById(id: string): D1Database {
  // Resolve via cache when populated; otherwise fall back to a synchronous
  // 'primary' shortcut. Any non-primary id forces an async lookup, which
  // means callers that hit a non-primary thread for the first time pay a
  // single SELECT — fine.
  if (id === "primary") return getEnv().DB as unknown as D1Database;
  const cached = idCache.get(id);
  if (cached) return resolveBinding(cached.binding_name);
  // Async load — kick it off and return a placeholder is not viable; instead
  // we ask callers to use the async helpers. This branch is the "we already
  // fetched the row" optimisation; cold paths go through the explicit
  // async getMailDbForThread / getMailDbForNewThread helpers above.
  throw new MailDbError(
    "uncached_db",
    `mail_db_id '${id}' resolved synchronously without a prior load. Use getMailDbForThread.`,
  );
}

function resolveBinding(bindingName: string): D1Database {
  const env = getEnv() as unknown as Record<string, unknown>;
  const binding = env[bindingName];
  if (!binding) {
    throw new MailDbError(
      "missing_binding",
      `wrangler binding env.${bindingName} is not configured. ` +
        `Add it to wrangler.jsonc and redeploy before registering this mail DB.`,
    );
  }
  return binding as D1Database;
}

async function pickActiveMailDb(): Promise<MailDbRow | null> {
  // Prefer the emptiest DB still under its soft cap. If every DB is over its
  // soft cap, fall back to the emptiest DB still under its hard cap so we
  // keep accepting mail (the user's "we should keep receiving emails"
  // requirement). Only when EVERY DB is over its hard cap do we return null
  // and force the caller to surface an outage.
  const sql = (capCol: "soft_max_bytes" | "hard_max_bytes") => `
    SELECT id, binding_name, display_name, soft_max_bytes, hard_max_bytes,
           byte_estimate, active
      FROM mail_dbs
     WHERE active = 1
       AND (${capCol} IS NULL OR byte_estimate < ${capCol})
     ORDER BY byte_estimate ASC
     LIMIT 1
  `;

  const underSoft = await getDb().prepare(sql("soft_max_bytes")).first<MailDbRow>();
  if (underSoft) {
    idCache.set(underSoft.id, underSoft);
    return underSoft;
  }
  const underHard = await getDb().prepare(sql("hard_max_bytes")).first<MailDbRow>();
  if (underHard) {
    idCache.set(underHard.id, underHard);
    return underHard;
  }
  return null;
}

// Storage stats for the UI capacity bar. Returns one row per registered DB
// plus an aggregate so the sidebar can show a single bar without a second
// fetch.
export interface StorageStats {
  total_used: number;
  total_soft: number;     // sum of soft_max_bytes (treating NULL as 0 for the bar denominator)
  total_hard: number;
  any_warning: boolean;   // some DB > 80% of its soft cap
  any_soft_full: boolean; // some DB at/above soft cap
  any_hard_full: boolean; // some DB at/above hard cap
  dbs: {
    id: string;
    display_name: string | null;
    binding_name: string;
    byte_estimate: number;
    soft_max_bytes: number | null;
    hard_max_bytes: number | null;
    active: number;
    state: "ok" | "warning" | "soft_full" | "hard_full";
  }[];
}

export async function getStorageStats(): Promise<StorageStats> {
  const { results } = await getDb()
    .prepare(
      `SELECT id, binding_name, display_name, soft_max_bytes, hard_max_bytes,
              byte_estimate, active
         FROM mail_dbs
        ORDER BY created_at`,
    )
    .all<MailDbRow>();
  const rows = results ?? [];
  const dbs = rows.map(r => ({
    id: r.id,
    display_name: r.display_name,
    binding_name: r.binding_name,
    byte_estimate: r.byte_estimate,
    soft_max_bytes: r.soft_max_bytes,
    hard_max_bytes: r.hard_max_bytes,
    active: r.active,
    state: stateFor(r),
  }));
  return {
    total_used: rows.reduce((a, r) => a + r.byte_estimate, 0),
    total_soft: rows.reduce((a, r) => a + (r.soft_max_bytes ?? 0), 0),
    total_hard: rows.reduce((a, r) => a + (r.hard_max_bytes ?? 0), 0),
    any_warning: dbs.some(d => d.state !== "ok"),
    any_soft_full: dbs.some(d => d.state === "soft_full" || d.state === "hard_full"),
    any_hard_full: dbs.some(d => d.state === "hard_full"),
    dbs,
  };
}

function stateFor(r: MailDbRow): "ok" | "warning" | "soft_full" | "hard_full" {
  if (r.hard_max_bytes != null && r.byte_estimate >= r.hard_max_bytes) return "hard_full";
  if (r.soft_max_bytes != null && r.byte_estimate >= r.soft_max_bytes) return "soft_full";
  if (r.soft_max_bytes != null && r.byte_estimate >= r.soft_max_bytes * 0.8) return "warning";
  return "ok";
}

// Throws if a write to `mailDbId` would push past its hard cap. Used by
// reply-write paths to decide whether to write into the thread's pinned DB
// or divert to an overflow DB.
export async function isMailDbHardFull(mailDbId: string): Promise<boolean> {
  const row = await loadMailDb(mailDbId);
  if (row.hard_max_bytes == null) return false;
  return row.byte_estimate >= row.hard_max_bytes;
}

// Upserts a thread row in `threads_index` (control DB). Called by both the
// outbound send path and the inbound email-worker after they've written the
// message itself into the thread's mail DB. Bumps message_count, refreshes
// last-message snippet fields, and conditionally bumps unread_count when the
// new message was inbound.
export interface ThreadIndexUpsert {
  threadId: string;
  mailboxId: string;
  mailDbId: string;
  subjectNormalized: string;
  lastMessageAt: number;
  unreadDelta: number;                   // 0 for outbound, 1 for inbound
  lastMessageId: string;
  lastSubject: string | null;
  lastFromAddr: string | null;
  lastFromName: string | null;
  lastSnippet: string | null;
  // For new-thread inserts only — created_at on the row.
  createdAt?: number;
}

export async function upsertThreadIndex(p: ThreadIndexUpsert): Promise<void> {
  const created = p.createdAt ?? Math.floor(Date.now() / 1000);
  await getDb()
    .prepare(
      `INSERT INTO threads_index
         (thread_id, mailbox_id, mail_db_id, subject_normalized,
          last_message_at, message_count, unread_count,
          archived, starred,
          last_message_id, last_subject, last_from_addr, last_from_name, last_snippet,
          created_at)
       VALUES
         (?, ?, ?, ?,
          ?, 1, ?,
          0, 0,
          ?, ?, ?, ?, ?,
          ?)
       ON CONFLICT (thread_id) DO UPDATE SET
         last_message_at  = MAX(threads_index.last_message_at, excluded.last_message_at),
         message_count    = threads_index.message_count + 1,
         unread_count     = threads_index.unread_count + ?,
         last_message_id  = excluded.last_message_id,
         last_subject     = excluded.last_subject,
         last_from_addr   = excluded.last_from_addr,
         last_from_name   = excluded.last_from_name,
         last_snippet     = excluded.last_snippet`,
    )
    .bind(
      p.threadId,
      p.mailboxId,
      p.mailDbId,
      p.subjectNormalized,
      p.lastMessageAt,
      p.unreadDelta,
      p.lastMessageId,
      p.lastSubject,
      p.lastFromAddr,
      p.lastFromName,
      p.lastSnippet,
      created,
      p.unreadDelta,
    )
    .run();
}

export class MailDbError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
