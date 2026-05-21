import { NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb, getEnv } from "@/lib/db";

// Streams the raw source of a message ("Show original" — Gmail-style) so the
// user can review headers, MIME structure, SPF/DKIM/DMARC stamps, etc.
//
// Inbound mail is stored verbatim as a .eml in RAW_MAIL; we serve it as
// text/plain so the browser renders it inline rather than prompting a
// download. Outbound mail isn't archived as MIME (the send_email binding
// doesn't surface the bytes it built), so we synthesize a readable
// representation from the JSON archive we did persist.
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;

    const row = await getDb()
      .prepare(
        `SELECT m.raw_r2_key, m.direction, m.message_id_header, m.subject, m.date,
                m.from_addr, m.from_name, m.to_json, m.cc_json, m.bcc_json
           FROM messages m
           INNER JOIN user_mailbox_access uma ON uma.mailbox_id = m.mailbox_id
          WHERE m.id = ? AND uma.user_id = ?
          LIMIT 1`,
      )
      .bind(id, user.id)
      .first<{
        raw_r2_key: string;
        direction: "inbound" | "outbound";
        message_id_header: string;
        subject: string | null;
        date: number;
        from_addr: string;
        from_name: string | null;
        to_json: string;
        cc_json: string | null;
        bcc_json: string | null;
      }>();
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const obj = await getEnv().RAW_MAIL.get(row.raw_r2_key);
    if (!obj) return NextResponse.json({ error: "missing_blob" }, { status: 404 });

    const baseHeaders: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      // This route serves attacker-controlled message source from the app's
      // own origin. It's sent as text/plain so it shouldn't execute, but as
      // defense-in-depth we add a restrictive CSP so it cannot run script
      // even if the content type were ever misinterpreted on direct
      // navigation.
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    };

    if (row.direction === "inbound") {
      // Stored as message/rfc822 verbatim — pass through.
      return new Response(obj.body, { status: 200, headers: baseHeaders });
    }

    // Outbound: archive is a JSON blob; format the structured fields plus any
    // extra headers we attached at send time so the user sees the same shape
    // regardless of direction.
    const archive = (await obj.json()) as {
      from: string | { name: string; email: string };
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      text: string;
      html: string | null;
      headers?: Record<string, string>;
      sentAt: number;
    };
    return new Response(formatOutboundArchive(archive, row.message_id_header), {
      status: 200,
      headers: baseHeaders,
    });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

function formatOutboundArchive(
  a: {
    from: string | { name: string; email: string };
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    text: string;
    html: string | null;
    headers?: Record<string, string>;
    sentAt: number;
  },
  messageIdHeader: string,
): string {
  const fromStr = typeof a.from === "string" ? a.from : `${a.from.name} <${a.from.email}>`;
  const lines: string[] = [];
  lines.push(`Message-ID: <${messageIdHeader}>`);
  lines.push(`Date: ${new Date(a.sentAt * 1000).toUTCString()}`);
  lines.push(`From: ${fromStr}`);
  lines.push(`To: ${a.to.join(", ")}`);
  if (a.cc?.length) lines.push(`Cc: ${a.cc.join(", ")}`);
  if (a.bcc?.length) lines.push(`Bcc: ${a.bcc.join(", ")}`);
  lines.push(`Subject: ${a.subject}`);
  for (const [k, v] of Object.entries(a.headers ?? {})) {
    lines.push(`${k}: ${v}`);
  }
  lines.push("");
  lines.push(a.text);
  if (a.html) {
    lines.push("");
    lines.push("--- HTML body ---");
    lines.push(a.html);
  }
  return lines.join("\r\n");
}
