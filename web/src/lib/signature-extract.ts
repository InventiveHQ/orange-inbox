// Signature trailer extractor (#98).
//
// Pulls the bottom "signature block" out of a free-form message body so
// downstream heuristics (timezone inference today, future phone / role /
// company extraction) operate on the right ~few lines instead of the whole
// 4kB tail. Two strategies, in confidence order:
//
//   1. RFC 3676 sig delimiter — look for `\n-- \n` (dash-dash-space-newline).
//      Everything below is the signature. This is what well-behaved mail
//      clients emit, so when present it's authoritative.
//
//   2. Bottom-block heuristic — walk up from the last non-empty line.
//      A "signature line" is short (< 80 chars) and matches one of the
//      shape tokens we recognise: a personal-name-shaped capitalised
//      pair, an email, a phone number, a URL, a job-title keyword, a
//      city / region. We grow the block as long as consecutive lines
//      look signature-y; we accept it only if at least 3 such lines run
//      in a row (less than that is most often a sign-off like "Best,").
//
// Reply quotes (`>` prefixed lines) at the start of the candidate block
// are stripped, since users sometimes type their signature inline above
// quoted reply text.
//
// Output is capped at ~1KB — bigger than that and we're almost certainly
// pulling in real message body, not signature.
//
// NEVER throws. Returns null on garbage input (empty / non-string / nothing
// recognisable). Callers should treat null as "no signature found".

const MAX_SIG_BYTES = 1024;
const MAX_SIG_LINE_LEN = 80;
const MIN_RUN_FOR_HEURISTIC = 3;

// Job / role keywords we'll accept as a "signature line" hit. Lower-cased
// substring match — keep the list short, common-case oriented.
const TITLE_KEYWORDS = [
  "ceo", "cto", "cfo", "coo", "cmo", "cpo", "vp ", "vp,", "svp", "evp",
  "founder", "co-founder", "cofounder", "owner", "principal", "partner",
  "director", "manager", "lead", "head of", "chief", "president",
  "engineer", "developer", "designer", "architect", "scientist",
  "consultant", "analyst", "advisor", "associate", "specialist",
  "marketing", "sales", "product", "engineering", "operations", "finance",
  "legal", "counsel", "attorney", "recruiter",
];

// Common city / region tokens — kept tiny and overlapping with the tz
// inference list intentionally; the goal here is "does this line look like
// a sig line" not "where do they live". Lower-cased.
const PLACE_HINTS = [
  "new york", "los angeles", "san francisco", "seattle", "chicago",
  "boston", "austin", "denver", "portland", "atlanta", "miami",
  "toronto", "vancouver", "montreal",
  "london", "manchester", "edinburgh", "dublin", "paris", "berlin",
  "munich", "hamburg", "vienna", "zurich", "geneva", "amsterdam",
  "rotterdam", "brussels", "copenhagen", "stockholm", "oslo", "helsinki",
  "madrid", "barcelona", "lisbon", "rome", "milan", "athens", "warsaw",
  "prague", "budapest",
  "tokyo", "osaka", "seoul", "singapore", "hong kong", "shanghai",
  "beijing", "bangalore", "bengaluru", "mumbai", "delhi", "dubai",
  "tel aviv", "jerusalem",
  "sydney", "melbourne", "brisbane", "perth", "auckland", "wellington",
  "sao paulo", "buenos aires", "mexico city",
];

// Crude email shape — we don't care about exact RFC 5322 conformance.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// Phone: at least 7 digits with the usual punctuation slop. Tolerates
// "+1 415-555-0100", "(415) 555-0100", "415.555.0100", etc.
const PHONE_RE = /(?:\+?\d[\s\-.()]*){7,}/;
// URLs / web shorthand — bare domains count too.
const URL_RE = /(?:https?:\/\/|www\.)\S+|(?:\b[A-Za-z0-9-]+\.(?:com|org|net|io|co|app|dev|ai|me|us|uk|de|fr|jp|au|ca|nl|se|no|fi|dk|ch|at|es|it|pt|ie|nz|in|sg|hk|tw)\b)/i;
// Capitalised "First Last" pair, allowing accented letters and an optional
// middle initial. Keeps the regex tight enough that a sentence like "We
// Built Something" doesn't trip it (the trailing word would have to be
// capitalised too — happens, but rare in body text).
const NAME_RE = /^[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-Z]\.)?\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+/;

