import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listLabelsForUser } from "@/lib/labels";

interface CreateBody {
  name?: string;
  color?: string | null;
  mailbox_id?: string | null;
}

const MAX_NAME = 64;
// Loose hex check; the UI offers swatches but we accept any valid CSS color
// string up to a small limit.
const COLOR_RE = /^#?[0-9a-zA-Z]{1,32}$/;

export async function GET() {
  try {
    const user = await requireUser();
    const labels = await listLabelsForUser(user.id);
    return NextResponse.json({ labels });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const b = (await req.json().catch(() => null)) as CreateBody | null;
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });

    const name = b.name?.trim();
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
    if (name.length > MAX_NAME) {
      return NextResponse.json({ error: "name too long" }, { status: 400 });
    }

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

    const mailboxId = b.mailbox_id ?? null;
    if (mailboxId && !user.is_admin) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    // Global labels (mailbox_id null) — v1: any signed-in user can create.
    // See web/src/lib/labels.ts header for the multi-user gap.

    const id = crypto.randomUUID();
    try {
      await getDb()
        .prepare("INSERT INTO labels (id, name, color, mailbox_id) VALUES (?, ?, ?, ?)")
        .bind(id, name, color, mailboxId)
        .run();
    } catch (err) {
      // UNIQUE(mailbox_id, name) violation surfaces as a SQLite constraint
      // error from D1; treat any error from this insert path as duplicate
      // unless it's clearly something else.
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE|constraint/i.test(msg)) {
        return NextResponse.json({ error: "label name already exists" }, { status: 409 });
      }
      throw err;
    }

    return NextResponse.json(
      { label: { id, name, color, mailbox_id: mailboxId } },
      { status: 201 },
    );
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
