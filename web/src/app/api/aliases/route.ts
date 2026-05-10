import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  AliasError,
  listAliases,
  listObservedAliases,
  promoteAlias,
} from "@/lib/aliases";

interface PromoteBody {
  mailbox_id?: string;
  local_part?: string;
  display_name?: string | null;
  signature_html?: string | null;
}

// GET /api/aliases — promoted aliases the user can send from, plus the
// observed (catch-all) candidates the dashboard lets them promote in one
// click. Bundled into one response so the UI does a single round-trip.
export async function GET() {
  try {
    const user = await requireUser();
    const [promoted, observed] = await Promise.all([
      listAliases(user.id),
      listObservedAliases(user.id),
    ]);
    return NextResponse.json({ promoted, observed });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/aliases — promote a (mailbox_id, local_part) into a tracked
// alias. The mailbox must be one the user has owner/member access on
// (re-checked in the lib so the API route is just shape-validation here).
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const b = (await req.json().catch(() => null)) as PromoteBody | null;
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    if (!b.mailbox_id) {
      return NextResponse.json({ error: "mailbox_id required" }, { status: 400 });
    }
    if (!b.local_part) {
      return NextResponse.json({ error: "local_part required" }, { status: 400 });
    }
    const id = await promoteAlias(
      user.id,
      String(b.mailbox_id),
      String(b.local_part),
      b.display_name ?? null,
      b.signature_html ?? null,
    );
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

function errorResponse(e: unknown) {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (e instanceof AliasError) {
    const status =
      e.code === "forbidden" ? 403 : e.code === "duplicate" ? 409 : 400;
    return NextResponse.json({ error: e.message, code: e.code }, { status });
  }
  console.error(e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
