import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  findOrCreateUserByEmail,
  isMailboxOwner,
  listMailboxMembers,
} from "@/lib/mailbox-access";

const VALID_ROLES = new Set(["owner", "member", "reader"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: mailboxId } = await ctx.params;
    if (!(await isMailboxOwner(user.id, mailboxId))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
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
    const user = await requireUser();
    const { id: mailboxId } = await ctx.params;
    if (!(await isMailboxOwner(user.id, mailboxId))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

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
  console.error(e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
