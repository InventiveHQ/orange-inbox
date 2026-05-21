import { NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listCalendarConnections } from "@/lib/booking";
import { googleConfigured } from "@/lib/google-calendar";

// GET /api/scheduling/calendars
//
// The calendars a booking link can be attached to: the caller's Orange-native
// calendars (Personal + each mailbox they can access) and their connected
// Google calendars.

export async function GET() {
  try {
    const user = await requireUser();
    const { results } = await getDb()
      .prepare(
        `SELECT m.id AS id, m.local_part AS local_part, d.name AS domain,
                m.display_name AS display_name
           FROM user_mailbox_access uma
           JOIN mailboxes m ON m.id = uma.mailbox_id
           JOIN domains d ON d.id = m.domain_id
          WHERE uma.user_id = ? AND uma.role IN ('owner','member')
          ORDER BY uma.sort_order`,
      )
      .bind(user.id)
      .all<{
        id: string;
        local_part: string;
        domain: string;
        display_name: string | null;
      }>();

    const orange = [
      { mailboxId: null as string | null, label: "Personal calendar" },
      ...results.map((m) => ({
        mailboxId: m.id,
        label: `${m.local_part}@${m.domain}`,
      })),
    ];

    const connections = await listCalendarConnections(user.id);
    const google = connections.map((c) => ({
      connectionId: c.id,
      label: c.displayName || c.accountEmail,
      status: c.status,
    }));

    return NextResponse.json({
      orange,
      google,
      googleConfigured: googleConfigured(),
    });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("scheduling calendars route", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
