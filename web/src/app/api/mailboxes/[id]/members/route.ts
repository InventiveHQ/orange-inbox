import { NextRequest, NextResponse } from "next/server";
import { ForbiddenError, UnauthenticatedError, requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { findOrCreateUserByEmail, listMailboxMembers } from "@/lib/mailbox-access";
import { sendInvitationEmail } from "@/lib/invitations";

const VALID_ROLES = new Set(["owner", "member", "reader"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin();
    const { id: mailboxId } = await ctx.params;
    const members = await listMailboxMembers(mailboxId);
    return NextResponse.json({ members });
  } catch (e) {
    return errorResponse(e);
  }
}

interface InviteBody {
  email?: string;
  role?: string;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireAdmin();
    const { id: mailboxId } = await ctx.params;

    const b = (await req.json().catch(() => null)) as InviteBody | null;
    const email = b?.email?.trim().toLowerCase();
    const role = b?.role ?? "member";
    if (!email || !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "invalid email" }, { status: 400 });
    }
    if (!VALID_ROLES.has(role)) {
      return NextResponse.json({ error: "invalid role" }, { status: 400 });
    }

    const target = await findOrCreateUserByEmail(email);

    // Last-owner guard: catches *demotions* too. If we're about to change an
    // existing owner's role to something other than 'owner' AND they're the
    // only owner left, refuse. The dedicated DELETE handler covers self-
    // removal; this covers re-inviting yourself (or anyone) at member/reader.
    if (role !== "owner") {
      const existing = await getDb()
        .prepare(
          "SELECT role FROM user_mailbox_access WHERE user_id = ? AND mailbox_id = ?",
        )
        .bind(target.id, mailboxId)
        .first<{ role: string }>();
      if (existing?.role === "owner") {
        const others = await getDb()
          .prepare(
            `SELECT COUNT(*) AS n FROM user_mailbox_access
              WHERE mailbox_id = ? AND role = 'owner' AND user_id != ?`,
          )
          .bind(mailboxId, target.id)
          .first<{ n: number }>();
        if (!others || others.n === 0) {
          return NextResponse.json(
            { error: "cannot_demote_last_owner" },
            { status: 409 },
          );
        }
      }
    }

    // INSERT-or-replace so re-inviting an existing member updates their role
    // instead of returning 409.
    await getDb()
      .prepare(
        `INSERT INTO user_mailbox_access (user_id, mailbox_id, role)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id, mailbox_id) DO UPDATE SET role = excluded.role`,
      )
      .bind(target.id, mailboxId, role)
      .run();

    // Best-effort heads-up email when this is a brand-new user. Failures are
    // logged inside sendInvitationEmail; the invite itself is already
    // committed by this point so we never block the response on delivery.
    if (target.created) {
      try {
        await sendInvitationEmail({
          inviterId: user.id,
          inviteeEmail: email,
          mailboxId,
          role: role as "owner" | "member" | "reader",
        });
      } catch (e) {
        console.warn("invitation email path threw", e);
      }
    }

    return NextResponse.json(
      { user_id: target.id, email, role, was_new_user: target.created },
      { status: target.created ? 201 : 200 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}

function errorResponse(e: unknown) {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (e instanceof ForbiddenError) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  console.error(e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
