import { getDb, getEnv } from "./db";
import { getThreadDetail, type ThreadMessage } from "./queries";

// One-line AI thread summaries via Workers AI (0056). Generated lazily the
// first time a thread is opened, then cached on threads_index keyed by the
// thread's last_message_id so re-opens are instant and free, and a new inbound
// message invalidates the cache automatically.
//
// Small instruct model on purpose: a one-sentence gist doesn't need a frontier
// model, and keeping it on Workers AI means no external key and pennies of cost.
// (Drafting replies in the user's voice is a different, harder job — see the
// auto-drafts roadmap item — and would warrant a stronger model.)

const MODEL = "@cf/meta/llama-3.1-8b-instruct";
const MAX_INPUT_CHARS = 6000;
// Single short messages don't need summarising — the snippet already is one.
const MIN_SINGLE_MESSAGE_CHARS = 600;
const SYSTEM_PROMPT =
  "You summarise an email thread in ONE short sentence (max 22 words) that captures what it is about and any action the reader needs to take. Output only the sentence — no preamble, no quotes, no markdown.";

interface SummaryRow {
  summary: string | null;
  summary_message_id: string | null;
}

// Loose shape for the Workers AI text-generation result. The typed binding's
// `run` is overloaded per-model; we call it with a plain string model id, so
// we narrow the result ourselves rather than fight the overloads.
interface AiRunner {
  run: (model: string, opts: unknown) => Promise<{ response?: string }>;
}

export async function getThreadSummary(
  userId: string,
  threadId: string,
): Promise<string | null> {
  // getThreadDetail is user-scoped — this doubles as the access check.
  const detail = await getThreadDetail(userId, threadId);
  if (!detail || detail.messages.length === 0) return null;

  const messages = detail.messages;
  const last = messages[messages.length - 1];

  // One short message: nothing to compress.
  if (
    messages.length === 1 &&
    (messages[0].text_body ?? "").length < MIN_SINGLE_MESSAGE_CHARS
  ) {
    return null;
  }

  // Cache: reuse when the summary was built for the current last message.
  const cached = await getDb()
    .prepare(
      "SELECT summary, summary_message_id FROM threads_index WHERE thread_id = ?",
    )
    .bind(threadId)
    .first<SummaryRow>();
  if (cached?.summary && cached.summary_message_id === last.id) {
    return cached.summary;
  }

  const env = getEnv();
  // No AI binding (e.g. local dev without Workers AI) — degrade silently to any
  // stale cached summary, else nothing.
  if (!env.AI) return cached?.summary ?? null;

  let summary: string | null = null;
  try {
    const out = await (env.AI as unknown as AiRunner).run(MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildInput(messages) },
      ],
      max_tokens: 64,
    });
    summary = (out.response ?? "").trim().replace(/^["']+|["']+$/g, "") || null;
  } catch (err) {
    console.error("thread summary generation failed", err);
    return cached?.summary ?? null;
  }
  if (!summary) return null;

  try {
    await getDb()
      .prepare(
        "UPDATE threads_index SET summary = ?, summary_message_id = ? WHERE thread_id = ?",
      )
      .bind(summary, last.id, threadId)
      .run();
  } catch (err) {
    // A cache-write failure just means we regenerate next open — non-fatal.
    console.error("thread summary cache write failed", err);
  }
  return summary;
}

function buildInput(messages: ThreadMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const who = m.direction === "outbound" ? "Me" : m.from_name || m.from_addr;
    const body = (m.text_body ?? m.snippet ?? "").replace(/\s+/g, " ").trim();
    if (!body) continue;
    parts.push(`${who}: ${body}`);
  }
  const joined = parts.join("\n");
  if (joined.length <= MAX_INPUT_CHARS) return joined;
  // Keep the first message for context plus the most recent content (the tail),
  // which is what a one-liner should emphasise.
  return `${joined.slice(0, 800)}\n...\n${joined.slice(-(MAX_INPUT_CHARS - 800))}`;
}
