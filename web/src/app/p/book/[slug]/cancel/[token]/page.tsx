import { notFound } from "next/navigation";
import { getBookingByToken, getEventTypeById } from "@/lib/booking";
import CancelClient from "./CancelClient";

// Public booking-cancel page — the cancel token is the credential.
// Lives under /p/*, covered by the public Cloudflare Access Bypass policy.

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string; token: string }>;
}

export default async function CancelPage({ params }: PageProps) {
  const { token } = await params;
  if (!token) return notFound();
  const booking = await getBookingByToken("cancel", token);
  if (!booking) return notFound();
  const eventType = await getEventTypeById(booking.eventTypeId);

  return (
    <main className="min-h-screen bg-neutral-50 px-4 py-10 sm:py-16 dark:bg-neutral-950">
      <div className="mx-auto max-w-md">
        <CancelClient
          token={token}
          eventName={eventType?.name ?? "Meeting"}
          startsAt={booking.startsAt}
          alreadyCancelled={booking.status === "cancelled"}
        />
      </div>
    </main>
  );
}
