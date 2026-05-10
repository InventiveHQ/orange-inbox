import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { listAuditLog, userCanReadAuditLog } from "@/lib/audit";

// Per-mailbox audit log (issue #28).
//   GET ?mailbox_id=<id>[&limit=<n>]
//
// Auth: must have any role on the mailbox. Admins not specially privileged
// here — any member of a shared mailbox sees the trail for that mailbox.

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const url = new URL(req.url);
    const mailboxId = url.searchParams.get("mailbox_id");
    if (!mailboxId) {
      return NextResponse.json({ error: "mailbox_id required" }, { status: 400 });
    }
    if (!(await userCanReadAuditLog(user.id, mailboxId))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Number(limitParam) : undefined;
    const entries = await listAuditLog(mailboxId, {
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return NextResponse.json({ entries });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
