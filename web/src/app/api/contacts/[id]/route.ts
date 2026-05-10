import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { ContactPatch, deleteContact, updateContact } from "@/lib/contacts";
import { errorResponse, parseStage, parseTags } from "../route";

interface PatchBody {
  name?: string | null;
  notes?: string | null;
  email?: string;
  company?: string | null;
  title?: string | null;
  phone?: string | null;
  website?: string | null;
  linkedin?: string | null;
  address?: string | null;
  stage?: string | null;
  tags?: unknown;
  tz?: string | null;
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
    const patch: ContactPatch = {};
    if ("name" in b) patch.name = b.name ?? null;
    if ("notes" in b) patch.notes = b.notes ?? null;
    if ("email" in b && typeof b.email === "string") patch.email = b.email;
    if ("company" in b) patch.company = b.company ?? null;
    if ("title" in b) patch.title = b.title ?? null;
    if ("phone" in b) patch.phone = b.phone ?? null;
    if ("website" in b) patch.website = b.website ?? null;
    if ("linkedin" in b) patch.linkedin = b.linkedin ?? null;
    if ("address" in b) patch.address = b.address ?? null;
    if ("stage" in b) patch.stage = parseStage(b.stage);
    if ("tags" in b) patch.tags = parseTags(b.tags);
    if ("tz" in b) patch.tz = typeof b.tz === "string" ? b.tz : null;
    const ok = await updateContact(user.id, id, patch);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
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
    const ok = await deleteContact(user.id, id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
