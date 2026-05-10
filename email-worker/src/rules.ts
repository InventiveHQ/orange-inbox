// Inbound rule evaluator. Mirror of the matcher logic shape defined in
// web/src/lib/rules.ts — kept in sync by hand because the email-worker
// can't import from the web bundle.
//
// Called from store.ts after a message is fully persisted. Loads every
// enabled rule belonging to a user with access to the recipient mailbox
// (scoped: rule.mailbox_id IS NULL OR mailbox_id = recipient mailbox),
// runs them in (sort_order, created_at) order, and applies the actions.
//
// Stops at the first rule whose actions include a *terminal* action
// (archive or delete) — same Gmail-style "first matching filter wins" behaviour
// users expect, so an "archive" rule above a "label" rule doesn't end up
// labelling the message in the inbox.

import type { Env } from "./types";

type RuleCondition =
  | { field: "from"; op: "contains" | "equals"; value: string }
  | { field: "subject"; op: "contains"; value: string }
  | { field: "to"; op: "contains"; value: string }
  | { field: "has_attachment"; value: boolean };

type RuleAction =
  | { type: "apply_label"; label_id: string }
  | { type: "archive" }
  | { type: "mark_as_read" }
  | { type: "delete" };

interface RuleRow {
  id: string;
  user_id: string;
  mailbox_id: string | null;
  conditions_json: string;
  actions_json: string;
  sort_order: number;
  created_at: number;
}

export interface EvalContext {
  // Control-DB ids needed to scope label/archive/delete operations.
  mailboxId: string;
  threadId: string;
  messageId: string;
  // Where the new message physically lives — needed for per-message
  // mutations (mark read, label, delete) and for matching against the raw
  // message fields without re-parsing the .eml.
  mailDb: D1Database;
  mailDbId: string;
  // Pre-parsed fields for matching. Lowercased ahead of time so each
  // condition check is a plain substring/equality comparison.
  fromAddrLower: string;
  subjectLower: string;
  // Local-part of the recipient mailbox (e.g. "support" for support@…).
  // Useful for catch-all mailboxes that receive mail addressed to many
  // local-parts and want to fan them out by alias.
  recipientLocalPartLower: string;
  hasAttachment: boolean;
}

export async function evaluateRules(env: Env, ctx: EvalContext): Promise<void> {
  // Pull rules belonging to any user with access to this mailbox, scoped
  // to either "all mailboxes" or this specific mailbox. One query — no
  // per-rule auth recheck needed since user_mailbox_access drives the join.
  const { results } = await env.DB
    .prepare(
      `SELECT r.id, r.user_id, r.mailbox_id, r.conditions_json, r.actions_json,
              r.sort_order, r.created_at
         FROM rules r
         INNER JOIN user_mailbox_access uma ON uma.user_id = r.user_id
        WHERE uma.mailbox_id = ?
          AND r.enabled = 1
          AND (r.mailbox_id IS NULL OR r.mailbox_id = ?)
        ORDER BY r.sort_order, r.created_at`,
    )
    .bind(ctx.mailboxId, ctx.mailboxId)
    .all<RuleRow>();

  for (const row of results ?? []) {
    const conditions = parseJson<RuleCondition>(row.conditions_json);
    const actions = parseJson<RuleAction>(row.actions_json);
    if (conditions.length === 0 || actions.length === 0) continue;

    if (!matches(conditions, ctx)) continue;

    const terminal = await applyActions(env, ctx, actions);
    if (terminal) return;
  }
}

function matches(conditions: RuleCondition[], ctx: EvalContext): boolean {
  // V1: implicit AND across conditions. Returns false on the first miss.
  for (const c of conditions) {
    if (c.field === "from") {
      if (c.op === "equals") {
        if (ctx.fromAddrLower !== c.value) return false;
      } else {
        if (!ctx.fromAddrLower.includes(c.value)) return false;
      }
    } else if (c.field === "subject") {
      if (!ctx.subjectLower.includes(c.value)) return false;
    } else if (c.field === "to") {
      if (!ctx.recipientLocalPartLower.includes(c.value)) return false;
    } else if (c.field === "has_attachment") {
      if (ctx.hasAttachment !== !!c.value) return false;
    }
  }
  return true;
}

