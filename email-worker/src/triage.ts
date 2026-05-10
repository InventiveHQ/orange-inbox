// Two-axis triage classifier (#3 + #7). Every inbound message gets tagged
// with (is_marketing, is_action_item) at parse time. The web triage bar
// uses the pair to filter the unified inbox into four quadrants:
//
//   (not marketing, action)    — "Primary action" / things to do (default)
//   (not marketing, no action) — "Quiet" — FYI/no-action humans (#7)
//   (marketing, action)        — receipts / verifies — bulk, but actionable
//   (marketing, no action)     — newsletters and other standard promo blasts
//
// This is the v1 heuristic: rule-based, deterministic. classify() is pure
// over its inputs — store.ts gathers the per-message context (firstContact,
// VIP/contacts/mailbox-owner lookups) and passes them in alongside the
// ParsedMessage so the function stays trivially testable.
//
// A trained classifier can replace this later by swapping out classify();
// the call site in store.ts is a single line.

import { categorize } from "./categorize";
import type { ParsedMessage } from "./types";

export interface TriageContext {
  // True when from_addr's domain appears in the user's contacts. Drives the
  // DMARC-fail-bypass: a known-correspondent failing DMARC stays out of the
  // marketing lane (the failure is more likely a forwarder breaking signing
  // than a marketing blast).
  senderDomainInContacts: boolean;
  // True when from_addr is on the receiving user's VIP list (#73).
  fromAddrIsVip: boolean;
  // True the first time this from_addr appears in the destination mailbox.
  // Used together with `mailboxIsOwned` — a non-first-contact inbound to a
  // mailbox the user owns is a reply on an existing business thread, which
  // expects a response from them.
  firstContact: boolean;
  // True when the destination mailbox has the receiving user listed as
  // owner. Distinguishes "shared/owned mailbox" (replies-expected) from
  // a reader's mirror.
  mailboxIsOwned: boolean;
}

// Subject patterns that flag a message as an action item. Each token is a
// case-insensitive substring match against the subject. Includes verbs the
// spec calls out plus the urgency cues "asap" / "urgent" / "by EOD" /
// "by tomorrow".
const ACTION_SUBJECT_RE =
  /\b(review|approve|sign|confirm|verify|respond|reply|urgent|asap)\b|by eod|by tomorrow/i;

// Bulk-mail categories from #68 (#3's marketing rule reuses these).
const BULK_CATEGORIES = new Set(["promotions", "social", "updates", "forums"]);

export interface TriageResult {
  isMarketing: boolean;
  isActionItem: boolean;
}

// Default context — used when callers (or tests) don't have the per-user
// signals to hand. Everything off, so classify() degrades gracefully to
// "header-only" inputs.
const DEFAULT_CONTEXT: TriageContext = {
  senderDomainInContacts: false,
  fromAddrIsVip: false,
  firstContact: false,
  mailboxIsOwned: false,
};

// Pure classifier. Both flags are computed independently — a single
// message can be both marketing and an action item (e.g. a "verify your
// email" blast).
export function classify(
  parsed: ParsedMessage,
  ctx: TriageContext = DEFAULT_CONTEXT,
): TriageResult {
  return {
    isMarketing: isMarketing(parsed, ctx),
    isActionItem: isActionItem(parsed, ctx),
  };
}

function isMarketing(parsed: ParsedMessage, ctx: TriageContext): boolean {
  // 1. RFC 2369 List-Unsubscribe headers are the canonical "this is bulk
  //    mail" signal — present on every legitimate newsletter / promo blast
  //    and (per RFC 8058) required for one-click unsubscribe in Gmail/Yahoo.
  if (parsed.listUnsubUrl !== null || parsed.listUnsubMailto !== null) {
    return true;
  }

  // 2. The category classifier (#68) already filed bulk mail into one of
  //    the non-Primary categories. Reuse that decision.
  const cat = categorize(parsed);
  if (BULK_CATEGORIES.has(cat)) return true;

  // 3. DMARC fail from a sender domain we don't know is a strong "this is
  //    spoofed marketing / spam" signal — but only when the receiver has no
  //    prior relationship with the sender. Forwarding services routinely
  //    break DMARC for legitimate correspondents.
  const dmarc = parsed.authResults?.dmarc;
  if (dmarc && dmarc !== "pass" && !ctx.senderDomainInContacts) {
    return true;
  }

  return false;
}

function isActionItem(parsed: ParsedMessage, ctx: TriageContext): boolean {
  // 1. Imperative verbs / urgency cues in the subject. Cheap regex,
  //    high-precision signal on the "verify your account" / "please review"
  //    pattern.
  if (parsed.subject && ACTION_SUBJECT_RE.test(parsed.subject)) {
    return true;
  }

  // 2. A '?' in the first 500 chars of the text body — somebody is asking
  //    a question, and the user is probably the one expected to answer.
  //    Snippet would be cheaper but is capped at 200 chars; we want the
  //    full window the spec calls for.
  if (parsed.text) {
    const head = parsed.text.slice(0, 500);
    if (head.includes("?")) return true;
  }

  // 3. Inbound from a VIP — by definition this user wants to act on it.
  //    Spec scopes this to direction=inbound; classify() is only called on
  //    inbound mail at the call site, so we don't re-check here.
  if (ctx.fromAddrIsVip) return true;

  // 4. Inbound to a mailbox the user owns + we've seen this sender before
  //    — i.e. an in-progress business thread on the user's primary mailbox.
  //    Replies expected.
  if (ctx.mailboxIsOwned && !ctx.firstContact) return true;

  return false;
}
