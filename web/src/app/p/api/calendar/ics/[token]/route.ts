import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { buildVCalendar } from "@/lib/ical";
import {
  feedCalendarName,
  getActiveTokenRow,
  listEventsForFeed,
  touchTokenUsed,
} from "@/lib/ics-tokens";

// GET /p/api/calendar/ics/<token>
//
// Token-gated read-only feed for external calendar subscribers (Google /
// Apple / Outlook). Auth is the URL itself — there is no cookie or Access
// JWT in the path because Google's poller can't carry our auth.
//
// Conditional GET: subscribers poll every 15-60 minutes. We honour
// `If-None-Match` (against an ETag derived from MAX(updated_at)) and
// `If-Modified-Since` so the common case is a cheap 304.
//
// Honour-revoked: getActiveTokenRow filters revoked rows; a revoked token
// gets 404 (same as "no such token") to avoid signalling that the token
// was once valid.

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await ctx.params;
    const tokenRow = await getActiveTokenRow(token);
    if (!tokenRow) {
      // Same response shape as "no such token" — don't leak whether the
      // token used to exist.
      return new Response("not found", { status: 404 });
    }

    const { rows, lastModified } = await listEventsForFeed(
      tokenRow.user_id,
      tokenRow.scope,
    );

    // ETag is the MAX(updated_at) wrapped in quotes per RFC 7232. When the
    // calendar has zero rows we fall back to the token's own created_at so
    // the etag isn't an empty string.
    const versionStamp = lastModified || tokenRow.created_at;
    const etag = `"${versionStamp.toString(36)}"`;
    const lastModifiedHeader = new Date(versionStamp * 1000).toUTCString();

    const ifNoneMatch = req.headers.get("if-none-match");
    if (ifNoneMatch && ifNoneMatch === etag) {
      // 304 must NOT carry a body. Update last-used so the user can still
      // see the subscriber is alive even when we serve cheap 304s.
      void touchTokenUsed(token);
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          "Last-Modified": lastModifiedHeader,
          "Cache-Control": "private, max-age=300",
        },
      });
    }

    const ifModifiedSince = req.headers.get("if-modified-since");
    if (ifModifiedSince) {
      const since = Date.parse(ifModifiedSince);
      // Date.parse rounds to the second, so cmp at 1s granularity matches
      // the `Last-Modified` we previously emitted.
      if (
        Number.isFinite(since) &&
        Math.floor(since / 1000) >= versionStamp
      ) {
        void touchTokenUsed(token);
        return new Response(null, {
          status: 304,
          headers: {
            ETag: etag,
            "Last-Modified": lastModifiedHeader,
            "Cache-Control": "private, max-age=300",
          },
        });
      }
    }

    const host = await resolveHost();
    const body = buildVCalendar(rows, {
      uidDomain: host,
      calendarName: await feedCalendarName(tokenRow.user_id, tokenRow.scope),
    });

    void touchTokenUsed(token);

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8; method=PUBLISH",
        // The filename surfaces in some clients' "save as" prompts.
        "Content-Disposition": 'inline; filename="calendar.ics"',
        ETag: etag,
        "Last-Modified": lastModifiedHeader,
        // 5 minutes private cache — long enough that an aggressive client
        // (Apple's poller, refreshing on focus) doesn't hammer us, short
        // enough that a fresh edit shows up promptly. Subscribers also
        // honour ETag/Last-Modified, so the wire cost is tiny anyway.
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (e) {
    console.error("calendar ics feed route", e);
    return new Response("internal error", { status: 500 });
  }
}

async function resolveHost(): Promise<string> {
  try {
    const h = await headers();
    return h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
  } catch {
    return "localhost";
  }
}
