import { redirect } from "next/navigation";

// Legacy /scheduled URL — the page now lives inside the inbox shell at
// /inbox/scheduled so the sidebar/topbar stay visible. Old bookmarks /
// service-worker pre-caches keep working via this redirect.
export default function LegacyScheduledRedirect() {
  redirect("/inbox/scheduled");
}
