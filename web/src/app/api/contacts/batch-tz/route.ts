import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getContactsLookup } from "@/lib/contacts";
import { errorResponse } from "../route";

// Batch contact-tz lookup (#98).
//
// Returns the resolved tz + source for each requested email that the caller
// can see in their address book. The compose recipient-tz pills use this to
// avoid N parallel /contacts/search round-trips when the user types out a
// CC list.
//
// POST instead of GET — emails go in the body so a 30-recipient CC doesn't
// blow past the URL length cap. The semantics are read-only; if we ever
// need cache headers there's room to slot them in.
//
// Auth: scoped to the caller's mailbox access via getContactsLookup, which
// joins through user_mailbox_access. Emails the caller doesn't have a
// contact for simply don't appear in the response map.
//
// Cap: 50 emails per request. Larger payloads get a 400 — the caller is
// expected to chunk client-side. (Realistic compose CC counts are <10.)

interface PostBody {
  emails?: unknown;
}

const MAX_EMAILS = 50;

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = (await req.json().catch(() => null)) as PostBody | null;
    if (!body || !Array.isArray(body.emails)) {
      return NextResponse.json({ error: "emails required" }, { status: 400 });
    }
    // Normalise: lower-case, trim, drop anything that doesn't look like an
    // address. De-dup before we hit the cap so a list of 60 mostly-duplicate
    // entries still fits.
    const emails = Array.from(
      new Set(
        body.emails
          .filter((e): e is string => typeof e === "string")
          .map(e => e.trim().toLowerCase())
          .filter(e => e && e.includes("@")),
      ),
    );
    if (emails.length > MAX_EMAILS) {
      return NextResponse.json(
        { error: `too_many_emails (max ${MAX_EMAILS})` },
        { status: 400 },
      );
    }

    // Single SELECT across the caller's accessible contacts; we then
    // project down to just the requested emails. Avoids per-email query
    // amplification — same shape as the read used by the thread reader's
    // sender-pill renderer.
    const lookup = await getContactsLookup(user.id);
    const tzByEmail: Record<string, { tz: string | null; source: string | null }> = {};
    for (const e of emails) {
      const hit = lookup.tzByEmail.get(e);
      if (hit) {
        tzByEmail[e] = { tz: hit.tz, source: hit.source };
      } else {
        // Emit an explicit null entry so the client can distinguish
        // "looked up, no tz" from "not yet fetched". Saves a re-fetch.
        tzByEmail[e] = { tz: null, source: null };
      }
    }
    return NextResponse.json({ tzByEmail });
  } catch (e) {
    return errorResponse(e);
  }
}
