import { NextRequest, NextResponse } from "next/server";
import { getCtx, getEnv } from "@/lib/db";
import {
  aggregateReminderPayload,
  listDueReminders,
  listSubscriptionsForUser,
  markReminderSent,
  singleReminderPayload,
  type DueReminderRow,
  type UserPushSub,
} from "@/lib/reminders";
import { pruneSubscription, markSubscriptionUsed } from "@/lib/push-subscriptions";
import { sendPush, type VapidConfig } from "@/lib/web-push";

interface Body {
  secret?: string;
}

// Internal endpoint hit by the email-worker's cron once per minute. Walks
// `calendar_event_reminders × calendar_events`, fan-outs Web Push to every
// subscription owned by the event's user, then stamps `calendar_reminders_sent`
// to dedupe.
//
// Auth: shared INTERNAL_SECRET. The service binding is private — external
// callers can't reach this in production. Pattern mirrors dispatch-scheduled.
export async function POST(req: NextRequest) {
  try {
    const env = getEnv() as unknown as {
      INTERNAL_SECRET?: string;
      VAPID_PUBLIC_KEY?: string;
      VAPID_PRIVATE_KEY?: string;
      VAPID_SUBJECT?: string;
    };
    const expected = env.INTERNAL_SECRET;
    if (!expected) {
      return NextResponse.json(
        { error: "internal_secret_not_configured" },
        { status: 500 },
      );
    }
    const b = (await req.json().catch(() => null)) as Body | null;
    if (b?.secret !== expected) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const nowSecs = Math.floor(Date.now() / 1000);
    const due = await listDueReminders(nowSecs);
    if (due.length === 0) {
      return NextResponse.json({ ok: true, sent: 0, dispatched: 0 });
    }

    // Group by user_id. When a single user has 2+ reminders firing in this
    // tick we send one aggregated push instead of N individual ones (issue
    // #85 — "3 events in the next hour"). Single-reminder users get the
    // per-event payload.
    const byUser = new Map<string, DueReminderRow[]>();
    for (const row of due) {
      const list = byUser.get(row.user_id);
      if (list) list.push(row);
      else byUser.set(row.user_id, [row]);
    }

    // VAPID keys gate the actual push send. Without them we still mark
    // reminders as sent so we don't accumulate a forever-pending backlog
    // (and so a later VAPID provisioning doesn't fire stale notifications);
    // the work logged here lets an operator see what *would* have shipped.
    const vapid: VapidConfig | null =
      env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT
        ? {
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: env.VAPID_PRIVATE_KEY,
            subject: env.VAPID_SUBJECT,
          }
        : null;

    let dispatched = 0;
    let pushed = 0;

    // Iterate users sequentially but fan-out per user's subscriptions in
    // parallel via Promise.allSettled inside dispatchForUser. The cron tick
    // budget is short — we'd rather process more users serially than chew up
    // round-trip time on per-user concurrency.
    for (const [userId, rows] of byUser) {
      try {
        const sent = await dispatchForUser(userId, rows, vapid, nowSecs);
        pushed += sent;
        dispatched += rows.length;
      } catch (e) {
        console.error(`dispatch-reminders: user ${userId} failed`, e);
      }
    }

    return NextResponse.json({ ok: true, dispatched, pushed, due: due.length });
  } catch (e) {
    console.error("dispatch-reminders crashed", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

// Send (or stub-log) all due reminders for a single user. Returns the number
// of push deliveries actually attempted (count of subscription rows × 1
// payload, since we aggregate when multiple reminders are due).
async function dispatchForUser(
  userId: string,
  rows: DueReminderRow[],
  vapid: VapidConfig | null,
  nowSecs: number,
): Promise<number> {
  const subs = await listSubscriptionsForUser(userId);
  const payload =
    rows.length === 1
      ? singleReminderPayload(rows[0])
      : aggregateReminderPayload(rows);

  // No subscriptions on file: nothing to deliver. We still stamp the dedupe
  // rows so the reminder doesn't keep matching the lookahead window forever
  // — a user who registers a subscription tomorrow shouldn't get yesterday's
  // 10-minute warning. Same rationale for the "no VAPID" branch below.
  if (subs.length === 0) {
    for (const r of rows) await markReminderSent(r.event_id, r.minutes_before, nowSecs);
    console.log(
      `reminders: user=${userId} reminders=${rows.length} subs=0 (no devices, marked sent)`,
    );
    return 0;
  }

  if (!vapid) {
    // TODO: VAPID secrets aren't provisioned in this environment. Log what
    // would have shipped so an operator can verify the cron is wiring up
    // before turning push on. We still mark the rows sent — see comment
    // above for the "stale reminder firing on first VAPID provision" risk.
    for (const r of rows) await markReminderSent(r.event_id, r.minutes_before, nowSecs);
    console.log(
      `reminders: user=${userId} reminders=${rows.length} subs=${subs.length} ` +
        `payload=${JSON.stringify(payload).slice(0, 200)} (vapid_not_configured, stub)`,
    );
    return 0;
  }

  // Real push fan-out. Run subscription deliveries in the background so the
  // cron tick returns promptly; waitUntil keeps the worker alive long enough
  // to finish them.
  const ctx = getCtx();
  const sendCount = subs.length;
  ctx.waitUntil(fanOutToSubs(subs, payload, vapid));
  for (const r of rows) await markReminderSent(r.event_id, r.minutes_before, nowSecs);
  return sendCount;
}

async function fanOutToSubs(
  subs: UserPushSub[],
  payload: object,
  vapid: VapidConfig,
): Promise<void> {
  await Promise.allSettled(
    subs.map(async (s) => {
      try {
        const res = await sendPush(s, payload, vapid);
        if (res.status === 404 || res.status === 410) {
          await pruneSubscription(s.endpoint);
          return;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          console.warn(
            `reminder push ${res.status} ${s.endpoint}: ${text.slice(0, 200)}`,
          );
          return;
        }
        await markSubscriptionUsed(s.endpoint);
      } catch (e) {
        console.warn("reminder push threw", e);
      }
    }),
  );
}
