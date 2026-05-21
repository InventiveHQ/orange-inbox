import { notFound } from "next/navigation";
import { getEventTypeBySlug } from "@/lib/booking";
import { turnstileSiteKey } from "@/lib/turnstile";
import BookingClient from "./BookingClient";

// Public booking page (orange-inbox#104). Reachable WITHOUT authentication —
// it lives under the /p/* prefix, which the operator's single Cloudflare
// Access Bypass policy already covers (same as /p/c/*). See
// db/migrations/0053_booking.sql and the deploy notes.

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function BookingPage({ params }: PageProps) {
  const { slug } = await params;
  if (!slug || !/^[A-Za-z0-9_-]{1,80}$/.test(slug)) return notFound();
  const eventType = await getEventTypeBySlug(slug);
  if (!eventType) return notFound();

  return (
    <main className="min-h-screen bg-neutral-50 px-4 py-8 sm:py-14 dark:bg-neutral-950">
      <div className="mx-auto max-w-3xl">
        <BookingClient
          slug={eventType.slug}
          name={eventType.name}
          description={eventType.description}
          durationMinutes={eventType.durationMinutes}
          timezone={eventType.timezone}
          conferencingType={eventType.conferencingType}
          bookingWindowDays={eventType.bookingWindowDays}
          questions={eventType.customQuestions}
          turnstileSiteKey={turnstileSiteKey()}
        />
        <p className="mt-8 text-center text-xs text-neutral-400">
          Scheduling by Orange Mail
        </p>
      </div>
    </main>
  );
}
