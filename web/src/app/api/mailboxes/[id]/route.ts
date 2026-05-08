import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isDomainAdmin, isMailboxOwner } from "@/lib/mailbox-access";
import { tombstoneStatementsForMailbox } from "@/lib/r2-tombstones";

const LOCAL_PART_RE = /^[a-z0-9._+\-]+$/i;

interface PatchBody {
  local_part?: string;
  display_name?: string | null;
  is_catch_all?: boolean;
  signature_html?: string | null;
}

// Hard cap so a runaway editor can't blow up the row.
const MAX_SIGNATURE_BYTES = 8 * 1024;

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

async function checkAllowed(userId: string, mailboxId: string, domainId: string) {
  return (await isMailboxOwner(userId, mailboxId)) || (await isDomainAdmin(userId, domainId));
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: mailboxId } = await ctx.params;
    const mb = await loadMailbox(mailboxId);
    if (!mb) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (!(await checkAllowed(user.id, mailboxId, mb.domain_id))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

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

    if (b.signature_html !== undefined) {
      const sig = b.signature_html == null ? null : String(b.signature_html);
      if (sig != null && sig.length > MAX_SIGNATURE_BYTES) {
        return NextResponse.json({ error: "signature too long" }, { status: 400 });
      }
      updates.push("signature_html = ?");
      // Empty string normalises to null so we don't store noise.
      binds.push(sig && sig.trim() ? sig : null);
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
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

// Owner of the mailbox or admin of its parent domain may delete it.
// ON DELETE CASCADE handles the row tree (threads → messages → attachments
// → labels). R2 bytes get tombstoned in the same batch; the email-worker
// cron sweeps them.
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: mailboxId } = await ctx.params;

    const mb = await loadMailbox(mailboxId);
    if (!mb) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (!(await checkAllowed(user.id, mailboxId, mb.domain_id))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const db = getDb();
    await db.batch([
      ...tombstoneStatementsForMailbox(mailboxId),
      db.prepare("DELETE FROM mailboxes WHERE id = ?").bind(mailboxId),
    ]);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
