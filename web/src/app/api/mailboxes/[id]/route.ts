import { NextRequest, NextResponse } from "next/server";
import { ForbiddenError, UnauthenticatedError, requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { tombstoneStatementsForMailbox } from "@/lib/r2-tombstones";

const LOCAL_PART_RE = /^[a-z0-9._+\-]+$/i;

interface PatchBody {
  local_part?: string;
  display_name?: string | null;
  is_catch_all?: boolean;
}

async function loadMailbox(mailboxId: string) {
  return getDb()
    .prepare("SELECT id, domain_id, local_part, display_name, is_catch_all FROM mailboxes WHERE id = ?")
    .bind(mailboxId)
    .first<{
      id: string;
      domain_id: string;
      local_part: string;
      display_name: string | null;
      is_catch_all: number;
    }>();
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin();
    const { id: mailboxId } = await ctx.params;
    const mb = await loadMailbox(mailboxId);
    if (!mb) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const b = (await req.json().catch(() => null)) as PatchBody | null;
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });

    const updates: string[] = [];
    const binds: unknown[] = [];

    if (b.local_part !== undefined) {
      const lp = String(b.local_part).trim().toLowerCase();
      if (!LOCAL_PART_RE.test(lp)) {
        return NextResponse.json({ error: "invalid local_part" }, { status: 400 });
      }
      if (lp !== mb.local_part) {
        const dup = await getDb()
          .prepare("SELECT id FROM mailboxes WHERE domain_id = ? AND local_part = ? AND id != ?")
          .bind(mb.domain_id, lp, mailboxId)
          .first();
        if (dup) return NextResponse.json({ error: "address already in use" }, { status: 409 });
        updates.push("local_part = ?");
        binds.push(lp);
      }
    }

    if (b.display_name !== undefined) {
      const dn = b.display_name == null ? null : String(b.display_name).trim() || null;
      updates.push("display_name = ?");
      binds.push(dn);
    }

    if (b.is_catch_all !== undefined) {
      updates.push("is_catch_all = ?");
      binds.push(b.is_catch_all ? 1 : 0);
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: "no_changes" }, { status: 400 });
    }

    binds.push(mailboxId);
    await getDb()
      .prepare(`UPDATE mailboxes SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...binds)
      .run();

    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

// Admin-only mailbox deletion. ON DELETE CASCADE handles the row tree
// (threads → messages → attachments → labels). R2 bytes get tombstoned in
// the same batch; the email-worker cron sweeps them.
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin();
    const { id: mailboxId } = await ctx.params;

    const mb = await loadMailbox(mailboxId);
    if (!mb) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const db = getDb();
    await db.batch([
      ...tombstoneStatementsForMailbox(mailboxId),
      db.prepare("DELETE FROM mailboxes WHERE id = ?").bind(mailboxId),
    ]);
    return NextResponse.json({ ok: true });
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
