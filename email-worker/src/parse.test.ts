import { describe, expect, it } from "vitest";
import { makeSnippet, parseEmail, splitReferences, stripHtml } from "./parse";

describe("splitReferences", () => {
  it("returns an empty array for missing/empty input", () => {
    expect(splitReferences(undefined)).toEqual([]);
    expect(splitReferences("")).toEqual([]);
    expect(splitReferences("   ")).toEqual([]);
  });

  it("splits on any whitespace and drops empties", () => {
    const refs = "<a@x.com>  <b@x.com>\n<c@x.com>";
    expect(splitReferences(refs)).toEqual(["<a@x.com>", "<b@x.com>", "<c@x.com>"]);
  });

  it("preserves angle brackets and order", () => {
    const refs = "<first@x> <second@x> <third@x>";
    expect(splitReferences(refs)).toEqual(["<first@x>", "<second@x>", "<third@x>"]);
  });
});

describe("stripHtml", () => {
  it("removes script and style blocks entirely", () => {
    // style/script removal replaces with "" (full deletion); inline tags are
    // replaced with a space — see the regex in stripHtml.
    const html = "<style>body { color: red }</style>hello<script>alert(1)</script>world";
    expect(stripHtml(html).trim()).toBe("helloworld");
  });

  it("strips inline tags but keeps text", () => {
    expect(stripHtml("<p>hi <b>there</b></p>").trim()).toBe("hi  there");
  });

  it("handles multi-line script tags", () => {
    const html = "before<script>\n  var x = 1;\n  alert(x);\n</script>after";
    expect(stripHtml(html).trim()).toBe("beforeafter");
  });
});

describe("makeSnippet", () => {
  it("prefers text over html", () => {
    expect(makeSnippet("plain body", "<p>html body</p>")).toBe("plain body");
  });

  it("falls back to html when text is missing", () => {
    expect(makeSnippet(undefined, "<p>html body</p>")).toBe("html body");
  });

  it("collapses whitespace", () => {
    expect(makeSnippet("a    b\n\nc", undefined)).toBe("a b c");
  });

  it("truncates at 200 chars", () => {
    const long = "x".repeat(500);
    expect(makeSnippet(long, undefined).length).toBe(200);
  });

  it("returns empty string when both inputs are empty", () => {
    expect(makeSnippet(undefined, undefined)).toBe("");
    expect(makeSnippet("", "")).toBe("");
  });
});

// ─── parseEmail end-to-end tests ────────────────────────────────────────────
//
// postal-mime accepts a ReadableStream. We stitch a small helper that turns a
// raw string into a stream so each test can craft a minimal RFC 5322 message
// inline without dragging in fixture files.
function streamOf(s: string): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(s));
      controller.close();
    },
  });
}

describe("parseEmail", () => {
  it("extracts the basic envelope from a plain-text message", async () => {
    const eml = [
      "From: Alice <alice@example.com>",
      "To: Bob <bob@example.org>",
      "Subject: Hello there",
      "Message-ID: <abc-123@example.com>",
      "Date: Fri, 9 May 2026 10:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "This is the body.",
      "",
    ].join("\r\n");

    const parsed = await parseEmail(streamOf(eml));
    expect(parsed.from.addr).toBe("alice@example.com");
    expect(parsed.from.name).toBe("Alice");
    expect(parsed.to[0]?.addr).toBe("bob@example.org");
    expect(parsed.subject).toBe("Hello there");
    expect(parsed.messageId).toBe("<abc-123@example.com>");
    expect(parsed.text?.trim()).toBe("This is the body.");
    expect(parsed.snippet).toBe("This is the body.");
  });

  it("populates references and in-reply-to for replies", async () => {
    const eml = [
      "From: alice@example.com",
      "To: bob@example.org",
      "Subject: Re: a thread",
      "Message-ID: <reply@example.com>",
      "In-Reply-To: <orig@example.com>",
      "References: <orig@example.com> <middle@example.com>",
      "",
      "Reply body",
      "",
    ].join("\r\n");

    const parsed = await parseEmail(streamOf(eml));
    expect(parsed.inReplyTo).toBe("<orig@example.com>");
    expect(parsed.references).toEqual(["<orig@example.com>", "<middle@example.com>"]);
  });

  it("synthesizes a Message-ID when the message lacks one", async () => {
    // Some marketing senders ship without a Message-ID. We synthesize one
    // rather than crashing — the caller treats it as a never-collide id.
    const eml = [
      "From: noreply@marketing.example.com",
      "To: alice@example.com",
      "Subject: A bargain",
      "Date: Fri, 9 May 2026 10:00:00 +0000",
      "",
      "buy stuff",
      "",
    ].join("\r\n");

    const parsed = await parseEmail(streamOf(eml));
    expect(parsed.messageId).toMatch(/^<.+@orange-inbox\.local>$/);
  });

  it("multipart/alternative: prefers text and uses html for snippet fallback", async () => {
    const boundary = "BOUNDARY-123";
    const eml = [
      "From: alice@example.com",
      "To: bob@example.org",
      "Subject: Multipart",
      "Message-ID: <mp@example.com>",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "plain version",
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>html version</p>",
      "",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const parsed = await parseEmail(streamOf(eml));
    expect(parsed.text?.trim()).toBe("plain version");
    expect(parsed.html?.trim()).toBe("<p>html version</p>");
    expect(parsed.snippet).toBe("plain version");
  });

  it("strips angle brackets from inline attachment Content-IDs", async () => {
    const boundary = "B";
    const eml = [
      "From: alice@example.com",
      "To: bob@example.org",
      "Subject: With inline image",
      "Message-ID: <img@example.com>",
      `Content-Type: multipart/related; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/html",
      "",
      '<img src="cid:logo123">',
      "",
      `--${boundary}`,
      "Content-Type: image/png",
      "Content-Disposition: inline; filename=logo.png",
      "Content-ID: <logo123>",
      "Content-Transfer-Encoding: base64",
      "",
      // 1×1 transparent PNG (89 bytes raw, base64-encoded)
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
      "",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const parsed = await parseEmail(streamOf(eml));
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].contentId).toBe("logo123");
    expect(parsed.attachments[0].contentType).toBe("image/png");
    expect(parsed.attachments[0].bytes.byteLength).toBeGreaterThan(0);
  });

  it("falls back to a sane date when the Date header is missing or malformed", async () => {
    const eml = [
      "From: alice@example.com",
      "To: bob@example.org",
      "Subject: dateless",
      "Message-ID: <d@example.com>",
      "",
      "body",
      "",
    ].join("\r\n");

    const before = Date.now();
    const parsed = await parseEmail(streamOf(eml));
    const after = Date.now();
    // Date should fall within now()-ish since postal-mime returned no Date.
    expect(parsed.date).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed.date).toBeLessThanOrEqual(after + 1000);
  });
});
