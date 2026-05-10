import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  RuleError,
  createRule,
  listRulesForUser,
  type RuleAction,
  type RuleCondition,
} from "@/lib/rules";

export async function GET() {
  try {
    const user = await requireUser();
    const rules = await listRulesForUser(user.id);
    return NextResponse.json({ rules });
  } catch (e) {
    return errorResponse(e);
  }
}

interface PostBody {
  name?: string;
  mailbox_id?: string | null;
  conditions?: RuleCondition[];
  actions?: RuleAction[];
  enabled?: boolean;
  sort_order?: number;
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const b = (await req.json().catch(() => null)) as PostBody | null;
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });

    const rule = await createRule(user.id, {
      name: b.name ?? "",
      mailbox_id: b.mailbox_id ?? null,
      conditions: b.conditions ?? [],
      actions: b.actions ?? [],
      enabled: b.enabled,
      sort_order: b.sort_order,
    });
    return NextResponse.json({ rule }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (e instanceof RuleError) {
    const status = e.code === "forbidden" ? 403 : e.code === "not_found" ? 404 : 400;
    return NextResponse.json({ error: e.message, code: e.code }, { status });
  }
  console.error(e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
