// Mail-DB resolver for the inbound email-worker.
//
// Mirrors web/src/lib/mail-db.ts in spirit but lives standalone so the email
// worker doesn't depend on the web bundle. The control DB is always env.DB
// (the `mail_dbs` table lives there). Other mail DBs are looked up by
// binding name and accessed via env[bindingName] at runtime.

import type { Env } from "./types";

interface MailDbRow {
  id: string;
  binding_name: string;
  soft_max_bytes: number | null;
  hard_max_bytes: number | null;
  byte_estimate: number;
  active: number;
}

export function getControlDb(env: Env): D1Database {
  return env.DB;
}

// Resolve a thread to its mail DB. Missing thread_locations row → 'primary'.
export async function getMailDbForThread(env: Env, threadId: string): Promise<D1Database> {
  const row = await env.DB
    .prepare("SELECT mail_db_id FROM thread_locations WHERE thread_id = ?")
    .bind(threadId)
    .first<{ mail_db_id: string }>();
  return resolveById(env, row?.mail_db_id ?? "primary");
}

// Pick a mail DB for a new thread. Soft-cap-respecting first; falls back to
// hard-cap-respecting in degraded mode so inbound mail still lands somewhere.
export async function getMailDbForNewThread(
  env: Env,
): Promise<{ db: D1Database; mailDbId: string } | null> {
  const sql = (capCol: "soft_max_bytes" | "hard_max_bytes") => `
    SELECT id, binding_name, soft_max_bytes, hard_max_bytes, byte_estimate, active
      FROM mail_dbs
     WHERE active = 1
       AND (${capCol} IS NULL OR byte_estimate < ${capCol})
     ORDER BY byte_estimate ASC
     LIMIT 1
  `;
  let row = await env.DB.prepare(sql("soft_max_bytes")).first<MailDbRow>();
  if (!row) row = await env.DB.prepare(sql("hard_max_bytes")).first<MailDbRow>();
  if (!row) return null;
  return { db: resolveBinding(env, row.binding_name), mailDbId: row.id };
}

// Returns every active mail DB. Used for cross-DB lookups (e.g. resolving an
// In-Reply-To header against any prior message).
export async function getActiveMailDbs(env: Env): Promise<{ id: string; db: D1Database }[]> {
  const { results } = await env.DB
    .prepare("SELECT id, binding_name FROM mail_dbs WHERE active = 1")
    .all<{ id: string; binding_name: string }>();
  return (results ?? []).map(r => ({ id: r.id, db: resolveBinding(env, r.binding_name) }));
}

export async function registerThreadLocation(
  env: Env,
  threadId: string,
  mailDbId: string,
): Promise<void> {
  if (mailDbId === "primary") return;
  await env.DB
    .prepare(
      "INSERT INTO thread_locations (thread_id, mail_db_id) VALUES (?, ?) ON CONFLICT (thread_id) DO NOTHING",
    )
    .bind(threadId, mailDbId)
    .run();
}

export interface ThreadIndexUpsert {
  threadId: string;
  mailboxId: string;
  mailDbId: string;
  subjectNormalized: string;
  lastMessageAt: number;
  unreadDelta: number;
  lastMessageId: string;
  lastSubject: string | null;
  lastFromAddr: string | null;
  lastFromName: string | null;
  lastSnippet: string | null;
  createdAt?: number;
  // Three-state on UPDATE (INSERT only honours `true` — new rows default to
  // archived = 0):
  //   true       — set archived = 1 (muted / blocked-sender stays out of inbox)
  //   false      — set archived = 0 (new inbound re-surfaces a previously
  //                archived thread; matches the store.ts comments that only
  //                muted/blocked threads stay archived on new activity)
  //   undefined  — leave the existing archived value alone (no caller today)
  forceArchived?: boolean;
  // Opt-in auto-archive (0055). When set, stamps threads_index.auto_archived_at
  // on INSERT so the digest banner can count "filed in the last day" and the
  // UI can offer undo. Only ever passed for new marketing/quiet threads, which
  // always take the INSERT branch — so we don't touch it in the conflict UPDATE.
  autoArchivedAt?: number;
}

export async function upsertThreadIndex(env: Env, p: ThreadIndexUpsert): Promise<void> {
  const created = p.createdAt ?? Math.floor(Date.now() / 1000);
  const archivedClause =
    p.forceArchived === true
      ? ", archived = 1"
      : p.forceArchived === false
        ? ", archived = 0"
        : "";
  const insertArchived = p.forceArchived === true ? 1 : 0;
  await env.DB
    .prepare(
      `INSERT INTO threads_index
         (thread_id, mailbox_id, mail_db_id, subject_normalized,
          last_message_at, message_count, unread_count,
          archived, starred,
          last_message_id, last_subject, last_from_addr, last_from_name, last_snippet,
          created_at, auto_archived_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (thread_id) DO UPDATE SET
         last_message_at  = MAX(threads_index.last_message_at, excluded.last_message_at),
         message_count    = threads_index.message_count + 1,
         unread_count     = threads_index.unread_count + ?,
         last_message_id  = excluded.last_message_id,
         last_subject     = excluded.last_subject,
         last_from_addr   = excluded.last_from_addr,
         last_from_name   = excluded.last_from_name,
         last_snippet     = excluded.last_snippet${archivedClause}`,
    )
    .bind(
      p.threadId, p.mailboxId, p.mailDbId, p.subjectNormalized,
      p.lastMessageAt, p.unreadDelta, insertArchived,
      p.lastMessageId, p.lastSubject, p.lastFromAddr, p.lastFromName, p.lastSnippet,
      created, p.autoArchivedAt ?? null,
      p.unreadDelta,
    )
    .run();
}

// Read the muted flag for a thread from threads_index. Returns false for
// new threads (no row yet) and on lookup failure.
export async function isThreadMuted(env: Env, threadId: string): Promise<boolean> {
  try {
    const row = await env.DB
      .prepare("SELECT muted FROM threads_index WHERE thread_id = ?")
      .bind(threadId)
      .first<{ muted: number }>();
    return row?.muted === 1;
  } catch {
    return false;
  }
}

function resolveById(env: Env, id: string): D1Database {
  if (id === "primary") return env.DB;
  // For non-primary we have to know the binding name; fetch synchronously
  // would require a lookup we don't have here. We rely on the caller having
  // already resolved the binding via getMailDbForThread (which does the
  // lookup). This branch is only hit if the caller knows the id but not the
  // binding, which doesn't happen in current flows.
  throw new Error(`resolveById('${id}') needs binding lookup; use getMailDbForThread`);
}

function resolveBinding(env: Env, bindingName: string): D1Database {
  const v = (env as unknown as Record<string, unknown>)[bindingName];
  if (!v) throw new Error(`mail DB binding env.${bindingName} is not configured`);
  return v as D1Database;
}
