"use client";

import { useState } from "react";
import AttachmentLightbox, { type LightboxItem } from "./AttachmentLightbox";

export interface PreviewableAttachment {
  id: string;
  filename: string | null;
  content_type: string | null;
  size: number;
}

interface Props {
  // Image and PDF attachments only — chips for everything else stay in the
  // server-rendered list.
  attachments: PreviewableAttachment[];
}

// Renders thumbnails (images) and chip-with-Preview-button (PDFs), and owns
// the lightbox state. Image-only navigation: arrow keys cycle within the
// images list; PDFs always open as a single-item lightbox.
export default function AttachmentPreview({ attachments }: Props) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [openItems, setOpenItems] = useState<LightboxItem[]>([]);

  const images = attachments.filter(a => (a.content_type || "").startsWith("image/"));
  const pdfs = attachments.filter(a => a.content_type === "application/pdf");

  function openImage(att: PreviewableAttachment) {
    const items: LightboxItem[] = images.map(a => ({
      id: a.id,
      filename: a.filename,
      contentType: a.content_type,
    }));
    const idx = images.findIndex(a => a.id === att.id);
    setOpenItems(items);
    setOpenIndex(idx >= 0 ? idx : 0);
  }

  function openPdf(att: PreviewableAttachment) {
    setOpenItems([
      { id: att.id, filename: att.filename, contentType: att.content_type },
    ]);
    setOpenIndex(0);
  }

  function close() {
    setOpenIndex(null);
  }

  if (attachments.length === 0) return null;

  return (
    <>
      {images.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {images.map(a => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => openImage(a)}
                title={a.filename || "image"}
                className="block overflow-hidden rounded-md border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 hover:opacity-90"
              >
                {/* Native lazy load — the thumbnail uses the same endpoint as
                    the full image; the browser scales it down. The /api route
                    sets Cache-Control: private,no-store, so revisits refetch,
                    but per-page renders dedupe via the URL. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/attachments/${a.id}`}
                  alt={a.filename || "attachment"}
                  loading="lazy"
                  className="max-h-[200px] max-w-[280px] object-contain bg-white dark:bg-neutral-950"
                />
              </button>
            </li>
          ))}
        </ul>
      )}

      {pdfs.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {pdfs.map(a => (
            <li key={a.id} className="inline-flex items-center gap-1">
              <a
                href={`/api/attachments/${a.id}`}
                download={a.filename ?? undefined}
                className="inline-flex items-center gap-2 rounded-md border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 px-3 py-1.5 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <span className="font-medium truncate max-w-[16rem]">
                  {a.filename || "attachment"}
                </span>
                <span className="text-neutral-500">{formatBytes(a.size)}</span>
              </a>
              <button
                type="button"
                onClick={() => openPdf(a)}
                className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 px-2 py-1.5 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                Preview
              </button>
            </li>
          ))}
        </ul>
      )}

      {openIndex !== null && openItems.length > 0 && (
        <AttachmentLightbox
          items={openItems}
          startIndex={openIndex}
          onClose={close}
        />
      )}
    </>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
