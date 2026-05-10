import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb, getEnv } from "@/lib/db";
import { getActiveMailDbs } from "@/lib/mail-db";

// .mbox export.
//
// Streams every message the user can read into a single mbox file. Inbound
// mail is stored as raw RFC822 in RAW_MAIL — we pass those bytes straight
// through. Outbound mail is stored as a JSON archive (since the send_email
// binding never surfaces the bytes it built); we synthesize a plausible
// RFC822 representation for those.
//
// Mbox format ("mboxrd" variant — the safe one):
//   - Each message begins with a "From " line (no colon) followed by the
//     envelope sender and a date.
//   - Inside the message body, any line beginning with one or more `>`
//     followed by `From ` is escaped by prepending another `>`.
//   - Messages are separated by a blank line.
//
// Performance: streaming via ReadableStream so the worker doesn't buffer
// the whole archive. R2 fetches are sequential — fan-out would be faster
// but risks blowing through subrequest limits on large mailboxes.
//
// Scope:
//   ?mailbox_id=<id>   — single mailbox the user has access to
//   (no param)         — every mailbox the user has access to

interface Row {
  id: string;
  mailbox_id: string;
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
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const requestedMailbox = req.nextUrl.searchParams.get("mailbox_id");

    // Validate the user's access to the requested mailbox (or to ANY
    // mailbox if no scope was given).
    const accessSql = requestedMailbox
      ? `SELECT mb.id, mb.local_part, d.name AS domain_name
           FROM mailboxes mb
           INNER JOIN domains d ON d.id = mb.domain_id
           INNER JOIN user_mailbox_access uma
             ON uma.mailbox_id = mb.id AND uma.user_id = ?
          WHERE mb.id = ? LIMIT 1`
      : `SELECT mb.id, mb.local_part, d.name AS domain_name
           FROM mailboxes mb
           INNER JOIN domains d ON d.id = mb.domain_id
           INNER JOIN user_mailbox_access uma
             ON uma.mailbox_id = mb.id AND uma.user_id = ?`;

    const accessBinds: unknown[] = requestedMailbox
      ? [user.id, requestedMailbox]
      : [user.id];

    const { results: mailboxes } = await getDb()
      .prepare(accessSql)
      .bind(...accessBinds)
      .all<{ id: string; local_part: string; domain_name: string }>();

    if (!mailboxes || mailboxes.length === 0) {
      return NextResponse.json(
        { error: requestedMailbox ? "mailbox_not_found_or_no_access" : "no_mailboxes" },
        { status: 404 },
      );
    }

    const mailboxIds = mailboxes.map(mb => mb.id);

    // Fan out across all mail DBs (the user's threads can live in any of
    // them). For each, pull every message in the requested mailboxes.
    const mailDbs = await getActiveMailDbs();
    const rowsPerDb: Row[][] = await Promise.all(
      mailDbs.map(async ({ db }) => {
        const placeholders = mailboxIds.map(() => "?").join(",");
        const { results } = await db
          .prepare(
            `SELECT id, mailbox_id, raw_r2_key, direction, message_id_header,
                    subject, date, from_addr, from_name, to_json, cc_json, bcc_json
               FROM messages
              WHERE mailbox_id IN (${placeholders})
              ORDER BY date ASC`,
          )
          .bind(...mailboxIds)
          .all<Row>();
        return results ?? [];
      }),
    );
    const rows = rowsPerDb.flat().sort((a, b) => a.date - b.date);

    if (rows.length === 0) {
      return new Response("", {
        status: 200,
        headers: mboxHeaders(filenameFor(mailboxes, rows.length)),
      });
    }

    const env = getEnv();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          for (const row of rows) {
            const sep = mboxSeparator(row);
            controller.enqueue(encoder.encode(sep));
            await streamRow(env, row, controller, encoder);
            controller.enqueue(encoder.encode("\r\n"));
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: mboxHeaders(filenameFor(mailboxes, rows.length)),
    });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

function mboxHeaders(filename: string): Record<string, string> {
  return {
    "Content-Type": "application/mbox",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  };
}

