import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getEnv } from "@/lib/db";
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_MESSAGES,
  ingestMboxText,
  userCanImportInto,
} from "@/lib/import-mbox";
import { notify } from "@/lib/notify";

// Mbox import endpoint.
//
// Accepts the raw bytes of an mbox file and a target mailbox (passed as a
// `mailbox_id` query param). Splits, parses, and ingests each message via
// the same threading + R2 + D1 path the inbound email-worker uses.
//
// Hard caps live in import-mbox.ts (MAX_IMPORT_BYTES / MAX_IMPORT_MESSAGES).
// Users with bigger files split before importing.

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const mailboxId = req.nextUrl.searchParams.get("mailbox_id");
    if (!mailboxId) {
      return NextResponse.json(
        { error: "missing_mailbox_id" },
        { status: 400 },
      );
    }
    if (!(await userCanImportInto(user.id, mailboxId))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    // Pre-flight body size check via Content-Length when present. Final
    // enforcement happens after we read the bytes, since Content-Length is
    // optional / spoofable.
    const contentLength = Number(req.headers.get("content-length") ?? "0");
    if (contentLength > MAX_IMPORT_BYTES) {
      return NextResponse.json(
        {
          error: "too_large",
          max_bytes: MAX_IMPORT_BYTES,
          message: `Import is capped at ${(MAX_IMPORT_BYTES / 1024 / 1024).toFixed(0)} MB per request. Split your file and import in batches.`,
        },
        { status: 413 },
      );
    }

    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_IMPORT_BYTES) {
      return NextResponse.json(
        { error: "too_large", max_bytes: MAX_IMPORT_BYTES },
        { status: 413 },
      );
    }

    const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);

    // Quick sanity check — an mbox always has at least one `From ` line.
    // Don't try to ingest an .eml or random text.
    if (!/(^|\r?\n)From .+\r?\n/.test(text)) {
      return NextResponse.json(
        {
          error: "not_an_mbox",
          message:
            "File doesn't look like an mbox (no 'From ' separator lines). For a single .eml, use a different tool to wrap it first.",
        },
        { status: 400 },
      );
    }

    const result = await ingestMboxText(mailboxId, text);

    // Surface batch errors via the operational alert webhook so the operator
    // notices if a particular client's mbox shape consistently fails.
    if (result.errors.length > 5) {
      const env = getEnv() as unknown as { ALERT_WEBHOOK_URL?: string };
      await notify(env.ALERT_WEBHOOK_URL, "warn", "Mbox import had many errors", {
        user: user.id,
        mailbox: mailboxId,
        imported: result.imported,
        duplicates: result.duplicates,
        errors: result.errors.length,
        first_error: result.errors[0]?.reason ?? "(none)",
      });
    }

    return NextResponse.json({
      ok: true,
      imported: result.imported,
      duplicates: result.duplicates,
      errors: result.errors.length,
      error_samples: result.errors.slice(0, 5),
      max_messages_per_request: MAX_IMPORT_MESSAGES,
    });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("import mbox failed", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
