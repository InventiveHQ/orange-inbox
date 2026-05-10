// Per-contact IANA timezone inference (#88).
//
// We support three sources, in precedence order:
//   1. manual    — the user typed it on the contact card
//   2. signature — heuristic scan over text the contact wrote (the most
//                  recent inbound message body, used as a stand-in for a
//                  proper signature-extraction pipeline which we don't yet
//                  have). Looks for tokens like "Pacific Time", "PT",
//                  "GMT+1", "Berlin", "Tokyo".
//   3. domain    — fall-back from the email TLD (.de → Europe/Berlin etc.)
//
// All three resolve to an IANA zone string; downstream code only ever
// renders Intl.DateTimeFormat against that string, no per-call parsing.
//
// The heuristic is intentionally tiny — a real NLP signature extractor is
// a separate effort. We err toward "no answer" rather than guessing wrong.

// City / region / common abbreviation → IANA. Earliest match wins, so put
// long phrases (e.g. "Pacific Standard Time") before short ones ("PT")
// when the order would otherwise produce a false positive on substring
// match. Keys are lower-cased for case-insensitive matching at scan time.
const SIGNATURE_HINTS: Array<[RegExp, string]> = [
  // Long-form names first — matched word-bounded so "Sydney" inside an
  // address doesn't trigger when the surrounding words make it clear it's
  // somebody's name; we accept that risk because the hit rate of false
  // positives on these heuristics is low and the user can always set a
  // manual override.
  [/\bpacific\s+(standard\s+|daylight\s+)?time\b/i, "America/Los_Angeles"],
  [/\bmountain\s+(standard\s+|daylight\s+)?time\b/i, "America/Denver"],
  [/\bcentral\s+(standard\s+|daylight\s+)?time\b/i, "America/Chicago"],
  [/\beastern\s+(standard\s+|daylight\s+)?time\b/i, "America/New_York"],
  [/\bbritish\s+summer\s+time\b/i, "Europe/London"],
  [/\bgreenwich\s+mean\s+time\b/i, "Europe/London"],
  [/\bcentral\s+european\s+(summer\s+)?time\b/i, "Europe/Berlin"],
  [/\beastern\s+european\s+(summer\s+)?time\b/i, "Europe/Helsinki"],
  [/\bwestern\s+european\s+(summer\s+)?time\b/i, "Europe/Lisbon"],
  [/\bindia\s+standard\s+time\b/i, "Asia/Kolkata"],
  [/\bjapan\s+standard\s+time\b/i, "Asia/Tokyo"],
  [/\baustralian\s+eastern\s+(standard\s+|daylight\s+)?time\b/i, "Australia/Sydney"],

  // Cities — useful when someone signs off "— Anna, Berlin".
  [/\bnew\s+york\b/i, "America/New_York"],
  [/\blos\s+angeles\b/i, "America/Los_Angeles"],
  [/\bsan\s+francisco\b/i, "America/Los_Angeles"],
  [/\bseattle\b/i, "America/Los_Angeles"],
  [/\bchicago\b/i, "America/Chicago"],
  [/\btoronto\b/i, "America/Toronto"],
  [/\bvancouver\b/i, "America/Vancouver"],
  [/\bberlin\b/i, "Europe/Berlin"],
  [/\bmunich\b/i, "Europe/Berlin"],
  [/\bhamburg\b/i, "Europe/Berlin"],
  [/\bfrankfurt\b/i, "Europe/Berlin"],
  [/\bvienna\b/i, "Europe/Vienna"],
  [/\bzurich\b/i, "Europe/Zurich"],
  [/\bgeneva\b/i, "Europe/Zurich"],
  [/\bparis\b/i, "Europe/Paris"],
  [/\bmadrid\b/i, "Europe/Madrid"],
  [/\bbarcelona\b/i, "Europe/Madrid"],
  [/\bamsterdam\b/i, "Europe/Amsterdam"],
  [/\brotterdam\b/i, "Europe/Amsterdam"],
  [/\bbrussels\b/i, "Europe/Brussels"],
  [/\bcopenhagen\b/i, "Europe/Copenhagen"],
  [/\bstockholm\b/i, "Europe/Stockholm"],
  [/\boslo\b/i, "Europe/Oslo"],
  [/\bhelsinki\b/i, "Europe/Helsinki"],
  [/\blondon\b/i, "Europe/London"],
  [/\bmanchester\b/i, "Europe/London"],
  [/\bedinburgh\b/i, "Europe/London"],
  [/\bdublin\b/i, "Europe/Dublin"],
  [/\bwarsaw\b/i, "Europe/Warsaw"],
  [/\bprague\b/i, "Europe/Prague"],
  [/\bbudapest\b/i, "Europe/Budapest"],
  [/\bathens\b/i, "Europe/Athens"],
  [/\bistanbul\b/i, "Europe/Istanbul"],
  [/\bmoscow\b/i, "Europe/Moscow"],
  [/\btokyo\b/i, "Asia/Tokyo"],
  [/\bosaka\b/i, "Asia/Tokyo"],
  [/\bkyoto\b/i, "Asia/Tokyo"],
  [/\bsingapore\b/i, "Asia/Singapore"],
  [/\bhong\s*kong\b/i, "Asia/Hong_Kong"],
  [/\bshanghai\b/i, "Asia/Shanghai"],
  [/\bbeijing\b/i, "Asia/Shanghai"],
  [/\bseoul\b/i, "Asia/Seoul"],
  [/\bbangalore\b/i, "Asia/Kolkata"],
  [/\bbengaluru\b/i, "Asia/Kolkata"],
  [/\bmumbai\b/i, "Asia/Kolkata"],
  [/\bnew\s+delhi\b/i, "Asia/Kolkata"],
  [/\bdelhi\b/i, "Asia/Kolkata"],
  [/\bdubai\b/i, "Asia/Dubai"],
  [/\btel\s+aviv\b/i, "Asia/Jerusalem"],
  [/\bjerusalem\b/i, "Asia/Jerusalem"],
  [/\bsydney\b/i, "Australia/Sydney"],
  [/\bmelbourne\b/i, "Australia/Melbourne"],
  [/\bbrisbane\b/i, "Australia/Brisbane"],
  [/\bperth\b/i, "Australia/Perth"],
  [/\bauckland\b/i, "Pacific/Auckland"],
  [/\bwellington\b/i, "Pacific/Auckland"],
  [/\bsao\s+paulo\b/i, "America/Sao_Paulo"],
  [/\bs[aã]o\s+paulo\b/i, "America/Sao_Paulo"],
  [/\bbuenos\s+aires\b/i, "America/Argentina/Buenos_Aires"],
  [/\bmexico\s+city\b/i, "America/Mexico_City"],

  // Numeric UTC offsets — these must come after long-form names so a
  // signature like "Pacific Time (GMT-8)" picks the proper IANA zone first.
  // We bucket each offset into a representative zone; not perfectly DST-
  // accurate but close enough for "their morning" suggestions.
  [/\b(?:gmt|utc)\s*[+-]?00?\b/i, "Etc/UTC"],
  [/\b(?:gmt|utc)\s*\+\s*0?1\b/i, "Europe/Berlin"],
  [/\b(?:gmt|utc)\s*\+\s*0?2\b/i, "Europe/Athens"],
  [/\b(?:gmt|utc)\s*\+\s*0?3\b/i, "Europe/Moscow"],
  [/\b(?:gmt|utc)\s*\+\s*0?4\b/i, "Asia/Dubai"],
  [/\b(?:gmt|utc)\s*\+\s*0?5\b/i, "Asia/Karachi"],
  [/\b(?:gmt|utc)\s*\+\s*0?5:30\b/i, "Asia/Kolkata"],
  [/\b(?:gmt|utc)\s*\+\s*0?6\b/i, "Asia/Dhaka"],
  [/\b(?:gmt|utc)\s*\+\s*0?7\b/i, "Asia/Bangkok"],
  [/\b(?:gmt|utc)\s*\+\s*0?8\b/i, "Asia/Singapore"],
  [/\b(?:gmt|utc)\s*\+\s*0?9\b/i, "Asia/Tokyo"],
  [/\b(?:gmt|utc)\s*\+\s*10\b/i, "Australia/Sydney"],
  [/\b(?:gmt|utc)\s*\+\s*12\b/i, "Pacific/Auckland"],
  [/\b(?:gmt|utc)\s*-\s*0?3\b/i, "America/Sao_Paulo"],
  [/\b(?:gmt|utc)\s*-\s*0?4\b/i, "America/New_York"],
  [/\b(?:gmt|utc)\s*-\s*0?5\b/i, "America/New_York"],
  [/\b(?:gmt|utc)\s*-\s*0?6\b/i, "America/Chicago"],
  [/\b(?:gmt|utc)\s*-\s*0?7\b/i, "America/Denver"],
  [/\b(?:gmt|utc)\s*-\s*0?8\b/i, "America/Los_Angeles"],
  [/\b(?:gmt|utc)\s*-\s*0?9\b/i, "America/Anchorage"],
  [/\b(?:gmt|utc)\s*-\s*10\b/i, "Pacific/Honolulu"],

  // Bare US abbreviations last — they're the most ambiguous (PT could be a
  // first-letter pair on someone's name, CST collides with China Standard
  // Time on a bad day) so they only win when nothing else matched.
  [/\bPDT\b/, "America/Los_Angeles"],
  [/\bPST\b/, "America/Los_Angeles"],
  [/\bMDT\b/, "America/Denver"],
  [/\bMST\b/, "America/Denver"],
  [/\bCDT\b/, "America/Chicago"],
  [/\bEDT\b/, "America/New_York"],
  [/\bEST\b/, "America/New_York"],
  [/\bBST\b/, "Europe/London"],
  [/\bCET\b/, "Europe/Berlin"],
  [/\bCEST\b/, "Europe/Berlin"],
  [/\bIST\b/, "Asia/Kolkata"],
  [/\bJST\b/, "Asia/Tokyo"],
  [/\bAEST\b/, "Australia/Sydney"],
  [/\bAEDT\b/, "Australia/Sydney"],

  // 2-letter US abbreviations are too ambiguous for word-boundary matching
  // (PT, CT) — only honour them when the surrounding text already mentions
  // "time".
  [/\b(?:PT|Pacific\s+T(?:ime|ZONE))\b.*?\btime\b/i, "America/Los_Angeles"],
  [/\bMT\b.*?\btime\b/i, "America/Denver"],
  [/\bCT\b.*?\btime\b/i, "America/Chicago"],
  [/\bET\b.*?\btime\b/i, "America/New_York"],
];

