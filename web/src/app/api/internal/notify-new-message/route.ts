import { NextRequest, NextResponse } from "next/server";
import { getCtx, getDb, getEnv } from "@/lib/db";
import {
  markSubscriptionUsed,
  pruneSubscription,
  type PushSubscriptionRow,
} from "@/lib/push-subscriptions";
import { sendPush, type VapidConfig } from "@/lib/web-push";

interface Body {
  mailboxId?: string;
  threadId?: string;
  messageId?: string;
  fromAddr?: string;
  fromName?: string | null;
  subject?: string | null;
}

// Per-user subscription row used for fan-out. Carries user_id so we can
// stamp each user's own unread total onto their push payload (the badging
// shown by the SW must be the recipient's count, not a global one).
interface UserSubscriptionRow extends PushSubscriptionRow {
  user_id: string;
}

// Internal endpoint hit by the email-worker over its WEB service binding
// after a new message lands. Fans out a Web Push notification to every
// device subscribed by every user with access to the mailbox.
//
// Auth: the only barrier is a shared INTERNAL_SECRET (Worker secret). The
// service binding itself is private — external traffic can't reach this
// route in production unless someone steals the secret.
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
      return NextResponse.json({ error: "internal_secret_not_configured" }, { status: 500 });
    }
    if (req.headers.get("x-internal-secret") !== expected) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const b = (await req.json().catch(() => null)) as Body | null;
    if (!b?.mailboxId) {
      return NextResponse.json({ error: "mailbox_id_required" }, { status: 400 });
    }

    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
      // No keys → nothing to do; ack so the email-worker doesn't retry.
      return NextResponse.json({ ok: true, skipped: "vapid_not_configured" });
    }
    const vapid: VapidConfig = {
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT,
    };

    // Pull per-endpoint subscriptions joined with user_id so we can compute
    // per-user unread totals for the Badging API. Mirrors the join in
    // listSubscriptionsForMailbox but keeps the user_id column.
    const { results: subRows } = await getDb()
      .prepare(
        `SELECT ps.endpoint, ps.p256dh, ps.auth_secret, ps.user_id
           FROM push_subscriptions ps
           INNER JOIN user_mailbox_access uma ON uma.user_id = ps.user_id
          WHERE uma.mailbox_id = ?`,
      )
      .bind(b.mailboxId)
      .all<UserSubscriptionRow>();
    const subs: UserSubscriptionRow[] = subRows ?? [];
    if (subs.length === 0) return NextResponse.json({ ok: true, sent: 0 });

    // One unread-total query per distinct user_id. Sum of unread_count across
    // every non-archived thread in any mailbox the user has access to —
    // matches the Badging API expectation that the badge reflects everything
    // the user might want to triage, not just the mailbox that fired this push.
    const userIds = Array.from(new Set(subs.map((s) => s.user_id)));
    const unreadByUser = await computeUnreadTotals(userIds);

    const title = b.fromName?.trim() || b.fromAddr || "New mail";
    const body = (b.subject || "(no subject)").slice(0, 140);
    const url = b.threadId ? `/inbox/${b.mailboxId}#thread-${b.threadId}` : `/inbox/${b.mailboxId}`;
    const basePayload = {
      title,
      body,
      mailboxId: b.mailboxId,
      threadId: b.threadId,
      messageId: b.messageId,
      url,
    };

    // Don't block the email-worker on every push round-trip; do the fan-out
    // in the background. Returns immediately.
    getCtx().waitUntil(fanOut(subs, basePayload, unreadByUser, vapid));
    return NextResponse.json({ ok: true, sent: subs.length });
  } catch (e) {
    console.error("notify-new-message error", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

// Per-user unread total across every mailbox the user can see. Computed in a
// single grouped query — `userIds` is bounded by the set of subscribed users
// for one mailbox, which is small (typically 1–10).
async function computeUnreadTotals(userIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (userIds.length === 0) return out;
  const placeholders = userIds.map(() => "?").join(",");
  const { results } = await getDb()
    .prepare(
      `SELECT uma.user_id AS user_id,
              COALESCE(SUM(ti.unread_count), 0) AS unread_total
         FROM user_mailbox_access uma
         LEFT JOIN threads_index ti
           ON ti.mailbox_id = uma.mailbox_id
          AND ti.archived = 0
        WHERE uma.user_id IN (${placeholders})
        GROUP BY uma.user_id`,
    )
    .bind(...userIds)
    .all<{ user_id: string; unread_total: number }>();
  for (const r of results ?? []) {
    out.set(r.user_id, Number(r.unread_total) || 0);
  }
  // Backfill any user with no rows at all.
  for (const id of userIds) if (!out.has(id)) out.set(id, 0);
  return out;
}

async function fanOut(
  subs: UserSubscriptionRow[],
  basePayload: object,
  unreadByUser: Map<string, number>,
  vapid: VapidConfig,
) {
  await Promise.allSettled(
    subs.map(async (s) => {
      try {
        const payload = {
          ...basePayload,
          unreadTotal: unreadByUser.get(s.user_id) ?? 0,
        };
        const res = await sendPush(s, payload, vapid);
        if (res.status === 404 || res.status === 410) {
          await pruneSubscription(s.endpoint);
          return;
        }
        if (!res.ok) {
          console.warn(`push ${res.status} for ${s.endpoint}: ${(await res.text()).slice(0, 200)}`);
          return;
        }
        await markSubscriptionUsed(s.endpoint);
      } catch (e) {
        console.warn("push send threw", e);
      }
    }),
  );
}
