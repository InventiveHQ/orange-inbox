import { getEnv } from "./db";
import { getThreadDetail, type ThreadMessage } from "./queries";

// "Add to calendar from an email" extraction (Workers AI). Reads a thread and
// pulls out a single calendar event — title, start/end, location — resolving
// relative dates ("next Tuesday at 3pm", "tomorrow", "EOD Friday") against the
// caller's current local time + timezone, both passed in from the browser so
// the model has a concrete anchor and we never do timezone math server-side.
//
// Times come back as LOCAL wall-clock strings ("YYYY-MM-DDTHH:MM"); the client
// converts those to unix seconds the same way the event form does (interpreting
// them in the browser's zone, which is the user's zone). The result is always
// reviewed in the prefilled composer before saving — so a model slip on the
// exact time is a quick fix, not a silently-wrong event.

const MODEL = "@cf/meta/llama-3.1-8b-instruct";
const MAX_INPUT_CHARS = 4000;
const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export interface EventSuggestion {
  found: boolean;
  title: string | null;
  start_local: string | null;
  end_local: string | null;
  all_day: boolean;
  location: string | null;
}

interface AiRunner {
  run: (model: string, opts: unknown) => Promise<{ response?: string }>;
}

const EMPTY: EventSuggestion = {
  found: false,
  title: null,
  start_local: null,
  end_local: null,
  all_day: false,
  location: null,
};

export async function extractEventFromThread(
  userId: string,
  threadId: string,
  nowLocal: string,
  tz: string,
): Promise<EventSuggestion> {
  // user-scoped — doubles as the access check.
  const detail = await getThreadDetail(userId, threadId);
  if (!detail || detail.messages.length === 0) return EMPTY;

  const env = getEnv();
  if (!env.AI) return EMPTY;

  const subject =
    detail.messages[0]?.subject ?? detail.thread.subject_normalized ?? "";
  const system =
    "You extract a SINGLE calendar event from an email thread. Resolve any relative date/time " +
    "(e.g. 'next Tuesday', 'tomorrow at 3pm', 'EOD Friday') to an absolute LOCAL date-time using the " +
    "current local date-time and timezone provided. Reply with ONLY a JSON object, no prose, of the form: " +
    '{"found": boolean, "title": string, "start": "YYYY-MM-DDTHH:MM" | null, "end": "YYYY-MM-DDTHH:MM" | null, ' +
    '"all_day": boolean, "location": string | null}. ' +
    "Set found=false (and other fields null) if the thread mentions no specific date or time to put on a calendar. " +
    "Prefer a concise title drawn from the subject. Use all_day=true only for date-without-time mentions.";
  const user =
    `Current local date-time: ${nowLocal}\nTimezone: ${tz}\n\n` +
    `Subject: ${subject}\n\n${buildInput(detail.messages)}`;

  let raw = "";
  try {
    const out = await (env.AI as unknown as AiRunner).run(MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 200,
    });
    raw = out.response ?? "";
  } catch (err) {
    console.error("event extraction failed", err);
    return EMPTY;
  }

  return normalise(parseJsonObject(raw), subject);
}

// Pull the first balanced {...} block out of the model output and JSON.parse
// it. Small models sometimes wrap JSON in prose or code fences, so we don't
// trust the whole string.
function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalise(
  obj: Record<string, unknown> | null,
  subjectFallback: string,
): EventSuggestion {
  if (!obj || obj.found !== true) return EMPTY;
  const start = typeof obj.start === "string" && LOCAL_RE.test(obj.start) ? obj.start : null;
  // A "found" event with no usable start is useless — treat as not found so the
  // client falls back to a sensible default time.
  if (!start) return EMPTY;
  const end = typeof obj.end === "string" && LOCAL_RE.test(obj.end) ? obj.end : null;
  const title =
    typeof obj.title === "string" && obj.title.trim()
      ? obj.title.trim().slice(0, 200)
      : subjectFallback.slice(0, 200) || "Event";
  return {
    found: true,
    title,
    start_local: start,
    end_local: end && end > start ? end : null,
    all_day: obj.all_day === true,
    location:
      typeof obj.location === "string" && obj.location.trim()
        ? obj.location.trim().slice(0, 300)
        : null,
  };
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
  return joined.length <= MAX_INPUT_CHARS ? joined : joined.slice(0, MAX_INPUT_CHARS);
}
