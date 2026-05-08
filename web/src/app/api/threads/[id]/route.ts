import { NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getThreadDetail } from "@/lib/queries";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const detail = await getThreadDetail(user.id, id);
    if (!detail) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    throw e;
  }
}
