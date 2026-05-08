import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { getDb, getEnv } from "@/lib/db";

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB per file
const SAFE_FILENAME = /[^A-Za-z0-9._\-]/g;

// POST a single file via multipart/form-data (field name "file"). Returns the
// upload id + metadata; the client passes the id back when sending so we can
// look it up, verify the user owns it, and stream the bytes into env.EMAIL.send().
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }
    if (file.size === 0) {
      return NextResponse.json({ error: "file is empty" }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: "file too large", limit: MAX_BYTES },
        { status: 413 },
      );
    }

    const id = crypto.randomUUID();
    const safeName = (file.name || "attachment").replace(SAFE_FILENAME, "_").slice(0, 200);
    const r2Key = `uploads/${user.id}/${id}/${safeName}`;

    const env = getEnv();
    await env.ATTACHMENTS.put(r2Key, file.stream(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
      customMetadata: { user: user.id, uploadId: id },
    });

    await getDb()
      .prepare(
        `INSERT INTO temp_uploads (id, user_id, filename, content_type, size, r2_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, user.id, file.name || null, file.type || null, file.size, r2Key)
      .run();

    return NextResponse.json(
      {
        id,
        filename: file.name || null,
        content_type: file.type || null,
        size: file.size,
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error(e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
