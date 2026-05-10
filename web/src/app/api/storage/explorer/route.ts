import { NextResponse } from "next/server";
import {
  ForbiddenError,
  UnauthenticatedError,
  requireAdmin,
} from "@/lib/auth";
import {
  getDomainSummary,
  getTopSenders,
  getTopThreads,
} from "@/lib/storage-stats";

// Storage Explorer data — top senders, top threads, per-domain summary.
// Heavy: fans out across every mail DB on each request, so this is admin-
// only and lazy-loaded by the Storage section in Settings.
export async function GET() {
  try {
    await requireAdmin();
    const [senders, threads, domains] = await Promise.all([
      getTopSenders(50),
      getTopThreads(50),
      getDomainSummary(),
    ]);
    return NextResponse.json({ senders, threads, domains });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
