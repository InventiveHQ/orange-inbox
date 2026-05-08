import { getActiveMailDbs } from "./mail-db";
import type { Env, ParsedMessage } from "./types";

export interface ThreadMatch {
  threadId: string;
  isNew: boolean;
  subjectNormalized: string;
}

const SUBJECT_FALLBACK_WINDOW_S = 60 * 60 * 24 * 14; // 14 days

// Pure helper, exported so future tests can hit it directly.
export function normalizeSubject(subject: string | undefined): string {
  let s = (subject ?? "").trim();
  // Strip nested reply/forward prefixes. RFC 5322 doesn't prescribe these but
  // they're universal: Re:, Fwd:, Fw:, Aw: (German), Tr: (French), Antw: (Dutch).
  while (true) {
    const stripped = s.replace(/^\s*(?:re|fwd|fw|aw|tr|antw)\s*:\s*/i, "");
    if (stripped === s) break;
    s = stripped;
  }
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s || "(no subject)";
}

// Returns the thread this message belongs to, creating one if needed.
// Strategy (closest to JWZ's algorithm, scoped to a single mailbox):
//   1. RFC chain: walk References + In-Reply-To, look for any existing message
//      with that Message-ID in the same mailbox.
//   2. Subject fallback: a recent (<= 14d) thread with the same normalized
//      subject in this mailbox.
//   3. Otherwise create a new thread.
export async function findOrCreateThread(
  env: Env,
  mailboxId: string,
  msg: ParsedMessage,
): Promise<ThreadMatch> {
  const subjectNormalized = normalizeSubject(msg.subject);

  const candidates = dedupe([...msg.references, msg.inReplyTo].filter((x): x is string => !!x));
  // Threading lookups have to span every mail DB — the parent message could
  // live anywhere. Fan out across active DBs and take the first hit.
  const mailDbs = await getActiveMailDbs(env);

  if (candidates.length > 0) {
    const placeholders = candidates.map(() => "?").join(",");
    for (const { db } of mailDbs) {
      const hit = await db
        .prepare(
          `SELECT thread_id FROM messages
           WHERE mailbox_id = ? AND message_id_header IN (${placeholders})
           LIMIT 1`,
        )
        .bind(mailboxId, ...candidates)
        .first<{ thread_id: string }>();
      if (hit) return { threadId: hit.thread_id, isNew: false, subjectNormalized };
    }
  }

  const cutoff = Math.floor(Date.now() / 1000) - SUBJECT_FALLBACK_WINDOW_S;
  for (const { db } of mailDbs) {
    const subjMatch = await db
      .prepare(
        `SELECT id FROM threads
         WHERE mailbox_id = ? AND subject_normalized = ? AND last_message_at >= ?
         ORDER BY last_message_at DESC LIMIT 1`,
      )
      .bind(mailboxId, subjectNormalized, cutoff)
      .first<{ id: string }>();
    if (subjMatch) return { threadId: subjMatch.id, isNew: false, subjectNormalized };
  }

  return { threadId: crypto.randomUUID(), isNew: true, subjectNormalized };
}

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