function filenameFor(
  mailboxes: { local_part: string; domain_name: string }[],
  count: number,
): string {
  const stamp = new Date().toISOString().slice(0, 10);
  if (mailboxes.length === 1) {
    const mb = mailboxes[0];
    return `${mb.local_part}_at_${mb.domain_name}-${stamp}-${count}msgs.mbox`;
  }
  return `orange-inbox-${stamp}-${count}msgs.mbox`;
}

// "From " line for the mbox separator. Format is loose by convention but
// we follow the most common shape: `From <envelope-from> <ctime-style date>`.
function mboxSeparator(row: Row): string {
  const date = new Date(row.date * 1000);
  // Asctime-style date, e.g. "Fri May  9 10:00:00 2026"
  const asctime = date
    .toUTCString()
    .replace(/^[^,]+, /, "")             // drop "Fri, "
    .replace(/(\d+) ([A-Z][a-z]+) (\d+) (\d+:\d+:\d+) GMT/, "$2 $1 $4 $3");
  const from = row.from_addr || "MAILER-DAEMON";
  return `From ${from} ${asctime}\r\n`;
}

// Stream the body of a message into the controller, applying mboxrd
// "From "-line escaping. For inbound we pass through the raw RFC822 bytes;
// for outbound we synthesize a plausible RFC822 from the JSON archive.
async function streamRow(
  env: { RAW_MAIL: R2Bucket },
  row: Row,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): Promise<void> {
  const obj = await env.RAW_MAIL.get(row.raw_r2_key);
  if (!obj) {
    // Missing blob — note it in the export so the user sees the gap rather
    // than a silent truncation. The message metadata is still useful.
    controller.enqueue(
      encoder.encode(
        synthesizeHeaders(row) +
          "\r\n[orange-inbox: raw body missing from R2 — metadata only]\r\n",
      ),
    );
    return;
  }

  if (row.direction === "outbound") {
    // Outbound: archive is JSON; build a plausible RFC822.
    const archive = (await obj.json()) as OutboundArchive;
    const text = renderOutbound(archive, row);
    controller.enqueue(encoder.encode(escapeFromLines(text)));
    return;
  }

  // Inbound: raw RFC822 stream — escape "From " lines as we go. We pull the
  // whole body in as text first because mboxrd escaping is line-based and
  // RFC822 content is small enough (sub-megabyte typical) that a per-message
  // buffer is fine.
  const text = await obj.text();
  controller.enqueue(encoder.encode(escapeFromLines(text)));
}

interface OutboundArchive {
  from: string | { name: string; email: string };
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html: string | null;
  headers?: Record<string, string>;
  sentAt: number;
}

function renderOutbound(a: OutboundArchive, row: Row): string {
  const fromStr = typeof a.from === "string" ? a.from : `${a.from.name} <${a.from.email}>`;
  const lines: string[] = [];
  lines.push(`Message-ID: ${ensureBracketed(row.message_id_header)}`);
  lines.push(`Date: ${new Date(a.sentAt * 1000).toUTCString()}`);
  lines.push(`From: ${fromStr}`);
  lines.push(`To: ${a.to.join(", ")}`);
  if (a.cc?.length) lines.push(`Cc: ${a.cc.join(", ")}`);
  if (a.bcc?.length) lines.push(`Bcc: ${a.bcc.join(", ")}`);
  lines.push(`Subject: ${a.subject}`);
  lines.push(`X-orange-inbox-direction: outbound`);
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

function synthesizeHeaders(row: Row): string {
  return [
    `Message-ID: ${ensureBracketed(row.message_id_header)}`,
    `Date: ${new Date(row.date * 1000).toUTCString()}`,
    `From: ${row.from_name ? `${row.from_name} <${row.from_addr}>` : row.from_addr}`,
    `Subject: ${row.subject ?? "(no subject)"}`,
  ].join("\r\n");
}

function ensureBracketed(id: string): string {
  return id.startsWith("<") ? id : `<${id}>`;
}

// mboxrd: prefix any line that starts with optional `>`s followed by `From `
// with an extra `>`. Without this, readers would mis-split messages on body
// content that happens to begin with "From ".
function escapeFromLines(text: string): string {
  return text.replace(/^(>*From )/gm, ">$1");
}
