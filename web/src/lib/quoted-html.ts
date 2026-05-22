// Browser-only. Turns an inbound message's full HTML body into a fragment
// safe to embed as a Gmail-style reply quote inside the Lexical editor, so a
// quoted email keeps its tables, lists and formatting instead of collapsing
// to flat text.
//
// "Safe" here is about structural sanity, not XSS defence: the fragment is
// handed to Lexical's $generateNodesFromDOM, which rebuilds the editor DOM
// from recognised node types only — raw <script>, inline handlers and unknown
// elements never survive that round-trip. What we do here is:
//   - drop document chrome (head/style/script/comments) Lexical would ignore,
//   - drop the previous reply chain so quotes don't snowball each round-trip,
//   - unwrap single-cell layout tables (email HTML nests tables purely for
//     centring; Lexical supports one level, so collapsing the scaffolding
//     keeps the real data table importable),
//   - strip on* attributes and javascript: URLs as defence in depth.
//
// Returns null when there's no usable body or the fragment is too large to be
// worth importing — the caller falls back to a plain-text quote.

// Marketing emails routinely run 100s of KB of nested-table layout. Past this
// the import is both slow and unlikely to render usefully, so we bail to text.
const MAX_QUOTED_HTML = 60_000;

export function sanitizeQuotedHtml(rawHtml: string): string | null {
  if (!rawHtml) return null;

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(rawHtml, "text/html");
  } catch {
    return null;
  }
  const body = doc.body;
  if (!body) return null;

  // Document chrome and non-renderable elements.
  body
    .querySelectorAll("script, style, link, meta, title, head, noscript, base")
    .forEach((el) => el.remove());

  // Comments — Outlook-generated mail is full of conditional comments.
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
  const comments: Comment[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode as Comment);
  comments.forEach((c) => c.remove());

  // Previous reply chain — drop it so the quote doesn't snowball.
  body.querySelectorAll('blockquote[type="cite"]').forEach((el) => el.remove());

  // Inline scripting surface. Lexical drops these on import anyway; stripping
  // them keeps the fragment clean for any other consumer.
  body.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
    const href = el.getAttribute("href");
    if (href && /^\s*javascript:/i.test(href)) el.removeAttribute("href");
    const src = el.getAttribute("src");
    if (src && /^\s*javascript:/i.test(src)) el.removeAttribute("src");
  });

  // Unwrap layout tables: a <table> whose only content is one row with one
  // cell is centring scaffolding, not data. Iterate until stable since layout
  // tables nest several deep; the bound stops a pathological document.
  for (let pass = 0; pass < 8; pass++) {
    const layout = [...body.querySelectorAll("table")].filter(isSingleCellTable);
    if (layout.length === 0) break;
    layout.forEach(unwrapSingleCellTable);
  }

  const html = body.innerHTML.trim();
  if (!html || html.length > MAX_QUOTED_HTML) return null;
  return html;
}

function isSingleCellTable(table: HTMLTableElement): boolean {
  const rows = table.querySelectorAll(
    ":scope > tbody > tr, :scope > thead > tr, :scope > tr",
  );
  if (rows.length !== 1) return false;
  const cells = rows[0].querySelectorAll(":scope > td, :scope > th");
  return cells.length === 1;
}

function unwrapSingleCellTable(table: HTMLTableElement): void {
  const cell = table.querySelector("td, th");
  if (!cell || !table.parentNode) return;
  while (cell.firstChild) table.parentNode.insertBefore(cell.firstChild, table);
  table.remove();
}
