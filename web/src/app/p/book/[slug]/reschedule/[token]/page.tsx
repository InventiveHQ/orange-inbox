import { notFound } from "next/navigation";
import { getBookingByToken, getEventTypeById } from "@/lib/booking";
import RescheduleClient from "./RescheduleClient";

// Public booking-reschedule page — the reschedule token is the credential.
// Lives under /p/*, covered by the public Cloudflare Access Bypass policy.

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string; token: string }>;
}

export default async function ReschedulePage({ params }: PageProps) {
  const { token } = await params;
  if (!token) return notFound();
  const booking = await getBookingByToken("reschedule", token);
  if (!booking) return notFound();
  const eventType = await getEventTypeById(booking.eventTypeId);
  if (!eventType) return notFound();

  return (
    <main className="min-h-screen bg-neutral-50 px-4 py-8 sm:py-14 dark:bg-neutral-950">
      <div className="mx-auto max-w-3xl">
        <RescheduleClient
          slug={eventType.slug}
          token={token}
          eventName={eventType.name}
          durationMinutes={eventType.durationMinutes}
          bookingWindowDays={eventType.bookingWindowDays}
          currentStart={booking.startsAt}
          reschedulable={booking.status === "confirmed"}
        />
      </div>
    </main>
  );
}
