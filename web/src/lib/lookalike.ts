// Lookalike-domain detection — defense against the "DKIM/DMARC pass on an
// attacker-controlled lookalike" pattern. Even when auth-results show
// pass/pass/pass, the *signing* domain may be an impersonation
// (paypa1.com, g00gle.com, аpple.com with Cyrillic а, xn--…). Three
// independent signals:
//
//   - punycode     — the domain is IDN-encoded (xn-- prefix on any label)
//   - mixed_script — the domain mixes ASCII letters with non-ASCII letters,
//                    catching most homograph attacks without a Unicode
//                    confusables table
//   - skeleton_match — after normalizing common digit-for-letter and
//                    letter-bigram substitutions, the domain matches a
//                    well-known brand it isn't
//
// Pure function, no I/O. Run server-side at render time.

// Frequently-spoofed brands. Compared against the apex (last two labels for
// most TLDs) of the sender domain after skeleton normalization. Keep this
// list short and high-confidence; expanding it grows false-positive risk.
const SPOOFED_BRANDS: ReadonlySet<string> = new Set([
  "paypal",
  "google",
  "microsoft",
  "apple",
  "amazon",
  "github",
  "slack",
  "dropbox",
  "fedex",
  "ups",
  "irs",
  "chase",
  "wellsfargo",
  "bankofamerica",
  "citibank",
  "americanexpress",
  "facebook",
  "linkedin",
  "instagram",
  "twitter",
  "discord",
  "netflix",
  "stripe",
  "coinbase",
  "binance",
  "docusign",
  "adobe",
  "zoom",
  "anthropic",
  "openai",
  "cloudflare",
]);

export interface LookalikeFinding {
  kind: "punycode" | "mixed_script" | "skeleton_match";
  // Populated for skeleton_match — the brand the domain resembles.
  resembles?: string;
}

// Walk all findings in priority order; return the most decisive one. Caller
// can switch on `kind` to phrase the warning. Order matters: mixed_script
// is the most damning (intentional impersonation), then punycode, then
// skeleton_match.
export function checkLookalike(
  domain: string,
  watchedDomains: ReadonlySet<string> = new Set(),
): LookalikeFinding | null {
  const lower = domain.toLowerCase();

  if (hasMixedScript(lower)) {
    return { kind: "mixed_script" };
  }

  if (hasPunycodeLabel(lower)) {
    return { kind: "punycode" };
  }

  const apex = apexLabel(lower);
  if (apex) {
    const skel = skeleton(apex);
    if (skel !== apex) {
      // Only flag if the *normalized* form matches a brand and the raw form
      // doesn't — i.e. there's a real substitution at play.
      if (SPOOFED_BRANDS.has(skel) && !SPOOFED_BRANDS.has(apex)) {
        return { kind: "skeleton_match", resembles: skel };
      }
      // Same check against caller-supplied watched domains (e.g. the user's
      // own host domain or their frequent-correspondent domains).
      for (const watched of watchedDomains) {
        const watchedApex = apexLabel(watched.toLowerCase());
        if (watchedApex && skel === watchedApex && apex !== watchedApex) {
          return { kind: "skeleton_match", resembles: watched };
        }
      }
    }
  }

  return null;
}

function hasPunycodeLabel(domain: string): boolean {
  // Any label starting with xn-- is IDN-encoded; the visible Unicode form
  // could be anything. Worth flagging as a heads-up.
  for (const label of domain.split(".")) {
    if (label.startsWith("xn--")) return true;
  }
  return false;
}

function hasMixedScript(domain: string): boolean {
  // Per-label check: a label is suspicious if it contains both ASCII letters
  // and non-ASCII letters. Pure ASCII labels and pure non-ASCII labels
  // (e.g. "中国.cn") are fine on their own — the danger is *mixing* in a
  // single label so two adjacent characters look like one.
  for (const label of domain.split(".")) {
    let hasAscii = false;
    let hasNonAscii = false;
    for (const ch of label) {
      const code = ch.codePointAt(0) ?? 0;
      if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
        hasAscii = true;
      } else if (code > 0x7f) {
        // Non-ASCII codepoint (any letter from another script). We don't
        // distinguish which script; mixing with ASCII is enough to flag.
        hasNonAscii = true;
      }
      if (hasAscii && hasNonAscii) return true;
    }
  }
  return false;
}

// Skeleton normalization. Collapse common confusables — both single-character
// (0→o, 1→l, 5→s) and the famous bigram (rn→m). Conservative: each rule was
// chosen because the false-positive rate is low against real-world domain
// names. We don't fold case here because input is already lowercased.
function skeleton(s: string): string {
  let out = s;
  // Bigram first so it doesn't get clobbered by single-char rules.
  out = out.replace(/rn/g, "m");
  out = out.replace(/[0]/g, "o");
  out = out.replace(/[1]/g, "l");
  out = out.replace(/[5]/g, "s");
  out = out.replace(/[3]/g, "e");
  out = out.replace(/vv/g, "w");
  return out;
}

// Last two labels of the domain — the registrable apex for almost every TLD
// we care about. Misses multi-label public suffixes (e.g. .co.uk) but that's
// fine for brand-lookalike detection: if someone registers paypal.co.uk we
// want to compare "paypal" against the brand list, not "co.uk".
function apexLabel(domain: string): string | null {
  const parts = domain.split(".").filter(Boolean);
  if (parts.length < 2) return null;
  // Two-label public suffixes: take the third-from-last when present, e.g.
  //   foo.bar.co.uk → "bar"
  //   foo.co.uk    → "foo"
  //   foo.com      → "foo"
  const suffixes = new Set([
    "co.uk",
    "co.jp",
    "com.au",
    "co.nz",
    "com.br",
    "co.in",
  ]);
  const last2 = parts.slice(-2).join(".");
  if (suffixes.has(last2) && parts.length >= 3) {
    return parts[parts.length - 3];
  }
  return parts[parts.length - 2];
}
