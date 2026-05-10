import { NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb, getEnv } from "@/lib/db";

// Stream an attachment from R2. Auth-gates by walking the FK chain
// (attachment -> message -> mailbox -> user_mailbox_access).
//
// Executable / dangerous attachments are double-gated: the response is
// already Content-Disposition: attachment (no inline rendering), AND the
// caller must pass `?confirmed=1` to indicate the user accepted the
// "I know what I'm doing" prompt in the UI. Without that flag we 403 with a
// JSON body the client can use to drive the confirm modal.
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;

    const row = await getDb()
      .prepare(
        `SELECT a.id, a.filename, a.content_type, a.r2_key, a.is_executable
           FROM attachments a
           INNER JOIN messages m ON m.id = a.message_id
           INNER JOIN user_mailbox_access uma ON uma.mailbox_id = m.mailbox_id
          WHERE a.id = ? AND uma.user_id = ?
          LIMIT 1`,
      )
      .bind(id, user.id)
      .first<{
        id: string;
        filename: string | null;
        content_type: string | null;
        r2_key: string;
        is_executable: number;
      }>();
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

    if (row.is_executable === 1) {
      const url = new URL(req.url);
      if (url.searchParams.get("confirmed") !== "1") {
        return NextResponse.json(
          {
            error: "executable_blocked",
            filename: row.filename,
            message:
              "This attachment is flagged as executable. Re-request with ?confirmed=1 after the user explicitly opts in.",
          },
          { status: 403 },
        );
      }
    }

    const obj = await getEnv().ATTACHMENTS.get(row.r2_key);
    if (!obj) return NextResponse.json({ error: "missing_blob" }, { status: 404 });

    const filename = row.filename || "attachment";
    return new Response(obj.body, {
      status: 200,
      headers: {
        "Content-Type": row.content_type || "application/octet-stream",
        "Content-Disposition": `attachment; ${rfc5987Disposition(filename)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

// Build a Content-Disposition filename param that's safe for non-ASCII
// (RFC 5987) with an ASCII fallback. Quotes/backslashes in the legacy
// `filename=` are escaped; everything else is percent-encoded for `filename*`.
function rfc5987Disposition(name: string): string {
  const ascii = name
    .replace(/[\\"]/g, "_")
    .replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()]/g, escape);
  return `filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
