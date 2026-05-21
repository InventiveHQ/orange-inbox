import { NextRequest, NextResponse } from "next/server";
import {
  createBooking,
  getBooking,
  getEventTypeBySlug,
  getEventTypeCalendars,
  getOverrides,
} from "@/lib/booking";
import { isSlotAvailable } from "@/lib/booking-availability";
import { fulfillBooking } from "@/lib/booking-fulfill";
import { verifyTurnstile } from "@/lib/turnstile";

// POST /p/api/book/<slug>
//
// Public — creates a booking; lives under /p/*, covered by the public
// Cloudflare Access Bypass policy. Re-checks slot availability across every
// linked calendar before committing so a stale public page can't double-book.

export const dynamic = "force-dynamic";

interface Body {
  start?: number;
  name?: string;
  email?: string;
  timezone?: string;
  answers?: Record<string, string>;
  turnstileToken?: string;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await ctx.params;
    const eventType = await getEventTypeBySlug(slug);
    if (!eventType) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const b = (await req.json().catch(() => null)) as Body | null;
    if (!b) {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }

    const name = (b.name ?? "").trim().slice(0, 200);
    const email = (b.email ?? "").trim().slice(0, 320);
    if (!name) {
      return NextResponse.json({ error: "missing_name" }, { status: 400 });
    }
    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "invalid_email" }, { status: 400 });
    }
    if (typeof b.start !== "number" || !Number.isFinite(b.start)) {
      return NextResponse.json({ error: "invalid_start" }, { status: 400 });
    }

    // Bot protection — no-op until Turnstile is configured.
    const ip = req.headers.get("cf-connecting-ip");
    if (!(await verifyTurnstile(b.turnstileToken, ip))) {
      return NextResponse.json({ error: "turnstile_failed" }, { status: 400 });
    }

    // Required custom questions.
    const answers: Record<string, string> = {};
    for (const q of eventType.customQuestions) {
      const v = (b.answers?.[q.id] ?? "").toString().trim().slice(0, 2000);
      if (q.required && !v) {
        return NextResponse.json(
          { error: "missing_answer", question: q.label },
          { status: 400 },
        );
      }
      if (v) answers[q.id] = v;
    }

    const [calendars, overrides] = await Promise.all([
      getEventTypeCalendars(eventType.id),
      getOverrides(eventType.id),
    ]);

    const available = await isSlotAvailable(
      eventType,
      calendars,
      overrides,
      b.start,
    );
    if (!available) {
      return NextResponse.json(
        { error: "slot_unavailable", message: "That time was just taken." },
        { status: 409 },
      );
    }

    const booking = await createBooking({
      eventTypeId: eventType.id,
      hostUserId: eventType.userId,
      inviteeName: name,
      inviteeEmail: email,
      inviteeTimezone: typeof b.timezone === "string" ? b.timezone : null,
      startsAt: b.start,
      endsAt: b.start + eventType.durationMinutes * 60,
      answers,
    });

    // Calendar writes, conferencing, contact, email — failures inside are
    // logged but don't unwind the (already-persisted) booking.
    const origin = new URL(req.url).origin;
    await fulfillBooking(eventType, booking, calendars, origin);

    const fresh = (await getBooking(booking.id)) ?? booking;
    return NextResponse.json(
      {
        ok: true,
        booking: {
          id: fresh.id,
          startsAt: fresh.startsAt,
          endsAt: fresh.endsAt,
          conferenceProvider: fresh.conferenceProvider,
          conferenceUrl: fresh.conferenceUrl,
          rescheduleToken: fresh.rescheduleToken,
          cancelToken: fresh.cancelToken,
        },
      },
      { status: 201 },
    );
  } catch (e) {
    console.error("book create route", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