// Returns true when `line` (already trimmed) shape-matches a typical
// signature line. The line must be reasonably short — longer lines are
// almost always body text.
function looksLikeSigLine(line: string): boolean {
  if (!line) return false;
  if (line.length > MAX_SIG_LINE_LEN) return false;
  // Strip a leading reply quote so a quoted signature still matches.
  const stripped = line.replace(/^>+\s*/, "").trim();
  if (!stripped) return false;
  if (stripped.length > MAX_SIG_LINE_LEN) return false;

  if (EMAIL_RE.test(stripped)) return true;
  if (URL_RE.test(stripped)) return true;
  if (PHONE_RE.test(stripped)) return true;
  if (NAME_RE.test(stripped)) return true;

  const lower = stripped.toLowerCase();
  if (TITLE_KEYWORDS.some(k => lower.includes(k))) return true;
  if (PLACE_HINTS.some(p => lower.includes(p))) return true;

  return false;
}

// Strip leading `>` quote markers from each line of a captured signature
// block. We don't attempt to undo deeper quote nesting — anything that
// quoted is unlikely to be a real sig anyway.
function stripQuotes(text: string): string {
  return text
    .split("\n")
    .map(l => l.replace(/^>+\s?/, ""))
    .join("\n");
}

// Cap text at the last MAX_SIG_BYTES bytes (roughly — JS strings are UTF-16
// code units, but for the purposes of "don't return half a message" the
// distinction doesn't matter).
function capTail(text: string): string {
  if (text.length <= MAX_SIG_BYTES) return text;
  return text.slice(text.length - MAX_SIG_BYTES);
}

// Public entry point. Best-effort, never throws.
export function extractSignature(body: string | null | undefined): string | null {
  if (!body || typeof body !== "string") return null;
  let text: string;
  try {
    // Normalise CRLF and remove any trailing whitespace-only run so the
    // delimiter check sees `\n-- \n` even when the source file ends with
    // a stray blank line.
    text = body.replace(/\r\n/g, "\n").replace(/\s+$/u, "");
  } catch {
    return null;
  }
  if (!text) return null;

  // Strategy 1: RFC 3676 sig delimiter. Some senders forget the trailing
  // space ("--\n") so we accept both — the trailing-space form is the spec
  // but the bare form is overwhelmingly common in the wild.
  const rfcIdx = findSigDelimiter(text);
  if (rfcIdx !== -1) {
    const sig = text.slice(rfcIdx).replace(/^\n?-- ?\n/, "").trim();
    if (sig) return capTail(stripQuotes(sig)).trim() || null;
    // Delimiter present but body below is empty — fall through.
  }

  // Strategy 2: bottom-block heuristic. Walk up from the last non-empty
  // line, growing a candidate block as long as consecutive lines look
  // signature-y. Empty lines reset the run but stay inside the block —
  // many sigs have a blank line between the name and the contact details.
  const lines = text.split("\n");
  // Find the last non-empty line index.
  let end = lines.length - 1;
  while (end >= 0 && lines[end].trim() === "") end--;
  if (end < 0) return null;

  let start = end;
  let run = 0;
  let bestRun = 0;
  for (let i = end; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === "") {
      // Blank line. Keep the block growing — but reset the run counter so
      // we require another sig-line streak to extend further upward.
      // Stop if we've already seen >1 blank lines in a row; that's almost
      // certainly the boundary between body and signature.
      if (i > 0 && lines[i - 1].trim() === "") {
        break;
      }
      continue;
    }
    if (looksLikeSigLine(trimmed)) {
      run++;
      if (run > bestRun) bestRun = run;
      start = i;
    } else {
      // Non-sig-shape line. If we already have a qualifying run, stop —
      // this is the body. Otherwise, the recent lines might just be the
      // sign-off ("Best regards,") or a name line that didn't match the
      // strict NAME_RE; keep walking but reset the run.
      if (run >= MIN_RUN_FOR_HEURISTIC) break;
      run = 0;
    }
  }

  if (bestRun < MIN_RUN_FOR_HEURISTIC) return null;
  // Slice from `start` through `end` inclusive.
  const block = lines.slice(start, end + 1).join("\n").trim();
  if (!block) return null;
  return capTail(stripQuotes(block)).trim() || null;
}

// Find the byte index of the RFC 3676 signature delimiter, or -1. We accept
// both the spec-correct `\n-- \n` and the common-in-the-wild `\n--\n`.
function findSigDelimiter(text: string): number {
  // Prefer the spec form when present.
  let idx = text.indexOf("\n-- \n");
  if (idx !== -1) return idx;
  idx = text.indexOf("\n--\n");
  if (idx !== -1) return idx;
  // Body might start with the delimiter (no leading newline).
  if (text.startsWith("-- \n") || text.startsWith("--\n")) return 0;
  return -1;
}
