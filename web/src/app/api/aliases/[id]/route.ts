import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { AliasError, demoteAlias, updateAlias } from "@/lib/aliases";

interface PatchBody {
  display_name?: string | null;
  signature_html?: string | null;
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const b = (await req.json().catch(() => null)) as PatchBody | null;
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });

    const ok = await updateAlias(user.id, id, {
      display_name: b.display_name,
      signature_html: b.signature_html,
    });
    if (!ok) {
      return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const ok = await demoteAlias(user.id, id);
    if (!ok) {
      return NextResponse.json({ error: "not_found_or_forbidden" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

function errorResponse(e: unknown) {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (e instanceof AliasError) {
    const status = e.code === "forbidden" ? 403 : 400;
    return NextResponse.json({ error: e.message, code: e.code }, { status });
  }
  console.error(e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
