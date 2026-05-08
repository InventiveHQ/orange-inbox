import type { Env } from "./types";

// Scheduled tasks run every minute (see wrangler.jsonc triggers.crons).
// We do three things, each idempotent and safe to skip on transient errors:
//   1. Clear `threads.snoozed_until` for threads whose snooze has elapsed.
//   2. Dispatch due `scheduled_messages` rows by calling the web worker's
//      internal dispatcher via the WEB service binding.
//   3. Sweep `temp_uploads` rows older than 24h (and their R2 blobs) so
//      we don't accumulate orphaned upload bytes.
//
// Each step caps how many rows it processes per tick — a one-minute window
// shouldn't produce a 30-second run if a backlog appears.

const DISPATCH_BATCH = 25;
const TEMP_UPLOADS_TTL_S = 60 * 60 * 24; // 24h
const TEMP_UPLOADS_BATCH = 50;

export async function runCron(env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(unsnoozeDueThreads(env));
  ctx.waitUntil(dispatchDueScheduled(env));
  ctx.waitUntil(sweepTempUploads(env));
}

async function unsnoozeDueThreads(env: Env): Promise<void> {
  try {
    const res = await env.DB
      .prepare(
        `UPDATE threads
            SET snoozed_until = NULL
          WHERE snoozed_until IS NOT NULL
            AND snoozed_until <= unixepoch()`,
      )
      .run();
    if (res.meta.changes && res.meta.changes > 0) {
      console.log(`cron: unsnoozed ${res.meta.changes} thread(s)`);
    }
  } catch (e) {
    console.error("cron: unsnooze failed", e);
  }
}

async function dispatchDueScheduled(env: Env): Promise<void> {
  if (!env.WEB || !env.INTERNAL_SECRET) {
    // Without the service binding we can't reach the dispatcher. Skip
    // silently in dev where the binding may not be wired up.
    return;
  }

  try {
    const { results } = await env.DB
      .prepare(
        `SELECT id FROM scheduled_messages
          WHERE status = 'pending' AND scheduled_for <= unixepoch()
          ORDER BY scheduled_for ASC
          LIMIT ?`,
      )
      .bind(DISPATCH_BATCH)
      .all<{ id: string }>();

    for (const row of results ?? []) {
      try {
        const res = await env.WEB.fetch(
          new Request("https://internal/api/internal/dispatch-scheduled", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: row.id, secret: env.INTERNAL_SECRET }),
          }),
        );
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          console.error(`cron: dispatch ${row.id} failed status=${res.status} body=${text}`);
        } else {
          console.log(`cron: dispatched scheduled ${row.id}`);
        }
      } catch (e) {
        console.error(`cron: dispatch ${row.id} threw`, e);
      }
    }
  } catch (e) {
    console.error("cron: scheduled scan failed", e);
  }
}

async function sweepTempUploads(env: Env): Promise<void> {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - TEMP_UPLOADS_TTL_S;
    const { results } = await env.DB
      .prepare(
        `SELECT id, r2_key FROM temp_uploads
          WHERE created_at < ?
          LIMIT ?`,
      )
      .bind(cutoff, TEMP_UPLOADS_BATCH)
      .all<{ id: string; r2_key: string }>();

    if (!results || results.length === 0) return;

    for (const row of results) {
      try {
        await env.ATTACHMENTS.delete(row.r2_key);
      } catch (e) {
        console.error(`cron: failed to delete R2 ${row.r2_key}`, e);
      }
    }

    const placeholders = results.map(() => "?").join(",");
    await env.DB
      .prepare(`DELETE FROM temp_uploads WHERE id IN (${placeholders})`)
      .bind(...results.map(r => r.id))
      .run();

    console.log(`cron: swept ${results.length} stale temp_uploads`);
  } catch (e) {
    console.error("cron: temp_uploads sweep failed", e);
  }
}