// Returns true if a "terminal" action ran (archive or delete) — caller
// should stop processing further rules. mark_as_read and apply_label are
// non-terminal; multiple label rules can stack.
async function applyActions(
  env: Env,
  ctx: EvalContext,
  actions: RuleAction[],
): Promise<boolean> {
  let terminal = false;
  for (const action of actions) {
    if (action.type === "apply_label") {
      await applyLabel(env, ctx, action.label_id);
    } else if (action.type === "mark_as_read") {
      await markRead(env, ctx);
    } else if (action.type === "archive") {
      await archive(env, ctx);
      terminal = true;
    } else if (action.type === "delete") {
      await hardDelete(env, ctx);
      // Once the thread is gone there's nothing left to act on.
      return true;
    }
  }
  return terminal;
}

// Mirror of the apply-label flow in web/src/app/api/threads/[id]/labels/route.ts:
// per-message message_labels in the mail DB plus the (thread, label)
// denormalisation in the control-DB thread_labels cache.
async function applyLabel(env: Env, ctx: EvalContext, labelId: string): Promise<void> {
  // Drop the action silently if the label's gone missing — better than
  // failing the whole inbound. The user can fix the rule later.
  const label = await env.DB
    .prepare("SELECT id FROM labels WHERE id = ? LIMIT 1")
    .bind(labelId)
    .first();
  if (!label) return;

  await Promise.all([
    ctx.mailDb
      .prepare(
        `INSERT OR IGNORE INTO message_labels (message_id, label_id)
           SELECT m.id, ?1 FROM messages m WHERE m.thread_id = ?2`,
      )
      .bind(labelId, ctx.threadId)
      .run(),
    env.DB
      .prepare(
        `INSERT INTO thread_labels (thread_id, label_id) VALUES (?, ?)
         ON CONFLICT (thread_id, label_id) DO NOTHING`,
      )
      .bind(ctx.threadId, labelId)
      .run(),
  ]);
}

// Mirror of the read-flag handling in web/src/app/api/threads/[id]/route.ts:
// flip every per-message read flag in the thread's mail DB, zero
// threads_index.unread_count.
async function markRead(env: Env, ctx: EvalContext): Promise<void> {
  await Promise.all([
    ctx.mailDb
      .prepare("UPDATE messages SET read = 1 WHERE thread_id = ? AND read = 0")
      .bind(ctx.threadId)
      .run(),
    env.DB
      .prepare("UPDATE threads_index SET unread_count = 0 WHERE thread_id = ?")
      .bind(ctx.threadId)
      .run(),
  ]);
}

// archive = set threads_index.archived = 1 (source of truth for the inbox
// listing). Also zero unread so a new reply doesn't unintentionally surface
// the thread later.
async function archive(env: Env, ctx: EvalContext): Promise<void> {
  await env.DB
    .prepare(
      "UPDATE threads_index SET archived = 1, unread_count = 0 WHERE thread_id = ?",
    )
    .bind(ctx.threadId)
    .run();
  await ctx.mailDb
    .prepare("UPDATE messages SET read = 1 WHERE thread_id = ? AND read = 0")
    .bind(ctx.threadId)
    .run();
}

