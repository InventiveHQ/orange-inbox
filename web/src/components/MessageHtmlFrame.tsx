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

// Per-user remote-image policy. Lives in localStorage so v1 needs no schema
// change; default is "ask" — we strip remote images and offer a one-click
// reveal per message. "allow" rewrites them through /api/images/proxy on
// every render. "block" is the same as "ask" today (kept distinct so we can
// later add a global never-load behaviour).
type RemoteImagePolicy = "ask" | "allow" | "block";
const REMOTE_IMAGE_POLICY_KEY = "remote-image-policy";
const REMOTE_IMAGE_POLICY_EVENT = "orange-inbox:remote-image-policy-change";

// Tracking query params we strip from URLs we forward through the proxy.
// Keep the list short and well-known: we only want zero-information
// trackers, not e.g. `id=` which is meaningful in a CDN URL.
const TRACKING_PARAM_PATTERNS: Array<RegExp | string> = [
  /^utm_/i,
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "__s",
];

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

// Read the global remote-image policy. Same external-store pattern as the
// theme override. Server snapshot is "ask" so SSR strips remote images by
// default (the safer choice).
function useRemoteImagePolicy(): RemoteImagePolicy {
  const subscribe = useCallback((cb: () => void) => {
    function onChange(e: StorageEvent | Event) {
      if (e instanceof StorageEvent) {
        if (e.key === REMOTE_IMAGE_POLICY_KEY) cb();
        return;
      }
      cb();
    }
    window.addEventListener("storage", onChange);
    window.addEventListener(REMOTE_IMAGE_POLICY_EVENT, onChange);
    return () => {
      window.removeEventListener("storage", onChange);
      window.removeEventListener(REMOTE_IMAGE_POLICY_EVENT, onChange);
    };
  }, []);

  return useSyncExternalStore(
    subscribe,
    () => {
      try {
        const v = localStorage.getItem(REMOTE_IMAGE_POLICY_KEY);
        if (v === "allow" || v === "block" || v === "ask") return v;
      } catch {
        /* fall through */
      }
      return "ask" as const;
    },
    () => "ask" as const,
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
//  - Remote http(s) images are either rewritten through /api/images/proxy
//    (no cookies / no Referer / tracker-pixel stripping) or stripped
//    entirely depending on the user's policy.
//  - Quoted reply history (Gmail / Outlook / nested blockquotes) is wrapped
//    in <details class="orange-quote"> so the iframe collapses it without
//    needing JS in the sandbox.
export default function MessageHtmlFrame({ messageId, inlineAttachments, fallback }: Props) {
  const [rawHtml, setRawHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState<number>(480);
  // Per-message override: when true the user clicked "Show images" on a
  // blocked message and we render this view as if the policy were "allow".
  const [revealRemoteImages, setRevealRemoteImages] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Per-message override: when true, skip dark-mode CSS so the email
  // renders in its original light colors. Useful for branded emails where
  // the auto-darkening produces the wrong look. Persisted in localStorage
  // and read via useSyncExternalStore so there's no hydration mismatch and
  // no setState-in-effect cycle.
  const forceLight = useThemeOverride(messageId);
  const remoteImagePolicy = useRemoteImagePolicy();
  const effectivePolicy: RemoteImagePolicy = revealRemoteImages ? "allow" : remoteImagePolicy;

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

  const { srcdoc, blockedCount } = useMemo(() => {
    if (rawHtml === null) return { srcdoc: null, blockedCount: 0 };
    const cidRewritten = rewriteCidReferences(rawHtml, inlineAttachments);
    const remote = applyRemoteImagePolicy(cidRewritten, effectivePolicy);
    const collapsed = collapseQuotedHistory(remote.html);
    return {
      srcdoc: wrapEmailHtml(collapsed, { forceLight }),
      blockedCount: remote.blockedCount,
    };
  }, [rawHtml, inlineAttachments, forceLight, effectivePolicy]);

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

  const showBlockedChip = blockedCount > 0 && !revealRemoteImages;

  return (
    <>
      {showBlockedChip && (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-1.5 text-xs text-amber-900 dark:text-amber-200">
          <span aria-hidden>🚫</span>
          <span>
            {blockedCount} remote image{blockedCount === 1 ? "" : "s"} blocked
          </span>
          <button
            type="button"
            onClick={() => setRevealRemoteImages(true)}
            className="ml-auto rounded-md border border-amber-400 dark:border-amber-600 px-2 py-0.5 text-[11px] font-medium hover:bg-amber-100 dark:hover:bg-amber-900/50"
          >
            Show images
          </button>
        </div>
      )}
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
  pre, code { white-space: pre-wrap !important; word-break: break-word !important; }
  details.orange-quote { margin: 8px 0; }
  details.orange-quote > summary { cursor: pointer; color: #6b7280; font-size: 12px; list-style: none; user-select: none; padding: 2px 0; }
  details.orange-quote > summary::-webkit-details-marker { display: none; }
  details.orange-quote > summary::before { content: "··· "; letter-spacing: 1px; }
  details.orange-quote[open] > summary::before { content: "▾ "; }${darkBlock}
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

// Walk every <img src="http(s)://..."> in the body. With "allow", rewrite
// to /api/images/proxy?url=... (after stripping tracker query params).
// With "ask"/"block", strip the src/srcset entirely (so the iframe shows a
// placeholder instead of leaking the request). Returns the count of
// images we blocked so the chip can show "N images blocked".
//
// We also handle <img srcset> (rewriting/dropping each candidate) and
// inline `background:url(...)` styles in the same pass.
function applyRemoteImagePolicy(
  html: string,
  policy: RemoteImagePolicy,
): { html: string; blockedCount: number } {
  let blockedCount = 0;

  // <img ...> tags. Process attributes inside the tag without touching
  // body content — naive regex is OK because the iframe is the security
  // boundary; we just need to mutate URLs we recognise.
  const next = html.replace(/<img\b([^>]*)>/gi, (_m, attrs: string) => {
    const srcMatch = attrs.match(/\s(src)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const srcsetMatch = attrs.match(/\s(srcset)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const src = srcMatch ? (srcMatch[3] ?? srcMatch[4] ?? srcMatch[5] ?? "") : "";
    const srcset = srcsetMatch ? (srcsetMatch[3] ?? srcsetMatch[4] ?? srcsetMatch[5] ?? "") : "";

    const srcIsRemote = isRemoteHttp(src);
    const srcsetHasRemote = srcset.split(",").some(p => isRemoteHttp(p.trim().split(/\s+/)[0] ?? ""));

    if (!srcIsRemote && !srcsetHasRemote) {
      return `<img${attrs}>`;
    }

    if (policy === "allow") {
      let nextAttrs = attrs;
      if (srcIsRemote) {
        const proxied = toProxyUrl(src);
        nextAttrs = replaceAttr(nextAttrs, "src", proxied);
      }
      if (srcsetMatch) {
        const rewritten = srcset
          .split(",")
          .map(part => {
            const trimmed = part.trim();
            if (!trimmed) return null;
            const [u, ...rest] = trimmed.split(/\s+/);
            if (!u) return null;
            const target = isRemoteHttp(u) ? toProxyUrl(u) : u;
            return [target, ...rest].join(" ");
          })
          .filter((p): p is string => p !== null)
          .join(", ");
        nextAttrs = replaceAttr(nextAttrs, "srcset", rewritten);
      }
      return `<img${nextAttrs}>`;
    }

    // policy is "ask" or "block": drop the remote refs and remember we
    // suppressed something so the chip can offer a one-click reveal.
    blockedCount += 1;
    let nextAttrs = attrs;
    if (srcIsRemote) {
      // Replace src with a 1x1 transparent gif data URI so the iframe
      // doesn't show a broken-image icon.
      nextAttrs = replaceAttr(
        nextAttrs,
        "src",
        "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==",
      );
    }
    if (srcsetMatch) {
      nextAttrs = removeAttr(nextAttrs, "srcset");
    }
    return `<img${nextAttrs}>`;
  });

  return { html: next, blockedCount };
}

// True if the URL is an absolute http(s) URL we'd want to proxy. We
// deliberately leave protocol-relative (//cdn.example/...) alone — they're
// rare enough in real-world email and resolving them properly requires a
// base URL we don't have.
function isRemoteHttp(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function toProxyUrl(url: string): string {
  return `/api/images/proxy?url=${encodeURIComponent(stripTrackingParams(url))}`;
}

// Strip well-known tracker params (utm_*, fbclid, gclid, mc_cid, mc_eid,
// _ga, __s) from a URL before we forward it. Matches by name — no value
// inspection — to avoid stripping legitimate params that happen to look
// trackerish. If the URL doesn't parse, just return it unchanged so the
// proxy gets a chance to reject it.
function stripTrackingParams(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const drop: string[] = [];
  for (const key of parsed.searchParams.keys()) {
    if (isTrackingParam(key)) drop.push(key);
  }
  for (const k of drop) parsed.searchParams.delete(k);
  return parsed.toString();
}

function isTrackingParam(key: string): boolean {
  for (const pattern of TRACKING_PARAM_PATTERNS) {
    if (typeof pattern === "string") {
      if (key.toLowerCase() === pattern) return true;
    } else if (pattern.test(key)) {
      return true;
    }
  }
  return false;
}

// Replace the value of an attribute inside an attribute-list string. If
// the attr isn't present, append it. We always emit double-quoted values.
function replaceAttr(attrs: string, name: string, value: string): string {
  const re = new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i");
  if (re.test(attrs)) {
    return attrs.replace(re, ` ${name}="${escapeAttr(value)}"`);
  }
  return `${attrs} ${name}="${escapeAttr(value)}"`;
}

function removeAttr(attrs: string, name: string): string {
  const re = new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i");
  return attrs.replace(re, "");
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// Detect quoted reply history and wrap each block in
// <details class="orange-quote"><summary>···</summary>...</details>.
// The iframe sandbox doesn't allow scripts, but <details> works without JS,
// so the quote stays collapsed by default and expands on click.
//
// Three patterns we care about, in order of specificity:
//   1. Gmail: <blockquote class="gmail_quote ..."> — wrap the whole block.
//   2. Outlook: a sentinel <div id="appendonsend"> appears just above the
//      original message; wrap from there to the end of the document body.
//   3. Generic <blockquote> nested deeper than the first level — most
//      reply chains.
//
// We don't try to handle every possible client (Apple Mail's "On <date>,
// <name> wrote:" line is plain text inside a blockquote, so case 3
// catches it). We also don't recurse into blockquotes we've already
// wrapped — replacement is single-pass.
function collapseQuotedHistory(html: string): string {
  let out = html;

  // 1) Gmail quote blocks. The class can be on its own ("gmail_quote") or
  //    combined with extras (e.g. "gmail_quote_container"); match either.
  out = out.replace(
    /<blockquote\b([^>]*\bclass\s*=\s*("[^"]*\bgmail_quote\b[^"]*"|'[^']*\bgmail_quote\b[^']*'))([\s\S]*?)<\/blockquote>/gi,
    (_m, attrs: string, _classAttr: string, inner: string) => {
      return wrapInDetails(`<blockquote${attrs}>${inner}</blockquote>`);
    },
  );

  // 2) Outlook appendonsend sentinel. Wrap from this element to the end of
  //    the surrounding container; in practice "the rest of the body" is the
  //    quote, since clients put it at the boundary between the new reply
  //    and the original.
  out = out.replace(
    /(<div\b[^>]*\bid\s*=\s*("appendonsend"|'appendonsend')[^>]*>)([\s\S]*?)(?=<\/body>|$)/i,
    (_m, openTag: string, _idAttr: string, rest: string) => {
      return wrapInDetails(`${openTag}${rest}`);
    },
  );

  // 3) Generic nested blockquotes — i.e. a <blockquote> whose nearest
  //    ancestor is also a <blockquote>. We approximate that by wrapping
  //    every <blockquote> that contains another <blockquote>; this catches
  //    multi-level reply chains while leaving a single top-level quote
  //    block (e.g. "On Tuesday, X wrote:") untouched if the user wants to
  //    see it inline.
  //
  //    We avoid double-wrapping: skip blockquotes already inside a
  //    `<details class="orange-quote">` we just added by checking the
  //    string we're about to wrap.
  out = out.replace(
    /<blockquote\b([^>]*)>([\s\S]*?)<\/blockquote>/gi,
    (full, attrs: string, inner: string) => {
      // Already wrapped (case 1) — leave alone. We can detect by the
      // surrounding text but inside a single replace we only get the
      // match itself; instead, if the inner contains another blockquote
      // (i.e. we're a parent of nested reply quotes), wrap us. Single-quote
      // blocks pass through.
      if (!/<blockquote\b/i.test(inner)) return full;
      // Don't re-wrap if we're already inside a details we created (the
      // outer regex won't match across the wrapper because <details> is
      // not a <blockquote>, but the *child* blockquote inside might still
      // come back through here. That's fine — wrapping a child blockquote
      // inside a collapsed parent is a no-op visually).
      return wrapInDetails(`<blockquote${attrs}>${inner}</blockquote>`);
    },
  );

  return out;
}

function wrapInDetails(inner: string): string {
  return `<details class="orange-quote"><summary>Show quoted history</summary>${inner}</details>`;
}
