import { NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { updateRsvpStatus } from "@/lib/calendar";
import { getDb, getEnv } from "@/lib/db";
import { fullAddress } from "@/lib/identities";
import { getActiveMailDbs } from "@/lib/mail-db";

// Calendar invite RSVP (#70). The reader's CalendarEventCard POSTs here with
// `{ status: "ACCEPTED" | "TENTATIVE" | "DECLINED" }`. We compose a minimal
// RFC 5545 `text/calendar; method=REPLY` body carrying the same UID and the
// user's PARTSTAT, then hand it to env.EMAIL.send addressed to the original
// organiser.
//
// v1 scope:
//   - No external-calendar integration (Google / Apple / 365). The reply IS
//     the deliverable; the organiser's calendar service interprets it.
//   - We don't persist the user's response — page reload re-shows buttons.
//     Mirroring Gmail's pre-Calendar-write behaviour is fine here.
//   - We don't verify the user is on the ATTENDEE list. Most inviters cc
//     a wider audience; a self-RSVP is harmless and avoids parsing the
//     attendee block.

type Status = "ACCEPTED" | "TENTATIVE" | "DECLINED";

const STATUS_VALUES: readonly Status[] = ["ACCEPTED", "TENTATIVE", "DECLINED"] as const;

function isStatus(s: unknown): s is Status {
  return typeof s === "string" && (STATUS_VALUES as readonly string[]).includes(s);
}

interface RsvpBody {
  status?: unknown;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;

    const body = (await req.json().catch(() => ({}))) as RsvpBody;
    if (!isStatus(body.status)) {
      return NextResponse.json(
        { error: "invalid_status", message: "status must be ACCEPTED, TENTATIVE, or DECLINED" },
        { status: 400 },
      );
    }
    const status: Status = body.status;

    // Look up the message + its calendar row + the user's mailbox identity.
    // The message lives in some mail DB; we fan out across active DBs the
    // same way the unsubscribe flow does.
    const found = await lookupRsvpContext(user.id, id);
    if (!found) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    if (!found.organizer) {
      return NextResponse.json(
        { error: "no_organizer", message: "Invite has no organiser to reply to." },
        { status: 400 },
      );
    }
    if (!found.uid) {
      // Without a UID the organiser's calendar can't correlate the reply
      // back to their event. Refuse rather than send something that gets
      // dropped silently downstream.
      return NextResponse.json(
        { error: "no_uid", message: "Invite has no UID; can't compose a reply." },
        { status: 400 },
      );
    }

    const fromAddr = fullAddress({
      local_part: found.mailboxLocalPart,
      domain_name: found.mailboxDomainName,
    });

    const ics = buildReplyIcs({
      uid: found.uid,
      organizer: found.organizer,
      attendee: fromAddr,
      attendeeName: user.display_name,
      summary: found.summary,
      startsAt: found.startsAt,
      endsAt: found.endsAt,
      partstat: status,
    });

    const subject = subjectFor(status, found.summary);
    const text = textBodyFor(status, found.summary);

    try {
      await getEnv().EMAIL.send({
        from: user.display_name
          ? { name: user.display_name, email: fromAddr }
          : fromAddr,
        to: found.organizer,
        subject,
        text,
        // Cloudflare's send_email binding accepts an attachments array; ship
        // the iCalendar payload as `text/calendar; method=REPLY` so the
        // recipient's calendar service treats it as an attendee response
        // rather than a fresh invitation.
        attachments: [
          {
            disposition: "attachment",
            filename: "reply.ics",
            type: 'text/calendar; method=REPLY; charset="utf-8"',
            content: ics,
          },
        ],
      });
    } catch (e) {
      console.error("rsvp send failed", e);
      const detail = e instanceof Error ? e.message : String(e);
      return NextResponse.json(
        { error: "send_failed", message: `Cloudflare rejected the send: ${detail}` },
        { status: 502 },
      );
    }

    // Persist the user's RSVP on calendar_events so the buttons don't
    // re-prompt on reload (#77). Best-effort — if this fails we still
    // succeed the request because the REPLY mail already went out and
    // the next thread-open will lazily promote a NEEDS-ACTION row.
    try {
      await updateRsvpStatus({
        userId: user.id,
        icalUid: found.uid,
        status,
        fallback: {
          mailboxId: found.mailboxId,
          sourceMessageId: id,
          startsAt: found.startsAt,
          endsAt: found.endsAt,
          summary: found.summary,
          location: null,
          organizerEmail: found.organizer,
        },
      });
    } catch (e) {
      console.warn("rsvp persist failed (REPLY still sent)", e);
    }

    return NextResponse.json({ ok: true, status });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("rsvp", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

interface RsvpContext {
  mailboxId: string;
  mailboxLocalPart: string;
  mailboxDomainName: string;
  organizer: string | null;
  uid: string | null;
  summary: string | null;
  startsAt: number;
  endsAt: number | null;
}

async function lookupRsvpContext(
  userId: string,
  messageId: string,
): Promise<RsvpContext | null> {
  const dbs = await getActiveMailDbs();
  for (const { db } of dbs) {
    const row = await db
      .prepare(
        `SELECT m.id, m.mailbox_id,
                ce.starts_at, ce.ends_at, ce.summary, ce.organizer, ce.uid
           FROM messages m
           INNER JOIN message_calendar_events ce ON ce.message_id = m.id
          WHERE m.id = ?`,
      )
      .bind(messageId)
      .first<{
        id: string;
        mailbox_id: string;
        starts_at: number;
        ends_at: number | null;
        summary: string | null;
        organizer: string | null;
        uid: string | null;
      }>();
    if (!row) continue;

    const access = await getDb()
      .prepare(
        `SELECT mb.local_part, d.name AS domain_name, uma.role
           FROM user_mailbox_access uma
           INNER JOIN mailboxes mb ON mb.id = uma.mailbox_id
           INNER JOIN domains d ON d.id = mb.domain_id
          WHERE uma.user_id = ? AND uma.mailbox_id = ?`,
      )
      .bind(userId, row.mailbox_id)
      .first<{ local_part: string; domain_name: string; role: string }>();
    if (!access) return null;
    if (access.role === "reader") return null; // readers can't send mail

    return {
      mailboxId: row.mailbox_id,
      mailboxLocalPart: access.local_part,
      mailboxDomainName: access.domain_name,
      organizer: row.organizer,
      uid: row.uid,
      summary: row.summary,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
    };
  }
  return null;
}

interface BuildReplyArgs {
  uid: string;
  organizer: string;
  attendee: string;
  attendeeName: string | null;
  summary: string | null;
  startsAt: number;
  endsAt: number | null;
  partstat: Status;
}

// Build a tiny but valid `method=REPLY` calendar body. The recipient's
// calendar correlates by UID (+ ORGANIZER + ATTENDEE) and updates their
// event's attendee state from the PARTSTAT we set here. DTSTAMP is required
// (RFC 5545 §3.8.7.2). We re-emit DTSTART/DTEND from the original parse so
// the reply names the same instance the inviter shipped.
function buildReplyIcs(a: BuildReplyArgs): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Orange Inbox//RSVP 1.0//EN",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    `UID:${escapeText(a.uid)}`,
    `DTSTAMP:${formatUtc(Math.floor(Date.now() / 1000))}`,
    `DTSTART:${formatUtc(a.startsAt)}`,
  ];
  if (a.endsAt != null) {
    lines.push(`DTEND:${formatUtc(a.endsAt)}`);
  }
  if (a.summary) {
    lines.push(`SUMMARY:${escapeText(a.summary)}`);
  }
  lines.push(`ORGANIZER:mailto:${a.organizer}`);
  const cn = a.attendeeName ? `;CN=${escapeParam(a.attendeeName)}` : "";
  lines.push(
    `ATTENDEE${cn};PARTSTAT=${a.partstat};RSVP=FALSE:mailto:${a.attendee}`,
  );
  // Sequence 0 is the safe default — we're not editing the inviter's series,
  // just responding to the original instance.
  lines.push("SEQUENCE:0");
  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");

  // RFC 5545 §3.1: lines >75 octets MUST be folded. Fold conservatively at
  // 73 chars (single-byte ASCII assumption — UID/SUMMARY are escaped above
  // and unlikely to contain multi-byte runs near the boundary).
  return lines.map(foldLine).join("\r\n");
}

function escapeText(s: string): string {
  // RFC 5545 TEXT escaping — `\`, `;`, `,`, and newlines need to be escaped.
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

function escapeParam(s: string): string {
  // Param values can be quoted to allow `,;:` — we just quote unconditionally.
  // A `"` inside the value isn't allowed at all per RFC 5545 §3.2; strip them.
  return `"${s.replace(/"/g, "")}"`;
}

function formatUtc(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const yy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const h = d.getUTCHours().toString().padStart(2, "0");
  const m = d.getUTCMinutes().toString().padStart(2, "0");
  const s = d.getUTCSeconds().toString().padStart(2, "0");
  return `${yy}${mm}${dd}T${h}${m}${s}Z`;
}

function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const out: string[] = [];
  let remaining = line;
  out.push(remaining.slice(0, 75));
  remaining = remaining.slice(75);
  while (remaining.length > 0) {
    out.push(" " + remaining.slice(0, 74));
    remaining = remaining.slice(74);
  }
  return out.join("\r\n");
}

function subjectFor(status: Status, summary: string | null): string {
  const verb =
    status === "ACCEPTED" ? "Accepted" : status === "TENTATIVE" ? "Tentative" : "Declined";
  const title = summary || "(no title)";
  return `${verb}: ${title}`;
}

function textBodyFor(status: Status, summary: string | null): string {
  const verb =
    status === "ACCEPTED"
      ? "has accepted"
      : status === "TENTATIVE"
        ? "has tentatively accepted"
        : "has declined";
  const title = summary || "(no title)";
  return `Your invitee ${verb} the meeting "${title}".`;
}
