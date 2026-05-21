// RFC 8601 Authentication-Results parser.
//
// SECURITY: this parser operates on exactly ONE Authentication-Results
// header value — the one stamped by our trusted mail receiver. The caller
// (parse.ts) is responsible for selecting that single header and MUST NOT
// pass an attacker-influenced or `;`-merged value. An inbound message can
// carry attacker-authored Authentication-Results lines; merging them would
// let a forged "pass" verdict win. Keep this function single-header.
//
// We only care about the spf / dkim / dmarc verdicts and the from-domain
// reported by DMARC (header.from=…). The header has a fairly forgiving
// grammar — the value starts with an authserv-id, then methods separated
// by `;`, each method has the form `method=result key=val key=val …`, and
// `(comments)` can show up at most places. We tolerate:
//   * leading authserv-id segment (the first `;`-delimited chunk that has
//     no `=` outside parens)
//   * arbitrary whitespace/folding (postal-mime already unfolds for us)
//   * upper/lower case method+result names
//   * comments anywhere — `( … )`, possibly nested one level
//   * ARC-Authentication-Results / unknown methods — silently skipped
//
// What we DON'T do:
//   * verify any signature ourselves — Cloudflare's MX has already done
//     that and stamped the verdict; we trust the header.
//   * parse the comment-policy hints (e.g. policy=reject) — UI just cares
//     about pass/fail.
//
// Returns null when there's no recognizable verdict at all (e.g. header
// was just an authserv-id with no methods). Otherwise unknown methods
// default to "none".

export type AuthVerdict =
  | "pass"
  | "fail"
  | "softfail"
  | "neutral"
  | "none"
  | "temperror"
  | "permerror"
  | "policy";

export interface AuthResults {
  spf: AuthVerdict;
  dkim: AuthVerdict;
  dmarc: AuthVerdict;
  from_domain: string | null;
}

const VERDICTS: ReadonlySet<AuthVerdict> = new Set([
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
  "policy",
]);

// Strip RFC 5322 CFWS comments. We just delete `(...)` runs; nested parens
// are rare in this header but we handle one level by counting depth.
function stripComments(s: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")" && depth > 0) {
      depth--;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

// Lowercase and trim a token. Quoted strings keep their interior verbatim
// minus the quotes; we don't lowercase those (e.g. header.from values).
function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1);
  }
  return t;
}

// One method=result chunk — yields { method, verdict, props }. Props is
// a flat map of key=val pairs that came after the verdict (e.g.
// header.from=foo.com). All keys are lowercased.
interface MethodChunk {
  method: string;
  verdict: AuthVerdict | null;
  props: Map<string, string>;
}

function parseChunk(chunk: string): MethodChunk | null {
  const trimmed = chunk.trim();
  if (!trimmed) return null;

  // Tokenize on whitespace, but keep `key=val` pairs intact. Simple state
  // machine: we don't have to handle quoted whitespace inside values for
  // the props we care about (header.from is a domain, no spaces).
  const tokens: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '"') {
      inQuote = !inQuote;
      cur += ch;
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  if (tokens.length === 0) return null;

  // First token is "method=verdict" (or "method = verdict" — already
  // collapsed by tokenization above only if there was no whitespace).
  // Be tolerant: also accept method as first token and =verdict glued to
  // the second token.
  let head = tokens[0];
  let rest = tokens.slice(1);
  if (!head.includes("=") && rest.length > 0 && rest[0].startsWith("=")) {
    head = head + rest[0];
    rest = rest.slice(1);
  }

  const eq = head.indexOf("=");
  if (eq === -1) return null;

  const method = head.slice(0, eq).trim().toLowerCase();
  const verdictRaw = unquote(head.slice(eq + 1)).toLowerCase();
  const verdict = VERDICTS.has(verdictRaw as AuthVerdict)
    ? (verdictRaw as AuthVerdict)
    : null;

  const props = new Map<string, string>();
  for (const tok of rest) {
    const e = tok.indexOf("=");
    if (e === -1) continue;
    const k = tok.slice(0, e).trim().toLowerCase();
    const v = unquote(tok.slice(e + 1));
    if (k && !props.has(k)) props.set(k, v);
  }

  return { method, verdict, props };
}