// Top-level domain → IANA. Used as a last-resort fallback. Only the cases
// where the country effectively has one zone — multi-zone countries like
// .us, .ca, .ru, .br stay null because guessing wrong is worse than
// nothing.
const TLD_FALLBACK: Record<string, string> = {
  uk: "Europe/London",
  gb: "Europe/London",
  ie: "Europe/Dublin",
  de: "Europe/Berlin",
  at: "Europe/Vienna",
  ch: "Europe/Zurich",
  fr: "Europe/Paris",
  es: "Europe/Madrid",
  pt: "Europe/Lisbon",
  it: "Europe/Rome",
  nl: "Europe/Amsterdam",
  be: "Europe/Brussels",
  dk: "Europe/Copenhagen",
  se: "Europe/Stockholm",
  no: "Europe/Oslo",
  fi: "Europe/Helsinki",
  pl: "Europe/Warsaw",
  cz: "Europe/Prague",
  sk: "Europe/Bratislava",
  hu: "Europe/Budapest",
  ro: "Europe/Bucharest",
  bg: "Europe/Sofia",
  gr: "Europe/Athens",
  tr: "Europe/Istanbul",
  ua: "Europe/Kyiv",
  jp: "Asia/Tokyo",
  kr: "Asia/Seoul",
  cn: "Asia/Shanghai",
  hk: "Asia/Hong_Kong",
  tw: "Asia/Taipei",
  sg: "Asia/Singapore",
  my: "Asia/Kuala_Lumpur",
  th: "Asia/Bangkok",
  vn: "Asia/Ho_Chi_Minh",
  ph: "Asia/Manila",
  id: "Asia/Jakarta",
  in: "Asia/Kolkata",
  pk: "Asia/Karachi",
  ae: "Asia/Dubai",
  sa: "Asia/Riyadh",
  il: "Asia/Jerusalem",
  au: "Australia/Sydney",
  nz: "Pacific/Auckland",
  za: "Africa/Johannesburg",
  ng: "Africa/Lagos",
  eg: "Africa/Cairo",
  ke: "Africa/Nairobi",
  ar: "America/Argentina/Buenos_Aires",
  cl: "America/Santiago",
  co: "America/Bogota",
  pe: "America/Lima",
  ve: "America/Caracas",
  mx: "America/Mexico_City",
  cu: "America/Havana",
  is: "Atlantic/Reykjavik",
};