// Hard delete this single message (NOT the whole thread) plus the R2
// objects it owns. The thread row stays put — other messages may share it,
// and rule evaluation only ever fires on the brand-new inbound, so this is
// the only candidate for removal.
//
// If the thread becomes empty as a result we tear it down too, mirroring the
// thread-DELETE route.
async function hardDelete(env: Env, ctx: EvalContext): Promise<void> {
  // Materialise R2 keys for tombstoning (cross-DB INSERT...SELECT isn't
  // allowed in D1 — same trick the thread-DELETE route uses).
  const [rawRow, htmlRow, attachmentRows] = await Promise.all([
    ctx.mailDb
      .prepare("SELECT raw_r2_key FROM messages WHERE id = ?")
      .bind(ctx.messageId)
      .first<{ raw_r2_key: string }>(),
    ctx.mailDb
      .prepare(
        "SELECT html_r2_key FROM messages WHERE id = ? AND html_r2_key IS NOT NULL",
      )
      .bind(ctx.messageId)
      .first<{ html_r2_key: string }>(),
    ctx.mailDb
      .prepare("SELECT r2_key FROM attachments WHERE message_id = ?")
      .bind(ctx.messageId)
      .all<{ r2_key: string }>(),
  ]);

  const tombstones: D1PreparedStatement[] = [];
  if (rawRow?.raw_r2_key) {
    tombstones.push(
      env.DB
        .prepare("INSERT INTO r2_tombstones (bucket, r2_key) VALUES ('RAW_MAIL', ?)")
        .bind(rawRow.raw_r2_key),
    );
  }
  if (htmlRow?.html_r2_key) {
    tombstones.push(
      env.DB
        .prepare("INSERT INTO r2_tombstones (bucket, r2_key) VALUES ('RAW_MAIL', ?)")
        .bind(htmlRow.html_r2_key),
    );
  }
  for (const r of attachmentRows.results ?? []) {
    tombstones.push(
      env.DB
        .prepare("INSERT INTO r2_tombstones (bucket, r2_key) VALUES ('ATTACHMENTS', ?)")
        .bind(r.r2_key),
    );
  }

  // Delete the message row in the mail DB (cascades attachments,
  // message_labels). Then check if the thread now has zero messages and
  // tear down the thread + control-DB satellites if so.
  await ctx.mailDb.prepare("DELETE FROM messages WHERE id = ?").bind(ctx.messageId).run();

  const remaining = await ctx.mailDb
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?")
    .bind(ctx.threadId)
    .first<{ n: number }>();
  const empty = (remaining?.n ?? 0) === 0;

  if (empty) {
    await ctx.mailDb.prepare("DELETE FROM threads WHERE id = ?").bind(ctx.threadId).run();
    await env.DB.batch([
      ...tombstones,
      env.DB.prepare("DELETE FROM thread_labels WHERE thread_id = ?").bind(ctx.threadId),
      env.DB.prepare("DELETE FROM thread_locations WHERE thread_id = ?").bind(ctx.threadId),
      env.DB.prepare("DELETE FROM threads_index WHERE thread_id = ?").bind(ctx.threadId),
    ]);
  } else {
    // Thread still has older messages — keep the thread row but pull
    // counters back so the inbox listing stays accurate. Recompute from
    // the surviving messages instead of decrementing blindly.
    const stats = await ctx.mailDb
      .prepare(
        `SELECT COUNT(*) AS msg_count,
                SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) AS unread_count,
                MAX(date) AS last_at
           FROM messages WHERE thread_id = ?`,
      )
      .bind(ctx.threadId)
      .first<{ msg_count: number; unread_count: number; last_at: number }>();
    const last = await ctx.mailDb
      .prepare(
        `SELECT id, subject, from_addr, from_name, snippet
           FROM messages WHERE thread_id = ?
          ORDER BY date DESC LIMIT 1`,
      )
      .bind(ctx.threadId)
      .first<{
        id: string;
        subject: string | null;
        from_addr: string;
        from_name: string | null;
        snippet: string | null;
      }>();

    await ctx.mailDb
      .prepare(
        `UPDATE threads
            SET message_count = ?, unread_count = ?, last_message_at = ?
          WHERE id = ?`,
      )
      .bind(stats?.msg_count ?? 0, stats?.unread_count ?? 0, stats?.last_at ?? 0, ctx.threadId)
      .run();

    await env.DB.batch([
      ...tombstones,
      env.DB
        .prepare(
          `UPDATE threads_index
              SET message_count = ?, unread_count = ?, last_message_at = ?,
                  last_message_id = ?, last_subject = ?,
                  last_from_addr = ?, last_from_name = ?, last_snippet = ?
            WHERE thread_id = ?`,
        )
        .bind(
          stats?.msg_count ?? 0,
          stats?.unread_count ?? 0,
          stats?.last_at ?? 0,
          last?.id ?? null,
          last?.subject ?? null,
          last?.from_addr ?? null,
          last?.from_name ?? null,
          last?.snippet ?? null,
          ctx.threadId,
        ),
    ]);
  }
}

function parseJson<T>(s: string): T[] {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
