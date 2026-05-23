import { listThreads, type MessageCategory, type ThreadListItem } from "./queries";

// Two-axis triage model: marketing × action_item. Every inbound message is
// tagged at ingest by email-worker/src/triage.ts; the unified "all" inbox
// renders a four-tab strip on top of those flags:
//
//   action_needed   — not_marketing & has_action_item   (default; #3)
//   quiet_humans    — not_marketing & !has_action_item  (Quiet lane; #7)
//   marketing_action — marketing  & has_action_item     (receipts / verifies)
//   marketing_quiet — marketing  & !has_action_item     (newsletters)
//
// `all` is the escape hatch — same listing the inbox showed before the
// triage strip landed.
export type TriageQuadrant =
  | "action_needed"
  | "quiet_humans"
  | "marketing_action"
  | "marketing_quiet"
  | "all";

export const DEFAULT_QUADRANT: TriageQuadrant = "all";
export const QUADRANT_VALUES: ReadonlySet<string> = new Set([
  "action_needed",
  "quiet_humans",
  "marketing_action",
  "marketing_quiet",
  "all",
]);

export function parseQuadrant(raw: string | undefined | null): TriageQuadrant {
  if (raw && QUADRANT_VALUES.has(raw)) return raw as TriageQuadrant;
  return DEFAULT_QUADRANT;
}

export const QUADRANT_LABELS: Record<TriageQuadrant, string> = {
  action_needed: "Primary action",
  quiet_humans: "Quiet",
  marketing_action: "Bulk action",
  marketing_quiet: "Newsletters",
  all: "Show all",
};

// Filter predicate for the listing layer. Returns null when the quadrant
// is "all" (no filter); otherwise an object describing which messages in
// a thread must match. "Any message in the thread matches" semantics mirror
// the #68 category filter so a single bulk reply on an otherwise-quiet
// thread still flips it into the relevant quadrant.
export interface TriagePredicate {
  isMarketing: 0 | 1;
  isActionItem: 0 | 1;
}

export function quadrantPredicate(q: TriageQuadrant): TriagePredicate | null {
  switch (q) {
    case "action_needed":
      return { isMarketing: 0, isActionItem: 1 };
    case "quiet_humans":
      return { isMarketing: 0, isActionItem: 0 };
    case "marketing_action":
      return { isMarketing: 1, isActionItem: 1 };
    case "marketing_quiet":
      return { isMarketing: 1, isActionItem: 0 };
    case "all":
      return null;
  }
}

export async function listThreadsForTriage(
  userId: string,
  opts: {
    quadrant: TriageQuadrant;
    mailboxId?: string;
    limit?: number;
    includeMuted?: boolean;
    // "Show all" callers pass true so archived threads surface alongside
    // everything else — the button is meant to be a true escape hatch.
    includeArchived?: boolean;
    // #68 category tabs are orthogonal to the triage classifier; passed
    // straight through to listThreads.
    category?: MessageCategory;
  },
): Promise<ThreadListItem[]> {
  return listThreads(userId, {
    mailboxId: opts.mailboxId,
    limit: opts.limit,
    includeMuted: opts.includeMuted,
    includeArchived: opts.includeArchived,
    category: opts.category,
    triage: quadrantPredicate(opts.quadrant) ?? undefined,
  });
}
