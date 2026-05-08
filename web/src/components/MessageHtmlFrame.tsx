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
//    email HTML — the email DOM must NOT share an origin with this app.
//  - The iframe sandbox excludes `allow-scripts` and `allow-same-origin`,
//    so any inline scripts or `Set-Cookie`-style abuse is neutralised.
//  - We allow `allow-popups allow-popups-to-escape-sandbox` so users can
//    click ordinary links and have them open at the parent origin.
//  - cid: image references are rewritten to authenticated attachment URLs
//    before the document touches the DOM.
export default function MessageHtmlFrame({ messageId, inlineAttachments, fallback }: Props) {
  const [srcdoc, setSrcdoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState<number>(120);
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
        setSrcdoc(rewriteCidReferences(text, inlineAttachments));
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messageId, inlineAttachments]);

  // Auto-size the iframe to its content. Without same-origin we can't read
  // the document, so we resize via a postMessage round-trip baked into the
  // wrapper HTML below — but since we don't allow-scripts in the sandbox,
  // we can't actually run that code. So we fall back to a generous starting
  // height and let users scroll inside the iframe if needed. The CSS clamps
  // it to the viewport so the parent page is still scrollable.
  useEffect(() => {
    // Best-effort: try same-origin read; will throw on cross-origin iframes.
    const el = iframeRef.current;
    if (!el || !srcdoc) return;
    const onLoad = () => {
      try {
        const doc = el.contentDocument;
        if (doc) {
          const h = Math.min(doc.documentElement.scrollHeight, 4000);
          if (h > 0) setHeight(h);
        }
      } catch {
        // Cross-origin sandbox — leave height at default; iframe will scroll.
      }
    };
    el.addEventListener("load", onLoad);
    return () => el.removeEventListener("load", onLoad);
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
      // NO allow-scripts, NO allow-same-origin: untrusted HTML mustn't run JS
      // or read cookies/localStorage from this origin.
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="mt-3 w-full rounded border border-neutral-200 dark:border-neutral-800 bg-white"
      style={{ height: `${height}px` }}
      title="Email body"
    />
  );
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
