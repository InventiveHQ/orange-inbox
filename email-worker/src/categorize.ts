// Heuristic auto-categorization (#68). Every inbound message is tagged with
// one of {primary, promotions, updates, social, forums} at parse time. The
// web UI surfaces the tag as a tab strip above the inbox list (Primary by
// default, mirroring Gmail / Apple Mail).
//
// This is the v1 heuristic: rule-based, deterministic, runs in-Worker with
// zero network I/O. A trained classifier (v2) can replace it later by
// swapping out this function — the call site in store.ts is a single line.
//
// Precedence is intentional: Forums beats Updates beats Social beats
// Promotions beats Primary. Concretely we test in priority order and return
// on the first hit. The reasoning:
//
//   - Forums (List-Id) is the most specific signal we have — RFC 2919 lists
//     stamp it deliberately, and a mailing-list digest also bearing
//     List-Unsubscribe should still surface under Forums.
//   - Updates wins over Social because GitHub mail (e.g. notifications@github.com)
//     hits the Updates domain list AND would also hit Social via github.com;
//     "your build broke" is more useful in Updates than Social.
//   - Updates wins over Promotions because transactional senders (Stripe,
//     PayPal) often include unsubscribe headers on receipts; users care more
//     about receipts than the bulk-mail flag.
//   - Social wins over Promotions for the same reason — a LinkedIn digest
//     with List-Unsubscribe should appear under Social, not Promotions.
//
// All checks are case-insensitive on the from-domain. We lowercase the domain
// once and reuse.

import type { ParsedMessage } from "./types";

export type Category = "primary" | "promotions" | "updates" | "social" | "forums";

const SOCIAL_DOMAINS: ReadonlySet<string> = new Set([
  "facebook.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "instagram.com",
  "pinterest.com",
  "reddit.com",
  "tiktok.com",
  "youtube.com",
  "github.com",
]);

// Transactional / automation senders that ship system mail (receipts, build
// failures, deploy notifications, etc.). Note: github.com appears in both
// Social and Updates — Updates wins because we test it first.
const UPDATES_DOMAINS: ReadonlySet<string> = new Set([
  "stripe.com",
  "paypal.com",
  "github.com",
  "vercel.com",
  "aws.amazon.com",
  "cloudflare.com",
]);

// Local-parts that strongly suggest bulk / no-reply marketing. The match is
// against the local-part exactly (lowercased); if you're truly named "hello"
// at your own domain you'll get filed under Promotions when you also send
// with List-Unsubscribe — acceptable for v1.
const PROMOTIONAL_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "noreply",
  "no-reply",
  "hello",
  "news",
  "newsletter",
  "hi",
  "team",
  "info",
  "contact",
]);

const TRANSACTIONAL_SUBJECT_RE =
  /(receipt|invoice|order|verify|verification|confirm|password reset)\b/i;

export function categorize(parsed: ParsedMessage): Category {
  const fromAddr = parsed.from.addr.toLowerCase();
  const atIdx = fromAddr.lastIndexOf("@");
  const localPart = atIdx > 0 ? fromAddr.slice(0, atIdx) : "";
  const fromDomain = atIdx > 0 ? fromAddr.slice(atIdx + 1) : "";

  // 1. Forums — RFC 2919 List-Id is the canonical mailing-list signal.
  if (parsed.hasListId) return "forums";

  // 2. Updates — auto-submitted (anything other than "no" per RFC 3834),
  //    transactional/automation domains, or transactional subject lines.
  if (parsed.autoSubmitted && parsed.autoSubmitted !== "no") return "updates";
  if (UPDATES_DOMAINS.has(fromDomain)) return "updates";
  if (parsed.subject && TRANSACTIONAL_SUBJECT_RE.test(parsed.subject)) {
    return "updates";
  }

  // 3. Social — the major social/dev networks.
  if (SOCIAL_DOMAINS.has(fromDomain)) return "social";

  // 4. Promotions — List-Unsubscribe present AND one of the bulk-mail
  //    signals (promotional local-part, Precedence: bulk, or any other
  //    List-* header beyond List-Unsubscribe). Requiring both keeps a
  //    one-off newsletter from a real person out of Promotions.
  const hasListUnsub =
    parsed.listUnsubUrl !== null || parsed.listUnsubMailto !== null;
  if (hasListUnsub) {
    const promotionalLocal = PROMOTIONAL_LOCAL_PARTS.has(localPart);
    const bulkPrecedence = parsed.precedence === "bulk";
    // hasListHeaders is true for any List-*; we want to know if there's a
    // List-* header *other than* List-Unsubscribe. Since hasListUnsub already
    // implies List-Unsubscribe, treat hasListHeaders alone as "yes there's
    // also a List-Id / List-Owner / List-Help / etc." — but we already
    // returned forums above for List-Id, so any remaining List-* hint is a
    // useful tiebreaker for promotions.
    const otherListHint = parsed.hasListHeaders && !parsed.hasListId;
    if (promotionalLocal || bulkPrecedence || otherListHint) {
      return "promotions";
    }
  }

  return "primary";
}
