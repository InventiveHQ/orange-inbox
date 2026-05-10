import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import {
  deleteInboxLayout,
  updateInboxLayout,
  type InboxLayoutPatch,
} from "@/lib/inbox-layouts";
import { errorResponse } from "../route";

interface PatchBody {
  name?: string;
  panes?: unknown;
  is_default?: boolean;
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
    const patch: InboxLayoutPatch = {};
    if (typeof b.name === "string") patch.name = b.name;
    // panes is `unknown` in the patch type — validation happens in the lib
    // module so the same rules apply to create + update.
    if (b.panes !== undefined) {
      patch.panes = b.panes as InboxLayoutPatch["panes"];
    }
    if (typeof b.is_default === "boolean") patch.is_default = b.is_default;
    const layout = await updateInboxLayout(id, user.id, patch);
    return NextResponse.json({ layout });
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
    await deleteInboxLayout(id, user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
