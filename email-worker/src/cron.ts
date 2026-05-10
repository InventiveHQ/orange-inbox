import { getActiveMailDbs } from "./mail-db";
import type { Env } from "./types";

// Scheduled tasks run every minute (see wrangler.jsonc triggers.crons).
// We do these things, each idempotent and safe to skip on transient errors:
//   1. Dispatch due `scheduled_messages` rows by calling the web worker's
//      internal dispatcher via the WEB service binding.
//   2. Dispatch due calendar reminders (`calendar_event_reminders`) via the
//      web worker's /api/internal/dispatch-reminders endpoint.
//   3. Sweep `temp_uploads` rows older than 24h (and their R2 blobs).
//   4. Process the r2_tombstones queue (delete R2 keys, then drop the row).
//   5. Refresh `mail_dbs.byte_estimate` once per CAPACITY_REFRESH_EVERY_TICKS
//      ticks so the sidebar capacity bar tracks reality. Done sparingly
//      because it scans every active mail DB.
//
// Each step caps how many rows it processes per tick — a one-minute window
// shouldn't produce a 30-second run if a backlog appears.

const DISPATCH_BATCH = 25;
const TEMP_UPLOADS_TTL_S = 60 * 60 * 24; // 24h
const TEMP_UPLOADS_BATCH = 50;
const R2_TOMBSTONE_BATCH = 50;
// Refresh capacity stats every ~30 minutes. The query SUMs LENGTH(text_body)
// across every messages row in every active mail DB; cheap individually but
// don't run it every minute.
const CAPACITY_REFRESH_EVERY_TICKS = 30;

export async function runCron(env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(dispatchDueScheduled(env));
  ctx.waitUntil(dispatchDueReminders(env));
  ctx.waitUntil(sweepTempUploads(env));
  ctx.waitUntil(sweepR2Tombstones(env));

  // Stagger the capacity refresh by minute-of-hour so we don't run it on
  // every tick. With CAPACITY_REFRESH_EVERY_TICKS=30 this fires twice per
  // hour at minute-of-hour {0..29 ... 0} mod 30, which is good enough.
  const minuteOfHour = new Date().getUTCMinutes();
  if (minuteOfHour % CAPACITY_REFRESH_EVERY_TICKS === 0) {
    ctx.waitUntil(refreshMailDbCapacity(env));
  }
}

// Approximate per-mail-DB size by summing text_body lengths. Real D1 file
// size includes index overhead, FTS index, and SQLite internals — so we
// fudge upward by 1.5× to pad against under-counting (better the bar shows
// "fuller than reality" than "emptier"). Kept rough on purpose; the user
// only needs accuracy at the soft-cap warning threshold, not byte-exact
// numbers.
async function refreshMailDbCapacity(env: Env): Promise<void> {
  try {
    const dbs = await getActiveMailDbs(env);
    for (const { id, db } of dbs) {
      try {
        const row = await db
          .prepare(
            `SELECT COALESCE(SUM(LENGTH(text_body)), 0) AS bytes_text,
                    COALESCE(SUM(size), 0)              AS bytes_attach
               FROM messages m
               LEFT JOIN attachments a ON a.message_id = m.id`,
          )
          .first<{ bytes_text: number; bytes_attach: number }>();
        const raw = (row?.bytes_text ?? 0) + (row?.bytes_attach ?? 0);
        const fudged = Math.floor(raw * 1.5);
        await env.DB
          .prepare("UPDATE mail_dbs SET byte_estimate = ? WHERE id = ?")
          .bind(fudged, id)
          .run();
        console.log(`cron: capacity ${id} bytes=${fudged} (raw=${raw})`);
      } catch (e) {
        console.error(`cron: capacity refresh ${id} failed`, e);
      }
    }
  } catch (e) {
    console.error("cron: capacity refresh failed", e);
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

// Calendar reminders (#85). The web worker owns the actual dispatch logic
// (it has VAPID keys + the push-send helper); we just poke its internal
// endpoint once per minute. The endpoint is idempotent — the
// calendar_reminders_sent ledger dedupes, so a retry on transient failure
// won't double-fire.
async function dispatchDueReminders(env: Env): Promise<void> {
  if (!env.WEB || !env.INTERNAL_SECRET) {
    // Local dev without the service binding wired up — skip silently.
    return;
  }
  try {
    const res = await env.WEB.fetch(
      new Request("https://internal/api/internal/dispatch-reminders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: env.INTERNAL_SECRET }),
      }),
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `cron: dispatch-reminders failed status=${res.status} body=${text.slice(0, 200)}`,
      );
      return;
    }
    const body = (await res.json().catch(() => null)) as
      | { dispatched?: number; pushed?: number }
      | null;
    if (body && (body.dispatched ?? 0) > 0) {
      console.log(
        `cron: dispatched ${body.dispatched} reminder(s), ${body.pushed ?? 0} push send(s)`,
      );
    }
  } catch (e) {
    console.error("cron: dispatch-reminders threw", e);
  }
}

async function sweepR2Tombstones(env: Env): Promise<void> {
  try {
    const { results } = await env.DB
      .prepare(
        `SELECT id, bucket, r2_key FROM r2_tombstones
          ORDER BY queued_at ASC
          LIMIT ?`,
      )
      .bind(R2_TOMBSTONE_BATCH)
      .all<{ id: number; bucket: string; r2_key: string }>();
    if (!results || results.length === 0) return;

    const successful: number[] = [];
    for (const t of results) {
      const bucket = t.bucket === "RAW_MAIL" ? env.RAW_MAIL : env.ATTACHMENTS;
      try {
        await bucket.delete(t.r2_key);
        successful.push(t.id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`cron: r2 tombstone ${t.id} (${t.bucket}/${t.r2_key}) failed`, msg);
        try {
          await env.DB
            .prepare(
              "UPDATE r2_tombstones SET attempts = attempts + 1, last_error = ? WHERE id = ?",
            )
            .bind(msg.slice(0, 500), t.id)
            .run();
        } catch (e2) {
          console.error(`cron: failed to record tombstone error for ${t.id}`, e2);
        }
      }
    }

    if (successful.length > 0) {
      const placeholders = successful.map(() => "?").join(",");
      await env.DB
        .prepare(`DELETE FROM r2_tombstones WHERE id IN (${placeholders})`)
        .bind(...successful)
        .run();
      console.log(`cron: cleared ${successful.length} r2 tombstones`);
    }
  } catch (e) {
    console.error("cron: r2 tombstones sweep failed", e);
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
