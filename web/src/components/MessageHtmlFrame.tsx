"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

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

const themeStorageKey = (messageId: string) => `email-theme:${messageId}`;
const themeChangeEvent = "orange-inbox:email-theme-change";

// Read the per-message theme override from localStorage as an external
// store. useSyncExternalStore gives us a render-time read without the
// setState-in-effect cycle, and a server snapshot of `false` so SSR
// renders the auto-dark variant by default.
function useThemeOverride(messageId: string): boolean {
  const subscribe = useCallback((cb: () => void) => {
    function onChange(e: StorageEvent | Event) {
      if (e instanceof StorageEvent) {
        if (e.key === themeStorageKey(messageId)) cb();
        return;
      }
      const ce = e as CustomEvent<{ key?: string }>;
      if (ce.detail?.key === themeStorageKey(messageId)) cb();
    }
    window.addEventListener("storage", onChange);
    window.addEventListener(themeChangeEvent, onChange);
    return () => {
      window.removeEventListener("storage", onChange);
      window.removeEventListener(themeChangeEvent, onChange);
    };
  }, [messageId]);

  return useSyncExternalStore(
    subscribe,
    () => {
      try {
        return localStorage.getItem(themeStorageKey(messageId)) === "light";
      } catch {
        return false;
      }
    },
    () => false,
  );
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
//    before the document touches the DOM. We also prepend a viewport meta +
//    reset CSS that auto-darkens the email canvas in dark mode (see
//    wrapEmailHtml).
export default function MessageHtmlFrame({ messageId, inlineAttachments, fallback }: Props) {
  const [rawHtml, setRawHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState<number>(480);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Per-message override: when true, skip dark-mode CSS so the email
  // renders in its original light colors. Useful for branded emails where
  // the auto-darkening produces the wrong look. Persisted in localStorage
  // and read via useSyncExternalStore so there's no hydration mismatch and
  // no setState-in-effect cycle.
  const forceLight = useThemeOverride(messageId);

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
        setRawHtml(text);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  const srcdoc = useMemo(() => {
    if (rawHtml === null) return null;
    return wrapEmailHtml(rewriteCidReferences(rawHtml, inlineAttachments), {
      forceLight,
    });
  }, [rawHtml, inlineAttachments, forceLight]);

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

  function toggleTheme() {
    const key = themeStorageKey(messageId);
    try {
      if (forceLight) localStorage.removeItem(key);
      else localStorage.setItem(key, "light");
      window.dispatchEvent(new CustomEvent(themeChangeEvent, { detail: { key } }));
    } catch {
      /* ignore */
    }
  }

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
    <>
      <iframe
        ref={iframeRef}
        srcDoc={srcdoc}
        // NO allow-scripts: untrusted email HTML must not execute JS. We do
        // include allow-same-origin so the parent can measure scrollHeight to
        // grow the iframe — safe only because scripts are blocked.
        sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
        referrerPolicy="no-referrer"
        className={`mt-3 w-full rounded border border-neutral-200 dark:border-neutral-800 ${
          forceLight ? "bg-white" : "bg-white dark:bg-neutral-950"
        }`}
        style={{ height: `${height}px` }}
        title="Email body"
      />
      {/* Dark-mode-only escape hatch: branded emails sometimes render
          better in their original colors. Hidden in light mode where the
          toggle would be a no-op. */}
      <button
        type="button"
        onClick={toggleTheme}
        className="hidden dark:inline-flex mt-1 text-[11px] text-neutral-500 hover:text-neutral-300"
      >
        {forceLight ? "Use dark theme" : "Show original colors"}
      </button>
    </>
  );
}

// Prepend a viewport meta + reset CSS so wide email layouts don't overflow
// horizontally on mobile. In dark mode (and unless `forceLight` is set),
// also apply the `invert(1) hue-rotate(180deg)` filter trick: it flips
// grayscale (white↔black, so light backgrounds become dark canvases and
// dark text becomes light) while preserving chromatic colors (a red CTA
// stays red). Media gets re-inverted so photos and logos render normally.
function wrapEmailHtml(emailHtml: string, opts: { forceLight: boolean }): string {
  const darkBlock = opts.forceLight
    ? ""
    : `
  @media (prefers-color-scheme: dark) {
    html { background-color: #0a0a0a; color-scheme: dark; }
    body {
      filter: invert(1) hue-rotate(180deg);
      /* Filter is applied on top of the body's own background. Keep it
         white so invert turns it into a true dark canvas instead of an
         off-color one. */
      background-color: #ffffff !important;
    }
    /* Re-invert media so photos, logos, and inline-styled background
       images render at their original colors instead of inverted. */
    img, video, picture, svg, canvas, embed, object, iframe,
    [background],
    [style*="background-image"],
    [style*="background:url"],
    [style*="background: url"] {
      filter: invert(1) hue-rotate(180deg);
    }
  }`;

  const head = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank"><style>
  html, body { margin: 0 !important; padding: 12px !important; max-width: 100% !important; box-sizing: border-box !important; overflow-wrap: break-word !important; word-break: break-word !important; -webkit-text-size-adjust: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #111; }
  img, video, iframe { max-width: 100% !important; height: auto !important; }
  table { max-width: 100% !important; }
  td, th { word-break: break-word; }
  pre, code { white-space: pre-wrap !important; word-break: break-word !important; }${darkBlock}
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
