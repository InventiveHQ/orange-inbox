import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import {
  deleteRule,
  updateRule,
  type RuleAction,
  type RuleCondition,
} from "@/lib/rules";
import { errorResponse } from "../route";

interface PatchBody {
  name?: string;
  mailbox_id?: string | null;
  conditions?: RuleCondition[];
  actions?: RuleAction[];
  enabled?: boolean;
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
    const rule = await updateRule(user.id, id, b);
    return NextResponse.json({ rule });
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
    await deleteRule(user.id, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