/**
 * Extract the authserv-id from a SINGLE Authentication-Results header
 * value — the first `;`-delimited segment, which per RFC 8601 is the
 * authserv-id (an unkeyed token, optionally followed by an ` 1` version).
 * Comments are stripped first. Returned lowercased for case-insensitive
 * comparison; null when the header has no leadable authserv-id token.
 *
 * Note: a method chunk (`spf=pass …`) contains `=`, so if the first
 * segment contains `=` the header has no authserv-id and we return null.
 */
export function extractAuthservId(headerValue: string | undefined | null): string | null {
  if (!headerValue) return null;
  const cleaned = stripComments(headerValue).trim();
  if (!cleaned) return null;
  const first = cleaned.split(";", 1)[0]?.trim();
  if (!first) return null;
  // A method chunk has `key=value`; the authserv-id segment does not.
  if (first.includes("=")) return null;
  // The authserv-id may be followed by an optional version token
  // (`authserv-id 1`). Take the first whitespace-delimited token.
  const token = first.split(/\s+/)[0];
  return token ? token.toLowerCase() : null;
}

/**
 * Parse a SINGLE Authentication-Results header value. The caller MUST
 * pass exactly one header value (the one stamped by the trusted MX) —
 * never a `;`-merge of multiple headers, since attacker-supplied headers
 * would then be honored. The function splits the value on `;` to walk
 * the leading authserv-id segment and each `method=result` chunk.
 *
 * Returns null when there is no spf / dkim / dmarc verdict at all.
 * Otherwise missing methods default to "none" — this keeps the UI's
 * "all three pass" check a simple equality.
 */
export function parseAuthenticationResults(headerValue: string | undefined | null): AuthResults | null {
  if (!headerValue) return null;
  const cleaned = stripComments(headerValue).trim();
  if (!cleaned) return null;

  // Split on `;`. The first segment is the authserv-id and has no `=`
  // (e.g. "mx.example.com"); parseChunk returns null for it so it is
  // skipped. Method chunks all contain `=`.
  const segments = cleaned.split(";").map(s => s.trim()).filter(Boolean);

  const verdicts: Record<string, AuthVerdict> = {};
  let fromDomain: string | null = null;
  let sawAny = false;

  for (const seg of segments) {
    const chunk = parseChunk(seg);
    if (!chunk || !chunk.verdict) continue;

    if (chunk.method === "spf" || chunk.method === "dkim" || chunk.method === "dmarc") {
      // First verdict wins per method. Some MTAs stamp multiple DKIM
      // results (one per signature); we take the first since DMARC's
      // alignment check has already considered them in aggregate.
      if (!(chunk.method in verdicts)) {
        verdicts[chunk.method] = chunk.verdict;
        sawAny = true;
      }

      // Pull from-domain off DMARC (preferred) or fall back to SPF's
      // smtp.mailfrom domain part, then DKIM's header.d.
      if (!fromDomain) {
        const hf = chunk.props.get("header.from");
        if (hf) fromDomain = hf.toLowerCase();
      }
      if (!fromDomain && chunk.method === "dkim") {
        const hd = chunk.props.get("header.d");
        if (hd) fromDomain = hd.toLowerCase();
      }
      if (!fromDomain && chunk.method === "spf") {
        const mf = chunk.props.get("smtp.mailfrom");
        if (mf) {
          const at = mf.lastIndexOf("@");
          fromDomain = (at === -1 ? mf : mf.slice(at + 1)).toLowerCase();
        }
      }
    }
  }

  if (!sawAny) return null;

  return {
    spf: verdicts.spf ?? "none",
    dkim: verdicts.dkim ?? "none",
    dmarc: verdicts.dmarc ?? "none",
    from_domain: fromDomain,
  };
}
