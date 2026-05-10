import { getDb } from "./db";

// Public download tokens for Mail Drop (large outbound attachments offloaded
// to R2). Two operations:
//
//   - createShareLink(): mint a token + insert the row at send time. The
//     caller has already PUT the bytes to R2 (typically reusing the existing
//     temp_uploads r2_key, since send.ts already pulled bytes from there for
//     small attachments).
//
//   - consumeShareLink(): atomic check-and-increment used by the public
//     /d/<token> route. Returns the row when the link is still live, or a
//     reason code (`expired` / `exhausted` / `not_found`) when the route
//     should respond 404/410.
//
// All rows live in the control DB. No mail-DB writes.

export interface ShareLinkRow {
  id: string;
  r2_bucket: string;
  r2_key: string;
  filename: string | null;
  content_type: string | null;
  size: number;
  expires_at: number;
  max_downloads: number | null;
  downloaded: number;
  created_by: string;
  created_at: number;
}

export interface CreateShareLinkInput {
  r2Bucket?: string;        // defaults to 'ATTACHMENTS'
  r2Key: string;
  filename: string | null;
  contentType: string | null;
  size: number;
  ttlSeconds?: number;       // defaults to 30 days
  maxDownloads?: number | null;
}

export interface CreateShareLinkResult {
  token: string;
  expiresAt: number;
}

export const DEFAULT_SHARE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// Mint a new share-link row. The token IS the primary key — the public URL
// is /d/<token>, so anyone holding the token can fetch the file until it
// expires or hits its max_downloads cap.
export async function createShareLink(
  userId: string,
  input: CreateShareLinkInput,
): Promise<CreateShareLinkResult> {
  const token = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? DEFAULT_SHARE_TTL_SECONDS;
  const expiresAt = now + ttl;
  const bucket = input.r2Bucket ?? "ATTACHMENTS";
  const maxDownloads =
    input.maxDownloads === undefined ? null : input.maxDownloads;

  await getDb()
    .prepare(
      `INSERT INTO r2_share_links
         (id, r2_bucket, r2_key, filename, content_type, size,
          expires_at, max_downloads, downloaded, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(
      token,
      bucket,
      input.r2Key,
      input.filename,
      input.contentType,
      input.size,
      expiresAt,
      maxDownloads,
      userId,
      now,
    )
    .run();

  return { token, expiresAt };
}

export type ConsumeFailure = "not_found" | "expired" | "exhausted";

export interface ConsumeShareLinkOk {
  ok: true;
  row: ShareLinkRow;
}

export interface ConsumeShareLinkFail {
  ok: false;
  reason: ConsumeFailure;
}

// Atomic increment + cap check. We do a conditional UPDATE that only matches
// when the link is still within its TTL and hasn't hit its download cap;
// SQLite reports the number of changed rows so we can tell whether the slot
// was actually consumed. If the UPDATE matched, we read the row back to
// stream from R2; if it didn't, we look up why (not found vs expired vs
// exhausted) so the caller can return a useful status code.
export async function consumeShareLink(
  token: string,
): Promise<ConsumeShareLinkOk | ConsumeShareLinkFail> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const update = await db
    .prepare(
      `UPDATE r2_share_links
          SET downloaded = downloaded + 1
        WHERE id = ?
          AND expires_at > ?
          AND (max_downloads IS NULL OR downloaded < max_downloads)`,
    )
    .bind(token, now)
    .run();

  // D1's `meta.changes` carries the rows-affected count. If it's >= 1 the
  // increment landed and the link was live at this exact instant — race
  // window for a tiny over-count exists, but is acceptable for v1.
  const changes = (update.meta?.changes ?? update.meta?.changed_db ?? 0) as number;
  if (changes && changes > 0) {
    const row = await db
      .prepare(
        `SELECT id, r2_bucket, r2_key, filename, content_type, size,
                expires_at, max_downloads, downloaded, created_by, created_at
           FROM r2_share_links WHERE id = ?`,
      )
      .bind(token)
      .first<ShareLinkRow>();
    if (row) return { ok: true, row };
    // Vanishingly rare: row deleted between UPDATE and SELECT. Treat as gone.
    return { ok: false, reason: "not_found" };
  }

  // The UPDATE didn't match — figure out why so the caller can pick 404 vs 410.
  const peek = await db
    .prepare(
      `SELECT expires_at, max_downloads, downloaded
         FROM r2_share_links WHERE id = ?`,
    )
    .bind(token)
    .first<{ expires_at: number; max_downloads: number | null; downloaded: number }>();
  if (!peek) return { ok: false, reason: "not_found" };
  if (peek.expires_at <= now) return { ok: false, reason: "expired" };
  if (peek.max_downloads !== null && peek.downloaded >= peek.max_downloads) {
    return { ok: false, reason: "exhausted" };
  }
  // Edge case: somebody else won the race and pushed us past the cap between
  // our UPDATE and our peek. Treat as exhausted.
  return { ok: false, reason: "exhausted" };
}
