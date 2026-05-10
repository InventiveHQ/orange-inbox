import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  InboxLayoutError,
  createInboxLayout,
  listInboxLayouts,
} from "@/lib/inbox-layouts";

export async function GET() {
  try {
    const user = await requireUser();
    const layouts = await listInboxLayouts(user.id);
    return NextResponse.json({ layouts });
  } catch (e) {
    return errorResponse(e);
  }
}

interface PostBody {
  name?: string;
  panes?: unknown;
  is_default?: boolean;
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const b = (await req.json().catch(() => null)) as PostBody | null;
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    const layout = await createInboxLayout(
      user.id,
      b.name ?? "",
      b.panes,
      Boolean(b.is_default),
    );
    return NextResponse.json({ layout }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (e instanceof InboxLayoutError) {
    const status = e.code === "not_found" ? 404 : 400;
    return NextResponse.json({ error: e.message, code: e.code }, { status });
  }
  console.error(e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
