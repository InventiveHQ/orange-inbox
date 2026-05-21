import { describe, expect, it } from "vitest";
import { extractAuthservId, parseAuthenticationResults } from "./auth-results";

describe("extractAuthservId", () => {
  it("returns the leading authserv-id, lowercased", () => {
    expect(
      extractAuthservId("MX.Cloudflare.NET; spf=pass; dkim=pass; dmarc=pass"),
    ).toBe("mx.cloudflare.net");
  });

  it("ignores an optional version token after the authserv-id", () => {
    // RFC 8601 allows `authserv-id 1` (authres-version).
    expect(extractAuthservId("mx.example.com 1; spf=pass")).toBe("mx.example.com");
  });

  it("strips comments before reading the authserv-id", () => {
    expect(
      extractAuthservId("mx.example.com (receiver comment); spf=pass"),
    ).toBe("mx.example.com");
  });

  it("returns null when the header has no authserv-id (first segment is a method)", () => {
    // No leading unkeyed token — first `;` segment already contains `=`.
    expect(extractAuthservId("spf=pass smtp.mailfrom=a.com; dkim=pass")).toBeNull();
  });

  it("returns null for empty / missing input", () => {
    expect(extractAuthservId("")).toBeNull();
    expect(extractAuthservId(undefined)).toBeNull();
    expect(extractAuthservId(null)).toBeNull();
    expect(extractAuthservId("   ")).toBeNull();
  });

  it("does not split across multiple headers (only reads the first segment)", () => {
    // If a `;`-merged value were passed, the first segment is still just the
    // first authserv-id. (parse.ts must not merge — this just documents it.)
    expect(
      extractAuthservId("trusted.mx; spf=pass; attacker.mx; dmarc=pass"),
    ).toBe("trusted.mx");
  });
});

describe("parseAuthenticationResults", () => {
  it("returns null for empty / missing input", () => {
    expect(parseAuthenticationResults("")).toBeNull();
    expect(parseAuthenticationResults(undefined)).toBeNull();
    expect(parseAuthenticationResults(null)).toBeNull();
  });

  it("returns null when the header is just an authserv-id with no methods", () => {
    expect(parseAuthenticationResults("mx.example.com")).toBeNull();
    expect(parseAuthenticationResults("mx.example.com 1")).toBeNull();
  });

  it("skips the leading authserv-id segment and parses the verdicts", () => {
    const r = parseAuthenticationResults(
      "mx.cloudflare.net; spf=pass smtp.mailfrom=a@good.com;" +
        " dkim=pass header.d=good.com; dmarc=pass header.from=good.com",
    );
    expect(r).toEqual({
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
      from_domain: "good.com",
    });
  });

  it("does not treat the authserv-id token as a method", () => {
    // An authserv-id like "dkim.example.com" must not be mistaken for a dkim
    // verdict — it has no `=` so parseChunk drops it.
    const r = parseAuthenticationResults("dkim.example.com; spf=fail; dmarc=fail");
    expect(r?.spf).toBe("fail");
    // dkim was never stated -> defaults to "none", not anything from the id.
    expect(r?.dkim).toBe("none");
  });

  it("defaults unstated methods to none", () => {
    const r = parseAuthenticationResults("mx.example.com; spf=pass smtp.mailfrom=x@a.com");
    expect(r).toEqual({
      spf: "pass",
      dkim: "none",
      dmarc: "none",
      from_domain: "a.com",
    });
  });

  it("tolerates comments and mixed case", () => {
    const r = parseAuthenticationResults(
      "mx.example.com; SPF=Pass (good) smtp.mailfrom=user@A.COM;" +
        " DKIM=PASS header.d=A.com; DMARC=Pass header.from=a.com",
    );
    expect(r?.spf).toBe("pass");
    expect(r?.dkim).toBe("pass");
    expect(r?.dmarc).toBe("pass");
    expect(r?.from_domain).toBe("a.com");
  });

  it("takes the first verdict per method", () => {
    const r = parseAuthenticationResults(
      "mx.example.com; dkim=pass header.d=a.com; dkim=fail header.d=b.com",
    );
    expect(r?.dkim).toBe("pass");
  });
});
