import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getMailDbForThread } from "@/lib/mail-db";
import { getThreadDetail } from "@/lib/queries";
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
  muted?: boolean;
}

// Toggle thread-level state: star, archive, read. Source of truth for
// listing now lives on threads_index in the control DB; per-message read
// flags still live in the thread's mail DB, so we update both — control
// for the inbox row, mail DB for the per-message reader UI.
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

    // threads_index update — assemble a single SET clause of every field
    // that changed.
    const indexUpdates: string[] = [];
    const indexBinds: unknown[] = [];
    if (typeof b.starred === "boolean") {
      indexUpdates.push("starred = ?");
      indexBinds.push(b.starred ? 1 : 0);
    }
    if (typeof b.archived === "boolean") {
      indexUpdates.push("archived = ?");
      indexBinds.push(b.archived ? 1 : 0);
    }
    if (typeof b.read === "boolean") {
      // Marking read zeroes unread_count. Marking unread bumps it to at
      // least 1 so the inbox row goes back to bold.
      indexUpdates.push(b.read ? "unread_count = 0" : "unread_count = MAX(unread_count, 1)");
    }
    if (typeof b.muted === "boolean") {
      indexUpdates.push("muted = ?");
      indexBinds.push(b.muted ? 1 : 0);
    }

    if (indexUpdates.length === 0) {
      return NextResponse.json({ error: "no_changes" }, { status: 400 });
    }

    indexBinds.push(id);
    await db
      .prepare(`UPDATE threads_index SET ${indexUpdates.join(", ")} WHERE thread_id = ?`)
      .bind(...indexBinds)
      .run();

    // Per-message read flag lives in the thread's mail DB. Only flip it
    // when explicitly marking-read; marking-unread leaves messages alone.
    if (b.read === true) {
      const mailDb = await getMailDbForThread(id);
      await mailDb
        .prepare("UPDATE messages SET read = 1 WHERE thread_id = ? AND read = 0")
        .bind(id)
        .run();
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

// Hard delete. Tombstones R2 objects, deletes the mail-DB threads row
// (cascades to messages, attachments, message_labels in that DB), and
// cleans up control-DB satellites: threads_index, thread_locations,
// thread_labels.
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

    const controlDb = getDb();
    const mailDb = await getMailDbForThread(id);

    // R2 keys to tombstone. We have to materialise them from the mail DB
    // first (cross-DB INSERT...SELECT doesn't work in D1) and then enqueue
    // them as plain INSERTs against r2_tombstones in the control DB.
    const [rawRows, htmlRows, attachmentRows] = await Promise.all([
      mailDb
        .prepare("SELECT raw_r2_key FROM messages WHERE thread_id = ?")
        .bind(id)
        .all<{ raw_r2_key: string }>(),
      mailDb
        .prepare(
          "SELECT html_r2_key FROM messages WHERE thread_id = ? AND html_r2_key IS NOT NULL",
        )
        .bind(id)
        .all<{ html_r2_key: string }>(),
      mailDb
        .prepare(
          `SELECT a.r2_key FROM attachments a
             INNER JOIN messages m ON m.id = a.message_id
            WHERE m.thread_id = ?`,
        )
        .bind(id)
        .all<{ r2_key: string }>(),
    ]);

    const tombstoneInserts: D1PreparedStatement[] = [];
    for (const r of rawRows.results ?? []) {
      tombstoneInserts.push(
        controlDb
          .prepare("INSERT INTO r2_tombstones (bucket, r2_key) VALUES ('RAW_MAIL', ?)")
          .bind(r.raw_r2_key),
      );
    }
    for (const r of htmlRows.results ?? []) {
      tombstoneInserts.push(
        controlDb
          .prepare("INSERT INTO r2_tombstones (bucket, r2_key) VALUES ('RAW_MAIL', ?)")
          .bind(r.html_r2_key),
      );
    }
    for (const r of attachmentRows.results ?? []) {
      tombstoneInserts.push(
        controlDb
          .prepare("INSERT INTO r2_tombstones (bucket, r2_key) VALUES ('ATTACHMENTS', ?)")
          .bind(r.r2_key),
      );
    }

    // Mail-DB delete (cascades messages, attachments, message_labels in
    // that DB).
    await mailDb.prepare("DELETE FROM threads WHERE id = ?").bind(id).run();

    // Control-DB cleanup: tombstones first (so the sweeper has work to do),
    // then the satellite indexes.
    await controlDb.batch([
      ...tombstoneInserts,
      controlDb.prepare("DELETE FROM thread_labels WHERE thread_id = ?").bind(id),
      controlDb.prepare("DELETE FROM thread_locations WHERE thread_id = ?").bind(id),
      controlDb.prepare("DELETE FROM threads_index WHERE thread_id = ?").bind(id),
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
