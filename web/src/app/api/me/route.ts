import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ user });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    throw e;
  }
}

// Allowed Undo Send delays. 0 disables the feature; the rest mirror Gmail.
const UNDO_SEND_OPTIONS = [0, 5, 10, 20, 30] as const;

interface PatchBody {
  undo_send_seconds?: number;
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireUser();
    const b = (await req.json().catch(() => null)) as PatchBody | null;
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });

    if (b.undo_send_seconds !== undefined) {
      const v = Number(b.undo_send_seconds);
      if (!UNDO_SEND_OPTIONS.includes(v as (typeof UNDO_SEND_OPTIONS)[number])) {
        return NextResponse.json({ error: "invalid_undo_send_seconds" }, { status: 400 });
      }
      await getDb()
        .prepare("UPDATE users SET undo_send_seconds = ? WHERE id = ?")
        .bind(v, user.id)
        .run();
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
