import { describe, expect, it } from "vitest";
import { normalizeSubject } from "./thread";

describe("normalizeSubject", () => {
  it("strips a single Re: prefix", () => {
    expect(normalizeSubject("Re: hello")).toBe("hello");
  });

  it("strips nested reply/forward prefixes", () => {
    expect(normalizeSubject("Re: Fwd: Re: hello")).toBe("hello");
  });

  it("is case-insensitive", () => {
    expect(normalizeSubject("RE: Hello")).toBe("hello");
    expect(normalizeSubject("re: HELLO")).toBe("hello");
    expect(normalizeSubject("FWD: HELLO")).toBe("hello");
  });

  it("recognizes non-English reply prefixes", () => {
    // German Aw:, French Tr:, Dutch Antw:
    expect(normalizeSubject("Aw: hallo")).toBe("hallo");
    expect(normalizeSubject("Tr: bonjour")).toBe("bonjour");
    expect(normalizeSubject("Antw: hoi")).toBe("hoi");
  });

  it("collapses whitespace", () => {
    expect(normalizeSubject("  hello   world  ")).toBe("hello world");
  });

  it("returns a sentinel for empty subjects", () => {
    expect(normalizeSubject("")).toBe("(no subject)");
    expect(normalizeSubject(undefined)).toBe("(no subject)");
    expect(normalizeSubject("   ")).toBe("(no subject)");
  });

  it("does not strip 'Re:' from the middle of a subject", () => {
    expect(normalizeSubject("Mistake Re: original")).toBe("mistake re: original");
  });

  it("handles Fw: as well as Fwd:", () => {
    expect(normalizeSubject("Fw: forwarded")).toBe("forwarded");
    expect(normalizeSubject("Fwd: forwarded")).toBe("forwarded");
  });

  it("strips unbounded layers without infinite-looping", () => {
    const stack = "Re: ".repeat(50) + "core";
    expect(normalizeSubject(stack)).toBe("core");
  });
});
