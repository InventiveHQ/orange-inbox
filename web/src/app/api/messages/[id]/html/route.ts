import { NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb, getEnv } from "@/lib/db";

// Streams the HTML body of a message from R2. The HTML is loaded into a
// sandboxed iframe by ThreadView, never spliced into the main document.
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;

    // Auth: the user must have any role on the message's mailbox.
    const row = await getDb()
      .prepare(
        `SELECT m.html_r2_key
           FROM messages m
           INNER JOIN user_mailbox_access uma ON uma.mailbox_id = m.mailbox_id
          WHERE m.id = ? AND uma.user_id = ?
          LIMIT 1`,
      )
      .bind(id, user.id)
      .first<{ html_r2_key: string | null }>();
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (!row.html_r2_key) return NextResponse.json({ error: "no_html" }, { status: 404 });

    const obj = await getEnv().RAW_MAIL.get(row.html_r2_key);
    if (!obj) return NextResponse.json({ error: "missing_blob" }, { status: 404 });

    return new Response(obj.body, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Belt-and-braces: the iframe sandbox is the real boundary, but we
        // also force browsers not to sniff this into something executable.
        "X-Content-Type-Options": "nosniff",
        // This route serves attacker-controlled inbound email HTML from the
        // app's own origin. The normal render path wraps it in a sandboxed
        // iframe, but a direct top-level navigation here would otherwise run
        // any script in the email. This CSP neutralizes inline and loaded
        // scripts regardless of how the document is loaded, while still
        // allowing the inline styles and data:/https: images that legitimate
        // email HTML relies on.
        "Content-Security-Policy":
          "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; sandbox",
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
