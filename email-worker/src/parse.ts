import PostalMime, { type Address, type Attachment } from "postal-mime";
import type { AddressInfo, ParsedAttachment, ParsedMessage } from "./types";

export async function parseEmail(raw: ReadableStream): Promise<ParsedMessage> {
  const parsed = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });

  const text = parsed.text;
  const html = parsed.html;

  return {
    messageId: parsed.messageId ?? `<${crypto.randomUUID()}@orange-inbox.local>`,
    inReplyTo: parsed.inReplyTo,
    references: splitReferences(parsed.references),
    from: flattenOne(parsed.from) ?? { addr: "" },
    to: flattenMany(parsed.to),
    cc: flattenMany(parsed.cc),
    bcc: flattenMany(parsed.bcc),
    subject: parsed.subject ?? "",
    date: parsed.date ? Date.parse(parsed.date) || Date.now() : Date.now(),
    text,
    html,
    snippet: makeSnippet(text, html),
    attachments: (parsed.attachments ?? []).map(toParsedAttachment),
  };
}

function splitReferences(refs: string | undefined): string[] {
  if (!refs) return [];
  return refs.split(/\s+/).map(s => s.trim()).filter(Boolean);
}

function flattenOne(addr: Address | undefined): AddressInfo | undefined {
  if (!addr) return undefined;
  if ("address" in addr && addr.address) return { addr: addr.address, name: addr.name || undefined };
  if ("group" in addr && addr.group) return flattenOne(addr.group[0]);
  return undefined;
}

function flattenMany(addrs: Address[] | undefined): AddressInfo[] {
  if (!addrs) return [];
  const out: AddressInfo[] = [];
  for (const a of addrs) {
    if ("address" in a && a.address) {
      out.push({ addr: a.address, name: a.name || undefined });
    } else if ("group" in a && a.group) {
      for (const m of a.group) {
        out.push({ addr: m.address, name: m.name || undefined });
      }
    }
  }
  return out;
}

function makeSnippet(text: string | undefined, html: string | undefined): string {
  const source = text || (html ? stripHtml(html) : "");
  return source.replace(/\s+/g, " ").trim().slice(0, 200);
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ");
}

function toParsedAttachment(a: Attachment): ParsedAttachment {
  return {
    filename: a.filename ?? null,
    contentType: a.mimeType,
    disposition: a.disposition,
    contentId: a.contentId?.replace(/^<|>$/g, ""),
    bytes: toArrayBuffer(a.content),
  };
}

function toArrayBuffer(content: ArrayBuffer | Uint8Array | string): ArrayBuffer {
  if (content instanceof ArrayBuffer) return content;
  if (content instanceof Uint8Array) {
    return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
  }
  return new TextEncoder().encode(content).buffer as ArrayBuffer;
}
