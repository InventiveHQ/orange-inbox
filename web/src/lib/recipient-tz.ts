import { getActiveMailDbs } from "./mail-db";
import { getEnv } from "./db";

// Best-effort recipient timezone inference.
//
// "9am in recipient's TZ" in the smart send-later menu needs a way to ask
// "what offset does this address tend to send mail from?". We answer that by
// looking at the most recent inbound mail we've received from the address
// and reading the offset off its Date header (the only place a sender's
// timezone is preserved — the messages.date column normalises everything to
// UNIX epoch and drops the offset).
//
// Constraints we hit during design:
//   - We don't store the offset as a separate column (no schema changes
//     allowed in v2). So the lookup pulls the raw .eml from R2 for each
//     candidate message. We cap at MAX_SAMPLES to keep the worst case at
//     a handful of R2 reads.
//   - No external libraries — we parse the Date header with a regex tuned
//     to RFC 5322 § 3.3.
//   - Multi-DB deploys: we ask every active mail DB. For most installs
//     there's only one, so this is a single SELECT.
//
// Returns the median offset from the samples we found. Median rather than
// mean because a single travel/notification email from another timezone
// shouldn't drag the answer.

const MAX_SAMPLES = 5;

export interface InferredTz {
  offsetMinutes: number;
  // Number of sampled messages that contributed. Always >0 when non-null.
  sampleSize: number;
}

export async function inferRecipientTz(fromAddr: string): Promise<InferredTz | null> {
  const addr = fromAddr.trim().toLowerCase();
  if (!addr || !addr.includes("@")) return null;

  const dbs = await getActiveMailDbs();
  if (dbs.length === 0) return null;

  // Pull the N most recent inbound message R2 keys across every active DB.
  // We over-fetch slightly so a couple of failed R2 reads don't starve us.
  const candidates: { raw_r2_key: string; date: number }[] = [];
  const perDbLimit = MAX_SAMPLES;
  for (const { db } of dbs) {
    try {
      const { results } = await db
        .prepare(
          `SELECT raw_r2_key, date FROM messages
            WHERE direction = 'inbound' AND lower(from_addr) = ?
            ORDER BY date DESC
            LIMIT ?`,
        )
        .bind(addr, perDbLimit)
        .all<{ raw_r2_key: string; date: number }>();
      for (const r of results ?? []) candidates.push(r);
    } catch {
      // One bad DB shouldn't tank inference; skip and continue.
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.date - a.date);
  const top = candidates.slice(0, MAX_SAMPLES);

  const env = getEnv() as { RAW_MAIL: R2Bucket };
  const offsets: number[] = [];
  for (const c of top) {
    try {
      const obj = await env.RAW_MAIL.get(c.raw_r2_key);
      if (!obj) continue;
      // Read just enough bytes to capture the headers — Date is required
      // to come early, so 8 KB is comfortably sufficient.
      const head = await readHead(obj.body, 8192);
      const off = extractDateOffset(head);
      if (off !== null) offsets.push(off);
    } catch {
      // skip — best-effort
    }
  }
  if (offsets.length === 0) return null;
  offsets.sort((a, b) => a - b);
  const median = offsets[Math.floor(offsets.length / 2)];
  return { offsetMinutes: median, sampleSize: offsets.length };
}

// Parse the *first* `Date:` header line in raw RFC 5322 source and return
// the timezone offset in minutes (positive east of UTC). Returns null if
// the header is missing or its TZ token isn't recognisable.
//
// Handles both numeric offsets (`+0200`, `-0700`) and the legacy named
// zones permitted by RFC 5322 (`UT`, `GMT`, `EST`, `EDT`, `CST`, `CDT`,
// `MST`, `MDT`, `PST`, `PDT`). Anything else is treated as unknown — the
// `(Pacific Standard Time)` style comments are ignored.
export function extractDateOffset(rawSource: string): number | null {
  // Header lines may be folded across multiple physical lines. Rejoin
  // continuations that begin with whitespace per RFC 5322 § 2.2.3.
  const unfolded = rawSource.replace(/\r?\n[ \t]+/g, " ");
  const m = unfolded.match(/^Date:\s*(.+)$/im);
  if (!m) return null;
  const value = m[1].trim();

  const numeric = value.match(/([+-])(\d{2})(\d{2})\b/);
  if (numeric) {
    const sign = numeric[1] === "-" ? -1 : 1;
    const h = parseInt(numeric[2], 10);
    const min = parseInt(numeric[3], 10);
    if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
    return sign * (h * 60 + min);
  }

  const named = value.match(/\b(UT|UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT)\b/);
  if (named) {
    const map: Record<string, number> = {
      UT: 0, UTC: 0, GMT: 0,
      EST: -5 * 60, EDT: -4 * 60,
      CST: -6 * 60, CDT: -5 * 60,
      MST: -7 * 60, MDT: -6 * 60,
      PST: -8 * 60, PDT: -7 * 60,
    };
    return map[named[1]] ?? null;
  }
  return null;
}

// Read up to `limit` bytes from a ReadableStream and return as UTF-8 text.
// Closes the stream early once we have enough.
async function readHead(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore — we're done with it anyway
    }
  }
  const buf = new Uint8Array(Math.min(total, limit));
  let pos = 0;
  for (const c of chunks) {
    if (pos >= buf.length) break;
    const take = Math.min(c.byteLength, buf.length - pos);
    buf.set(c.subarray(0, take), pos);
    pos += take;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}
