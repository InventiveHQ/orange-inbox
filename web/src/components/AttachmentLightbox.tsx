"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface LightboxItem {
  id: string;
  filename: string | null;
  contentType: string | null;
}

interface Props {
  // Ordered list of items the lightbox can display. For images, left/right
  // arrows navigate within this list. For a single-item open (e.g. a PDF),
  // pass a one-element array.
  items: LightboxItem[];
  // Index into `items` to start on.
  startIndex: number;
  onClose: () => void;
}

// Generic full-viewport lightbox. Shows an image or a sandboxed iframe (for
// PDFs) depending on the active item's content type. Backdrop click + Esc
// close. Left/right arrows navigate when there are >1 items.
export default function AttachmentLightbox({ items, startIndex, onClose }: Props) {
  const [index, setIndex] = useState(() =>
    Math.max(0, Math.min(startIndex, items.length - 1)),
  );
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const active = items[index];

  const next = useCallback(() => {
    setIndex(i => (items.length === 0 ? 0 : (i + 1) % items.length));
  }, [items.length]);
  const prev = useCallback(() => {
    setIndex(i => (items.length === 0 ? 0 : (i - 1 + items.length) % items.length));
  }, [items.length]);

  // Esc to close, arrows to navigate. Capture so we win against any
  // shortcut listeners on the page while the lightbox is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (items.length > 1) {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          next();
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          prev();
        }
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [items.length, next, prev, onClose]);

  // Lock body scroll while open and restore on close.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  // Auto-focus the dialog so keyboard listeners pick it up immediately.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  if (!active) return null;

  const isPdf = active.contentType === "application/pdf";
  const isImage = (active.contentType || "").startsWith("image/");
  const url = `/api/attachments/${active.id}`;
  const downloadName = active.filename || "attachment";

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={downloadName}
      tabIndex={-1}
      onClick={onClose}
      className="fixed inset-0 z-[60] flex flex-col bg-black/85 outline-none"
    >
      {/* Header bar — stops clicks so backdrop-close doesn't fire on its
          buttons. Filename + counter (when navigating) on the left, download
          and close on the right. */}
      <header
        onClick={e => e.stopPropagation()}
        className="flex items-center gap-3 px-4 py-2 text-white text-sm"
      >
        <div className="min-w-0 flex-1 truncate" title={downloadName}>
          {downloadName}
          {items.length > 1 && (
            <span className="ml-2 text-white/60 text-xs">
              {index + 1} / {items.length}
            </span>
          )}
        </div>
        <a
          href={url}
          download={downloadName}
          className="rounded-md border border-white/20 px-3 py-1 text-xs hover:bg-white/10"
        >
          Download
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md border border-white/20 px-3 py-1 text-xs hover:bg-white/10"
        >
          Close
        </button>
      </header>

      {/* Body fills remaining space. Click on empty area also closes; the
          actual content stops propagation. */}
      <div className="flex-1 flex items-center justify-center p-4 overflow-hidden">
        {isImage ? (
          // Authenticated dynamic blob; not suitable for next/image's loader.
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={url}
            alt={downloadName}
            onClick={e => e.stopPropagation()}
            className="max-w-full max-h-full object-contain select-none"
            draggable={false}
          />
        ) : isPdf ? (
          // Sandboxed iframe — same security stance as MessageHtmlFrame: no
          // allow-scripts. We include allow-same-origin so the browser's PDF
          // viewer (which is built into the user agent) can render normally.
          // The route ships Content-Disposition: attachment, so some browsers
          // may force a download instead of inline-rendering; the Download
          // button is always available as a fallback.
          <iframe
            src={url}
            title={downloadName}
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            onClick={e => e.stopPropagation()}
            className="w-full h-full bg-white rounded"
          />
        ) : (
          <div
            onClick={e => e.stopPropagation()}
            className="text-white/80 text-sm"
          >
            No preview available.
          </div>
        )}
      </div>

      {items.length > 1 && (
        <>
          {/* Side affordances — keyboard arrows still drive navigation, but
              tap targets help on touch devices. */}
          <button
            type="button"
            aria-label="Previous"
            onClick={e => {
              e.stopPropagation();
              prev();
            }}
            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 hover:bg-white/20 text-white w-10 h-10 flex items-center justify-center text-xl"
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="Next"
            onClick={e => {
              e.stopPropagation();
              next();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 hover:bg-white/20 text-white w-10 h-10 flex items-center justify-center text-xl"
          >
            ›
          </button>
        </>
      )}
    </div>
  );
}
