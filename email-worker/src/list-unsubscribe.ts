// Header parsers for newsletter unsubscribe metadata.
//
//   List-Unsubscribe (RFC 2369): `<https://...>, <mailto:...?subject=...>`
//     One or more comma-separated angle-bracketed URIs. https + mailto are
//     the only schemes we surface; older `http://` URLs would weaken the
//     SSRF mitigations on the action endpoint, so we drop them at parse
//     time rather than risk acting on them later.
//
//   List-Unsubscribe-Post (RFC 8058): `List-Unsubscribe=One-Click`
//     Sender-side opt-in to one-click unsubscribe — present, the receiver
//     may POST `List-Unsubscribe=One-Click` to an https URL from
//     List-Unsubscribe and treat 2xx as confirmation. Without this header,
//     the user must visit the URL in a browser instead.

export interface ListUnsubscribe {
  url: string | null;     // first https URL, or null
  mailto: string | null;  // first mailto URL, or null
  oneClick: boolean;      // List-Unsubscribe-Post advertises one-click AND we have a url
}

const EMPTY: ListUnsubscribe = { url: null, mailto: null, oneClick: false };

export function parseListUnsubscribe(
  headerValue: string | undefined,
  postHeaderValue: string | undefined,
): ListUnsubscribe {
  if (!headerValue) return EMPTY;

  // Find every <...> bracket-pair. Splitting on "," is unsafe — the URI
  // itself may contain commas (e.g. mailto with body= or subject= params).
  // The bracket-pair tokenizer sidesteps that entirely.
  const entries = extractBracketed(headerValue);

  let url: string | null = null;
  let mailto: string | null = null;
  for (const raw of entries) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (!url && /^https:\/\//i.test(trimmed)) {
      url = trimmed;
    } else if (!mailto && /^mailto:/i.test(trimmed)) {
      mailto = trimmed;
    }
    if (url && mailto) break;
  }

  const oneClick = !!url && hasOneClickPost(postHeaderValue);

  return { url, mailto, oneClick };
}

function extractBracketed(s: string): string[] {
  const out: string[] = [];
  const re = /<([^>]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(m[1]);
  }
  return out;
}

// RFC 8058 specifies `List-Unsubscribe=One-Click` as the literal value, but
// some senders emit extra whitespace or stray case. We match
// case-insensitively on the relevant key=value pair to stay tolerant
// without accepting completely unrelated bodies as one-click.
function hasOneClickPost(value: string | undefined): boolean {
  if (!value) return false;
  // Each pair separated by `,` per RFC; tolerant to whitespace.
  const pairs = value.split(",").map(p => p.trim()).filter(Boolean);
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const key = p.slice(0, eq).trim().toLowerCase();
    const val = p.slice(eq + 1).trim().toLowerCase();
    if (key === "list-unsubscribe" && val === "one-click") return true;
  }
  return false;
}

// Pull the headers out of postal-mime's flat header array. Postal-mime
// lowercases keys for us; we still defensively lowercase the lookup. The
// first occurrence wins — duplicates are unusual but RFC-permitted, and
// the first one is what mail clients display.
export function findHeader(
  headers: { key: string; value: string }[] | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const h of headers) {
    if (h.key.toLowerCase() === wanted) return h.value;
  }
  return undefined;
}
