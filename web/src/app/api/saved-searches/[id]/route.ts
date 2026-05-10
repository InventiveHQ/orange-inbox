import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { deleteSavedSearch, updateSavedSearch } from "@/lib/saved-searches";
import { errorResponse } from "../route";

interface PatchBody {
  name?: string;
  query?: string;
  sort_order?: number;
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
    const saved_search = await updateSavedSearch(id, user.id, b);
    return NextResponse.json({ saved_search });
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
    await deleteSavedSearch(id, user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
