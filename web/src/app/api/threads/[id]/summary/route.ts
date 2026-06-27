import { NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getThreadSummary } from "@/lib/summary";

// Lazy one-line thread summary (0056). The reader UI fetches this after the
// thread paints; generation + caching happens in getThreadSummary. Returns
// { summary: string | null } — null means "nothing worth summarising" or "AI
// unavailable", and the UI simply renders no summary line.
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const summary = await getThreadSummary(user.id, id);
    return NextResponse.json({ summary });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
