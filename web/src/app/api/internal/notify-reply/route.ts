import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb, getEnv } from "@/lib/db";
import { getMailDbForThread } from "@/lib/mail-db";
import { SendError, sendMessage } from "@/lib/send";

// Inline-reply endpoint hit by the service worker after the user types a
// reply into a push notification's text input (Android Chrome's
// `notificationclick` with action === 'reply'). The SW POSTs same-origin
// from the user's device, so it carries the Cloudflare Access cookie — the
// route authenticates as that user via `requireUser()` exactly like the
// regular /api/messages POST does.
//
// An optional INTERNAL_SECRET shared-secret header is accepted as a fallback
// for environments where the SW can't pass Access cookies (e.g. some
// browser-managed push contexts) — present only if the deployment has set
// the secret. Default is user-cookie auth.
//
// Filed under /api/internal/ because it isn't part of the user-facing API
// surface — it's an SW-only escape hatch.
interface Body {
  threadId?: string;
  body?: string;
  internal_secret?: string;
}

export async function POST(req: NextRequest) {
  try {
    const env = getEnv() as unknown as { INTERNAL_SECRET?: string };
    const b = (await req.json().catch(() => null)) as Body | null;
    if (!b?.threadId || !b.body) {
      return NextResponse.json({ error: "thread_id_and_body_required" }, { status: 400 });
    }
    // Cap body length to mirror Android's reply field; longer pastes can use
    // the full composer.
    if (b.body.length > 4000) {
      return NextResponse.json({ error: "body_too_long" }, { status: 400 });
    }

    // Prefer cookie auth (the SW carries it); fall back to the shared
    // secret if the deployment configured one and the SW supplied it.
    let userId: string;
    try {
      const user = await requireUser();
      userId = user.id;
    } catch (e) {
      if (
        env.INTERNAL_SECRET &&
        (b.internal_secret === env.INTERNAL_SECRET ||
          req.headers.get("x-internal-secret") === env.INTERNAL_SECRET)
      ) {
        // INTERNAL_SECRET path can't know which user — bail with 401 since
        // there's no way to resolve a sender. Documented as cookie-only in
        // practice.
        return NextResponse.json({ error: "secret_auth_requires_user" }, { status: 401 });
      }
      throw e;
    }

    // Resolve the thread → its mail DB → mailbox_id + most-recent inbound
    // message in this user's view (used as the reply parent for threading).
    const mailDb = await getMailDbForThread(b.threadId);
    const thread = await mailDb
      .prepare(
        `SELECT id, mailbox_id FROM threads WHERE id = ?`,
      )
      .bind(b.threadId)
      .first<{ id: string; mailbox_id: string }>();
    if (!thread) return NextResponse.json({ error: "thread_not_found" }, { status: 404 });

    // Confirm the user has access to the mailbox the thread lives in. We
    // do this with a direct join against user_mailbox_access on the control
    // DB rather than re-using listMailboxesForUser (which would over-fetch).
    const access = await getDb()
      .prepare(
        `SELECT role FROM user_mailbox_access WHERE user_id = ? AND mailbox_id = ?`,
      )
      .bind(userId, thread.mailbox_id)
      .first<{ role: string }>();
    if (!access) {
      return NextResponse.json({ error: "no_access" }, { status: 403 });
    }
    if (access.role === "reader") {
      return NextResponse.json({ error: "read_only" }, { status: 403 });
    }

    // Pick the parent message: most recent inbound message in this thread
    // (i.e. not authored by the current user's own mailbox). Falls back to
    // the most recent message of any kind if no inbound exists — keeps the
    // thread chain intact either way.
    const parent = await pickReplyParent(mailDb, b.threadId);

    // Recover the original sender as the To: address for the reply. If we
    // can't read it from the parent envelope (legacy rows without
    // from_addr), fall back to an inbound from_addr scan.
    const recipient = await pickReplyRecipient(mailDb, b.threadId, parent?.id ?? null);
    if (!recipient) {
      return NextResponse.json({ error: "no_recipient" }, { status: 400 });
    }

    const { messageId } = await sendMessage(userId, {
      fromMailboxId: thread.mailbox_id,
      to: [recipient],
      subject: parent?.subject_normalized
        ? prefixSubjectWithRe(parent.subject_normalized)
        : "Re: (inline reply)",
      body: b.body,
      replyToMessageId: parent?.id,
    });

    return NextResponse.json({ ok: true, messageId });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (e instanceof SendError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    console.error("notify-reply error", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

async function pickReplyParent(
  mailDb: D1Database,
  threadId: string,
): Promise<{ id: string; subject_normalized: string | null } | null> {
  // Prefer the most-recent inbound message (direction='in') so we reply to
  // the right party. Fall back to any-direction if the thread has only
  // outbound messages somehow.
  const inbound = await mailDb
    .prepare(
      `SELECT m.id, t.subject_normalized
         FROM messages m
         LEFT JOIN threads t ON t.id = m.thread_id
        WHERE m.thread_id = ? AND m.direction = 'inbound'
        ORDER BY m.date DESC
        LIMIT 1`,
    )
    .bind(threadId)
    .first<{ id: string; subject_normalized: string | null }>();
  if (inbound) return inbound;
  const any = await mailDb
    .prepare(
      `SELECT m.id, t.subject_normalized
         FROM messages m
         LEFT JOIN threads t ON t.id = m.thread_id
        WHERE m.thread_id = ?
        ORDER BY m.date DESC
        LIMIT 1`,
    )
    .bind(threadId)
    .first<{ id: string; subject_normalized: string | null }>();
  return any ?? null;
}

async function pickReplyRecipient(
  mailDb: D1Database,
  threadId: string,
  parentMessageId: string | null,
): Promise<string | null> {
  if (parentMessageId) {
    const row = await mailDb
      .prepare(
        `SELECT from_addr FROM messages WHERE id = ? AND direction = 'inbound'`,
      )
      .bind(parentMessageId)
      .first<{ from_addr: string | null }>();
    if (row?.from_addr) return row.from_addr;
  }
  // Fall back to the most recent inbound sender in the thread.
  const row = await mailDb
    .prepare(
      `SELECT from_addr FROM messages
        WHERE thread_id = ? AND direction = 'inbound' AND from_addr IS NOT NULL
        ORDER BY date DESC LIMIT 1`,
    )
    .bind(threadId)
    .first<{ from_addr: string | null }>();
  return row?.from_addr ?? null;
}

function prefixSubjectWithRe(subject: string): string {
  const trimmed = subject.trim();
  if (/^re\s*:/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
}
