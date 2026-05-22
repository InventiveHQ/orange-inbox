import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  createColumn,
  ensureBoard,
  reorderColumns,
  userCanAccessMailbox,
} from "@/lib/kanban";

// Kanban columns for a mailbox board (migration 0054).
//   GET   — list columns, seeding the default board on first open.
//   POST  — create a column (body: { name }).
//   PATCH — reorder columns (body: { order: string[] }).
//
// All three are open to any member of the mailbox — the board is team-shared,
// same permission model as thread assignment.

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: mailboxId } = await ctx.params;
    if (!(await userCanAccessMailbox(mailboxId, user.id))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const columns = await ensureBoard(mailboxId);
    return NextResponse.json({ columns });
  } catch (e) {
    return errorResponse(e);
  }
}

interface PostBody {
  name?: string;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: mailboxId } = await ctx.params;
    const body = (await req.json().catch(() => null)) as PostBody | null;
    const result = await createColumn(mailboxId, body?.name ?? "", user.id);
    if (!result.ok) {
      const status = result.code === "forbidden" ? 403 : 400;
      return NextResponse.json({ error: result.code }, { status });
    }
    return NextResponse.json({ column: result.column });
  } catch (e) {
    return errorResponse(e);
  }
}

interface PatchBody {
  order?: unknown;
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id: mailboxId } = await ctx.params;
    const body = (await req.json().catch(() => null)) as PatchBody | null;
    const result = await reorderColumns(mailboxId, body?.order, user.id);
    if (!result.ok) {
      const status = result.code === "forbidden" ? 403 : 400;
      return NextResponse.json({ error: result.code }, { status });
    }
    return NextResponse.json({ columns: result.columns });
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