// Run the signature heuristic against an already-extracted signature trailer
// block. Returns the IANA zone of the first rule that hits, or null if
// nothing did. Callers are responsible for running `extractSignature` on
// the raw body first — feeding a whole message body in here works (the
// heuristics are tolerant) but produces noisier results than the trimmed
// signature does, and bypasses the 1KB-cap that the extractor enforces.
export function inferTzFromSignature(signatureText: string | null | undefined): string | null {
  if (!signatureText) return null;
  // Defensive cap. The extractor already trims to ~1KB, but we may also be
  // called from older code paths or tests with raw text — keep a generous
  // tail so a passed-in body still produces a sensible answer.
  const tail =
    signatureText.length > 4096
      ? signatureText.slice(signatureText.length - 4096)
      : signatureText;
  for (const [re, zone] of SIGNATURE_HINTS) {
    if (re.test(tail)) return zone;
  }
  return null;
}

// Domain TLD fallback. Returns the IANA zone or null when the country has
// multiple zones (or we don't have a mapping).
export function inferTzFromDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at === -1) return null;
  const domain = email.slice(at + 1).toLowerCase();
  if (!domain) return null;
  // Use the public-suffix-ish last label. Doesn't handle SLDs like
  // .co.uk explicitly because the last label is correct in those cases too
  // (uk → Europe/London).
  const lastDot = domain.lastIndexOf(".");
  if (lastDot === -1) return null;
  const tld = domain.slice(lastDot + 1);
  return TLD_FALLBACK[tld] ?? null;
}

// Source precedence: manual > signature > domain. Higher number wins.
const SOURCE_RANK = { manual: 3, signature: 2, domain: 1 } as const;
export type ContactTzSource = keyof typeof SOURCE_RANK;

export function shouldOverwriteTz(
  existingSource: string | null,
  newSource: ContactTzSource,
): boolean {
  if (!existingSource) return true;
  const existing = SOURCE_RANK[existingSource as ContactTzSource];
  if (existing === undefined) return true;
  return SOURCE_RANK[newSource] >= existing;
}

// Quick-and-dirty IANA validation. We don't want to write a malformed zone
// string into the DB and then explode in Intl.DateTimeFormat at render
// time. `Intl.supportedValuesOf` is the cleanest check; falls back to a
// constructor probe if it isn't available in the runtime.
export function isValidIanaTz(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    // Constructor throws RangeError on unknown zones — reliable across
    // Node, Chrome, and the Workers runtime.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
