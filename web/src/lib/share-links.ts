import { AwsClient } from "aws4fetch";
import { getDb, getEnv } from "./db";

// Mail Drop share links — presigned R2 URLs.
//
// History: the original implementation routed recipients through a Worker
// route at /d/<token> which checked our own r2_share_links table, then
// streamed from R2. That route sits behind Cloudflare Access for our host
// Worker, so external recipients couldn't reach it. The fix is to link
// directly to R2 via S3-style presigned URLs — no Worker / Access in the
// path, the URL itself carries the auth signature.
//
// We keep the r2_share_links table for audit/cleanup tracking: a future
// cron can sweep R2 objects whose `expires_at` has passed.
//
// Operator setup (one-time): set the three secrets via wrangler:
//   wrangler secret put R2_ACCOUNT_ID
//   wrangler secret put R2_ACCESS_KEY_ID
//   wrangler secret put R2_SECRET_ACCESS_KEY
// R2 access keys come from the Cloudflare dashboard → R2 → Manage R2 API
// Tokens (scope to the ATTACHMENTS bucket, read-only). Without these
// secrets, createShareLink() throws at send time.
//
// Expiry note: S3-compatible presigned URLs cap at 7 days. The previous
// Worker-proxy supported 30 days; this is a regression in exchange for not
// requiring an Access bypass policy.

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
  r2Bucket?: string;        // R2 bucket NAME (default: orange-inbox-attachments)
  r2Key: string;
  filename: string | null;
  contentType: string | null;
  size: number;
  ttlSeconds?: number;       // capped at MAX_TTL_SECONDS (7 days)
  maxDownloads?: number | null;
}

export interface CreateShareLinkResult {
  token: string;
  url: string;                // presigned R2 URL — embed in the outbound body
  expiresAt: number;
}

// S3-compatible presigned URLs cap at 7 days (SigV4 X-Amz-Expires max).
export const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_SHARE_TTL_SECONDS = MAX_TTL_SECONDS;

// R2 bucket name as seen in `wrangler r2 bucket list`, not the binding
// identifier. `env.ATTACHMENTS` hides the underlying name; we have to
// hard-code it. setup.sh creates this bucket.
const SHARE_BUCKET_NAME = "orange-inbox-attachments";

interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function loadR2Credentials(): R2Credentials {
  const env = getEnv() as unknown as {
    R2_ACCOUNT_ID?: string;
    R2_ACCESS_KEY_ID?: string;
    R2_SECRET_ACCESS_KEY?: string;
  };
  const accountId = env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Mail Drop is not configured: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and " +
        "R2_SECRET_ACCESS_KEY as wrangler secrets. See README → Mail Drop.",
    );
  }
  return { accountId, accessKeyId, secretAccessKey };
}

async function presignR2GetUrl(
  creds: R2Credentials,
  bucketName: string,
  key: string,
  expiresInSeconds: number,
  contentDispositionFilename: string | null,
): Promise<string> {
  const aws = new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const url = new URL(
    `https://${creds.accountId}.r2.cloudflarestorage.com/${bucketName}/${encodedKey}`,
  );
  url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
  if (contentDispositionFilename) {
    url.searchParams.set(
      "response-content-disposition",
      `attachment; ${rfc5987DispositionFilename(contentDispositionFilename)}`,
    );
  }
  const signed = await aws.sign(url.toString(), {
    method: "GET",
    aws: { signQuery: true },
  });
  return signed.url;
}

function rfc5987DispositionFilename(name: string): string {
  const ascii = name
    .replace(/[\\"]/g, "_")
    .replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()]/g, c =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function createShareLink(
  userId: string,
  input: CreateShareLinkInput,
): Promise<CreateShareLinkResult> {
  const token = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const requestedTtl = input.ttlSeconds ?? DEFAULT_SHARE_TTL_SECONDS;
  const ttl = Math.min(requestedTtl, MAX_TTL_SECONDS);
  const expiresAt = now + ttl;
  const bucketName = input.r2Bucket ?? SHARE_BUCKET_NAME;
  const maxDownloads =
    input.maxDownloads === undefined ? null : input.maxDownloads;

  const creds = loadR2Credentials();
  const url = await presignR2GetUrl(
    creds,
    bucketName,
    input.r2Key,
    ttl,
    input.filename,
  );

  await getDb()
    .prepare(
      `INSERT INTO r2_share_links
         (id, r2_bucket, r2_key, filename, content_type, size,
          expires_at, max_downloads, downloaded, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(
      token,
      bucketName,
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

  return { token, url, expiresAt };
}
