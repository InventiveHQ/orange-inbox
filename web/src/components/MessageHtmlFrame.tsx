"use client";

import { useEffect, useRef, useState } from "react";

interface InlineAttachment {
  id: string;
  cid: string;
}

interface Props {
  messageId: string;
  // Inline images attached to the message: their `cid:` references in the
  // body get rewritten to authenticated /api/attachments/{id} URLs before
  // we hand the HTML to the iframe.
  inlineAttachments: InlineAttachment[];
  // Plain-text fallback shown while the HTML is loading or if it fails.
  fallback: string | null;
}

// Renders email HTML inside a sandboxed iframe.
//
// Security model:
//  - The HTML is fetched as text via /api/messages/{id}/html, then injected
//    via the `srcdoc` attribute. We never use dangerouslySetInnerHTML on
//    email HTML.
//  - The iframe sandbox excludes `allow-scripts`, so inline JS in the email
//    cannot run. We DO include `allow-same-origin` so the parent can read
//    contentDocument.scrollHeight and grow the iframe to fit content — this
//    is safe only because allow-scripts is excluded (no JS in the email
//    means it cannot exfiltrate cookies / localStorage / etc. via that
//    same-origin handle).
//  - We allow `allow-popups allow-popups-to-escape-sandbox` so users can
//    click ordinary links and have them open at the parent origin.
//  - cid: image references are rewritten to authenticated attachment URLs
//    before the document touches the DOM. We also prepend a small CSS
//    block + viewport meta to keep wide email layouts from overflowing
//    horizontally on mobile.
export default function MessageHtmlFrame({ messageId, inlineAttachments, fallback }: Props) {
  const [srcdoc, setSrcdoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState<number>(480);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/messages/${messageId}/html`, {
          credentials: "include",
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const text = await res.text();
        if (cancelled) return;
        setSrcdoc(wrapEmailHtml(rewriteCidReferences(text, inlineAttachments)));
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messageId, inlineAttachments]);

  // Auto-size the iframe to its content. With `allow-same-origin` in the
  // sandbox, the parent can read the iframe document and grow to fit it.
  // Re-measure on resize so wide-email layouts that wrap differently at
  // different viewport widths don't end up with stale heights.
  useEffect(() => {
    const el = iframeRef.current;
    if (!el || !srcdoc) return;
    let ro: ResizeObserver | null = null;
    const measure = () => {
      try {
        const doc = el.contentDocument;
        if (!doc) return;
        const h = Math.min(
          Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0),
          4000,
        );
        if (h > 0) setHeight(h);
      } catch {
        /* Should not happen with allow-same-origin, but fall back gracefully. */
      }
    };
    const onLoad = () => {
      measure();
      try {
        const doc = el.contentDocument;
        if (doc?.body && "ResizeObserver" in window) {
          ro = new ResizeObserver(measure);
          ro.observe(doc.body);
        }
      } catch {
        /* same-origin denied — just rely on the load event */
      }
    };
    el.addEventListener("load", onLoad);
    return () => {
      el.removeEventListener("load", onLoad);
      ro?.disconnect();
    };
  }, [srcdoc]);

  if (error) {
    return (
      <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed text-neutral-800 dark:text-neutral-200">
        {fallback || `(failed to load HTML body: ${error})`}
      </pre>
    );
  }

  if (srcdoc === null) {
    return (
      <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed text-neutral-500">
        {fallback || "Loading…"}
      </pre>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcdoc}
      // NO allow-scripts: untrusted email HTML must not execute JS. We do
      // include allow-same-origin so the parent can measure scrollHeight to
      // grow the iframe — safe only because scripts are blocked.
      sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
      referrerPolicy="no-referrer"
      className="mt-3 w-full rounded border border-neutral-200 dark:border-neutral-800 bg-white"
      style={{ height: `${height}px` }}
      title="Email body"
    />
  );
}

// Prepend a viewport meta + reset CSS so wide email layouts (fixed-pixel
// tables, oversized images) don't overflow horizontally on mobile. Email
// HTML is appended after, so its own styles still apply where they don't
// conflict; ours use !important to win on the few properties we care about.
function wrapEmailHtml(emailHtml: string): string {
  const head = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank"><style>
  html, body { margin: 0 !important; padding: 12px !important; max-width: 100% !important; box-sizing: border-box !important; overflow-wrap: break-word !important; word-break: break-word !important; -webkit-text-size-adjust: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #111; }
  img, video, iframe { max-width: 100% !important; height: auto !important; }
  table { max-width: 100% !important; }
  td, th { word-break: break-word; }
  pre, code { white-space: pre-wrap !important; word-break: break-word !important; }
</style>`;
  return head + emailHtml;
}

// Replace `cid:CID` references in src/href/url() with authenticated attachment
// URLs. We don't try to fully sanitise the email HTML — that's the iframe's
// job — we only rewrite the cid: scheme so inline images render.
function rewriteCidReferences(html: string, atts: InlineAttachment[]): string {
  if (atts.length === 0) return html;
  const byCid = new Map<string, string>();
  for (const a of atts) {
    if (!a.cid) continue;
    // RFC 2392 cids are typically wrapped in <>; postal-mime usually strips
    // them, but be defensive.
    const cid = a.cid.replace(/^<|>$/g, "").toLowerCase();
    byCid.set(cid, `/api/attachments/${a.id}`);
  }

  // Match `cid:<token>` in attributes (src=, href=) and CSS url(...) — we
  // do this with one regex that stops at quote/whitespace/paren/angle.
  return html.replace(/cid:([^\s"'<>)]+)/gi, (full, raw: string) => {
    const url = byCid.get(raw.toLowerCase());
    return url ?? full;
  });
}
