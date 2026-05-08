import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { searchThreads } from "@/lib/search";

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const query = req.nextUrl.searchParams.get("q") ?? "";
    const limitRaw = req.nextUrl.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;

    const results = await searchThreads(user.id, query, { limit });
    return NextResponse.json({ results, query });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("search route failed", e);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
