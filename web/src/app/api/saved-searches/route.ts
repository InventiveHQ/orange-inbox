import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  SavedSearchError,
  createSavedSearch,
  listSavedSearches,
} from "@/lib/saved-searches";

export async function GET() {
  try {
    const user = await requireUser();
    const saved_searches = await listSavedSearches(user.id);
    return NextResponse.json({ saved_searches });
  } catch (e) {
    return errorResponse(e);
  }
}

interface PostBody {
  name?: string;
  query?: string;
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const b = (await req.json().catch(() => null)) as PostBody | null;
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    const saved_search = await createSavedSearch(user.id, b.name ?? "", b.query ?? "");
    return NextResponse.json({ saved_search }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (e instanceof SavedSearchError) {
    const status = e.code === "not_found" ? 404 : 400;
    return NextResponse.json({ error: e.message, code: e.code }, { status });
  }
  console.error(e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
