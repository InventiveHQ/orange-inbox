import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { canManageLabel } from "@/lib/labels";

interface PatchBody {
  name?: string;
  color?: string | null;
}

const MAX_NAME = 64;
const COLOR_RE = /^#?[0-9a-zA-Z]{1,32}$/;

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;

    if (!(await canManageLabel(user, id))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const b = (await req.json().catch(() => null)) as PatchBody | null;
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });

    const updates: string[] = [];
    const binds: unknown[] = [];

    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
      if (name.length > MAX_NAME) {
        return NextResponse.json({ error: "name too long" }, { status: 400 });
      }
      updates.push("name = ?");
      binds.push(name);
    }

    if (b.color !== undefined) {
      let color: string | null = null;
      if (b.color != null) {
        const c = String(b.color).trim();
        if (c) {
          if (!COLOR_RE.test(c)) {
            return NextResponse.json({ error: "invalid color" }, { status: 400 });
          }
          color = c;
        }
      }
      updates.push("color = ?");
      binds.push(color);
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: "no_changes" }, { status: 400 });
    }

    binds.push(id);
    try {
      await getDb()
        .prepare(`UPDATE labels SET ${updates.join(", ")} WHERE id = ?`)
        .bind(...binds)
        .run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE|constraint/i.test(msg)) {
        return NextResponse.json({ error: "label name already exists" }, { status: 409 });
      }
      throw err;
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

    if (!(await canManageLabel(user, id))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    // FK ON DELETE CASCADE on message_labels takes care of join cleanup.
    await getDb().prepare("DELETE FROM labels WHERE id = ?").bind(id).run();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

function errorResponse(e: unknown) {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  console.error(e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
