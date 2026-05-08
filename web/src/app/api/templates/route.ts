import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { TemplateError, createTemplate, listTemplatesForUser } from "@/lib/templates";

export async function GET() {
  try {
    const user = await requireUser();
    const templates = await listTemplatesForUser(user.id);
    return NextResponse.json({ templates });
  } catch (e) {
    return errorResponse(e);
  }
}

interface PostBody {
  name?: string;
  scope?: "personal" | "shared";
  mailbox_id?: string | null;
  subject_template?: string | null;
  body_template?: string;
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const b = (await req.json().catch(() => null)) as PostBody | null;
    if (!b) return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    if (!b.name) return NextResponse.json({ error: "name required" }, { status: 400 });
    if (!b.body_template) {
      return NextResponse.json({ error: "body_template required" }, { status: 400 });
    }
    const scope = b.scope === "shared" ? "shared" : "personal";
    const id = await createTemplate(user.id, {
      name: b.name,
      subject_template: b.subject_template ?? null,
      body_template: b.body_template,
      scope,
      mailbox_id: scope === "shared" ? b.mailbox_id ?? null : null,
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (e instanceof TemplateError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
  }
  console.error(e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
