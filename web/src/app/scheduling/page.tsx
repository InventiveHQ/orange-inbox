import { getCurrentUser } from "@/lib/auth";
import SchedulingManager from "@/components/SchedulingManager";

// Scheduling admin (orange-inbox#101). Behind Cloudflare Access like the rest
// of the app — only /p/book/* and /p/api/book/* are public.

export const dynamic = "force-dynamic";

export default async function SchedulingPage() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-neutral-500">Please sign in.</p>
      </main>
    );
  }
  return <SchedulingManager userId={user.id} />;
}
