import { NextRequest, NextResponse } from "next/server";
import { getCtx, getEnv } from "@/lib/db";
import {
  listSubscriptionsForMailbox,
  markSubscriptionUsed,
  pruneSubscription,
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

    const subs = await listSubscriptionsForMailbox(b.mailboxId);
    if (subs.length === 0) return NextResponse.json({ ok: true, sent: 0 });

    const title = b.fromName?.trim() || b.fromAddr || "New mail";
    const body = (b.subject || "(no subject)").slice(0, 140);
    const url = b.threadId ? `/inbox/${b.mailboxId}#thread-${b.threadId}` : `/inbox/${b.mailboxId}`;
    const payload = {
      title,
      body,
      mailboxId: b.mailboxId,
      threadId: b.threadId,
      messageId: b.messageId,
      url,
    };

    // Don't block the email-worker on every push round-trip; do the fan-out
    // in the background. Returns immediately.
    getCtx().waitUntil(fanOut(subs, payload, vapid));
    return NextResponse.json({ ok: true, sent: subs.length });
  } catch (e) {
    console.error("notify-new-message error", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

async function fanOut(
  subs: Awaited<ReturnType<typeof listSubscriptionsForMailbox>>,
  payload: object,
  vapid: VapidConfig,
) {
  await Promise.allSettled(
    subs.map(async (s) => {
      try {
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
