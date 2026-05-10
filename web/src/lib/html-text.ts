// Cheap HTML → plain text. Runs in any environment (Workers, Node, browser) —
// no DOM required. Used by the send pipeline to derive a text/plain alternative
// from the Lexical HTML the composer produces, and by the drafts list to make
// a readable snippet from a stored HTML body.
//
// We don't try to be a full HTML renderer — Lexical's output is well-formed
// and has a small tag vocabulary (p, br, ul/ol/li, a, b/i/u/strong/em,
// blockquote, h1–h3). This handles those cases and falls back to "drop the
// tag" for anything else, which is good enough for plain-text alternatives.
export function htmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Looser detector: anything with an opening tag that looks like HTML. The
// composer always emits HTML; legacy plain-text drafts and templates won't.
// Used so we don't double-escape plain text on the send path.
export function looksLikeHtml(s: string): boolean {
  return /<\/?[a-z][\s\S]*?>/i.test(s);
}

// HTML → plain text optimised for use as the body of a Gmail-style quoted
// reply. Drops any pre-existing `<blockquote type="cite">` chains (the
// previous reply chain) so we don't snowball the quote each round-trip,
// then strips the rest with `htmlToText`. We also clamp length so a 5MB
// marketing email doesn't blow up the compose draft.
export function htmlToQuotedText(html: string, maxChars = 64_000): string {
  if (!html) return "";
  const trimmed = html.replace(/<blockquote[^>]*type=["']cite["'][^>]*>[\s\S]*?<\/blockquote>/gi, "");
  const text = htmlToText(trimmed);
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text;
}
