import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

interface AutoresponderRow {
  enabled: number;
  starts_at: number | null;
  ends_at: number | null;
  subject: string;
  body_text: string;
  body_html: string | null;
  cooldown_hours: number;
}

interface PutBody {
  enabled?: boolean;
  starts_at?: number | null;
  ends_at?: number | null;
  subject?: string;
  body_text?: string;
  body_html?: string | null;
  cooldown_hours?: number;
}

// Hard caps to keep a runaway editor from blowing up the row.
const MAX_SUBJECT = 256;
const MAX_BODY_TEXT = 16 * 1024;
const MAX_BODY_HTML = 32 * 1024;
const MIN_COOLDOWN = 1;
const MAX_COOLDOWN = 24 * 30; // 30 days

// Per-mailbox vacation responder. Owner-only — the responder sends FROM the
// mailbox identity, so allowing members or readers to flip it would let them
// effectively impersonate the mailbox. Mirror the auth shape used by
// /api/mailboxes/[id]/signature: requireUser + an explicit role check rather
// than admin-only.
async function assertOwner(userId: string, mailboxId: string): Promise<NextResponse | null> {
  const access = await getDb()
    .prepare(
      "SELECT role FROM user_mailbox_access WHERE user_id = ? AND mailbox_id = ?",
    )
    .bind(userId, mailboxId)
    .first<{ role: "owner" | "member" | "reader" }>();
  if (!access || access.role !== "owner") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return null;
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: mailboxId } = await ctx.params;
    const denied = await assertOwner(user.id, mailboxId);
    if (denied) return denied;

    const row = await getDb()
      .prepare(
        `SELECT enabled, starts_at, ends_at, subject, body_text, body_html, cooldown_hours
           FROM mailbox_autoresponders WHERE mailbox_id = ?`,
      )
      .bind(mailboxId)
      .first<AutoresponderRow>();

    if (!row) {
      return NextResponse.json({ autoresponder: null });
    }
    return NextResponse.json({
      autoresponder: {
        enabled: row.enabled === 1,
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        subject: row.subject,
        body_text: row.body_text,
        body_html: row.body_html,
        cooldown_hours: row.cooldown_hours,
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: mailboxId } = await ctx.params;
    const denied = await assertOwner(user.id, mailboxId);
    if (denied) return denied;

    const b = (await req.json().catch(() => null)) as PutBody | null;
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });

    const subject = (b.subject ?? "").trim();
    if (!subject) {
      return NextResponse.json({ error: "subject required" }, { status: 400 });
    }
    if (subject.length > MAX_SUBJECT) {
      return NextResponse.json({ error: "subject too long" }, { status: 400 });
    }

    const bodyText = (b.body_text ?? "").trim();
    if (!bodyText) {
      return NextResponse.json({ error: "body_text required" }, { status: 400 });
    }
    if (bodyText.length > MAX_BODY_TEXT) {
      return NextResponse.json({ error: "body_text too long" }, { status: 400 });
    }

    const bodyHtml =
      b.body_html == null
        ? null
        : String(b.body_html).trim() || null;
    if (bodyHtml != null && bodyHtml.length > MAX_BODY_HTML) {
      return NextResponse.json({ error: "body_html too long" }, { status: 400 });
    }

    const cooldownRaw = b.cooldown_hours ?? 24;
    const cooldown = Math.floor(Number(cooldownRaw));
    if (!Number.isFinite(cooldown) || cooldown < MIN_COOLDOWN || cooldown > MAX_COOLDOWN) {
      return NextResponse.json({ error: "cooldown_hours out of range" }, { status: 400 });
    }

    const startsAt = normalizeTimestamp(b.starts_at);
    const endsAt = normalizeTimestamp(b.ends_at);
    if (startsAt != null && endsAt != null && endsAt < startsAt) {
      return NextResponse.json({ error: "ends_at before starts_at" }, { status: 400 });
    }

    const enabled = b.enabled ? 1 : 0;

    // Upsert keyed on mailbox_id (PRIMARY KEY) — one responder row per mailbox.
    await getDb()
      .prepare(
        `INSERT INTO mailbox_autoresponders
           (mailbox_id, enabled, starts_at, ends_at, subject, body_text, body_html, cooldown_hours)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (mailbox_id) DO UPDATE SET
           enabled = excluded.enabled,
           starts_at = excluded.starts_at,
           ends_at = excluded.ends_at,
           subject = excluded.subject,
           body_text = excluded.body_text,
           body_html = excluded.body_html,
           cooldown_hours = excluded.cooldown_hours`,
      )
      .bind(mailboxId, enabled, startsAt, endsAt, subject, bodyText, bodyHtml, cooldown)
      .run();

    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: mailboxId } = await ctx.params;
    const denied = await assertOwner(user.id, mailboxId);
    if (denied) return denied;

    await getDb()
      .prepare("DELETE FROM mailbox_autoresponders WHERE mailbox_id = ?")
      .bind(mailboxId)
      .run();

    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

// Accept either a number (unix seconds) or null/undefined; rejects NaN-ish
// inputs so the column doesn't end up storing garbage.
function normalizeTimestamp(value: number | null | undefined): number | null {
  if (value == null) return null;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  return n;
}

function errorResponse(e: unknown) {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  console.error(e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
