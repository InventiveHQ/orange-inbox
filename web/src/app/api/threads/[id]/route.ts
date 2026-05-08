import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getThreadDetail } from "@/lib/queries";
import { tombstoneStatementsForThread } from "@/lib/r2-tombstones";
import { userCanAccessThread } from "@/lib/threads-mutate";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const detail = await getThreadDetail(user.id, id);
    if (!detail) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    throw e;
  }
}

interface PatchBody {
  starred?: boolean;
  archived?: boolean;
  read?: boolean;
}

// Toggle thread-level state: star, archive, and read. The `read` flag bulk-
// updates messages.read alongside zeroing/restoring threads.unread_count
// since messages are the source of truth for unread.
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;

    if (!(await userCanAccessThread(user.id, id))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const b = (await req.json().catch(() => null)) as PatchBody | null;
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });

    const db = getDb();
    const stmts: D1PreparedStatement[] = [];

    const updates: string[] = [];
    const binds: unknown[] = [];
    if (typeof b.starred === "boolean") {
      updates.push("starred = ?");
      binds.push(b.starred ? 1 : 0);
    }
    if (typeof b.archived === "boolean") {
      updates.push("archived = ?");
      binds.push(b.archived ? 1 : 0);
    }

    if (typeof b.read === "boolean") {
      // When marking read we flip every unread message and zero the count.
      // When marking unread we leave per-message reads alone but bump the
      // counter to 1 so the inbox shows a bold row again.
      if (b.read) {
        stmts.push(
          db
            .prepare("UPDATE messages SET read = 1 WHERE thread_id = ? AND read = 0")
            .bind(id),
        );
        updates.push("unread_count = ?");
        binds.push(0);
      } else {
        updates.push("unread_count = MAX(unread_count, 1)");
      }
    }

    if (updates.length > 0) {
      binds.push(id);
      stmts.push(
        db.prepare(`UPDATE threads SET ${updates.join(", ")} WHERE id = ?`).bind(...binds),
      );
    }

    if (stmts.length === 0) {
      return NextResponse.json({ error: "no_changes" }, { status: 400 });
    }

    await db.batch(stmts);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

// Hard delete. messages, attachments rows, and message_labels cascade off
// threads. R2 bytes (raw .eml, html bodies, attachments) get tombstoned in
// the same batch as the thread delete; the email-worker cron picks them up
// and removes them from the buckets.
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;

    if (!(await userCanAccessThread(user.id, id))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const db = getDb();
    await db.batch([
      ...tombstoneStatementsForThread(id),
      db.prepare("DELETE FROM threads WHERE id = ?").bind(id),
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
