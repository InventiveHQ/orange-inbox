import { listThreads, type MessageCategory, type ThreadListItem } from "./queries";

// Two-axis triage model: marketing × action_item. The default inbox view is
// (not_marketing, has_action_item) — i.e. mail you actually need to act on.
// The other quadrants live behind the toggle / sidebar entries.
//
// No classifier is implemented yet (no is_marketing / has_action_item columns
// on messages or threads_index). Until one lands, every quadrant resolves to
// the same underlying listing — the param plumbing is in place so the wiring
// is a one-line change once classification is available.
export type TriageQuadrant =
  | "inbox" // not_marketing & has_action_item — the default view
  | "marketing" // is_marketing & has_action_item
  | "done" // not_marketing & !has_action_item — read but not actionable
  | "all"; // every quadrant — escape hatch

export const DEFAULT_QUADRANT: TriageQuadrant = "inbox";
export const QUADRANT_VALUES: ReadonlySet<string> = new Set([
  "inbox",
  "marketing",
  "done",
  "all",
]);

export function parseQuadrant(raw: string | undefined | null): TriageQuadrant {
  if (raw && QUADRANT_VALUES.has(raw)) return raw as TriageQuadrant;
  return DEFAULT_QUADRANT;
}

export const QUADRANT_LABELS: Record<TriageQuadrant, string> = {
  inbox: "Inbox",
  marketing: "Marketing",
  done: "Done",
  all: "Show all",
};

// TODO: when the message classifier ships and threads_index gains
// is_marketing / has_action_item columns, push the quadrant predicate into
// the SQL in queries.ts (see listThreadsForTriage). Until then this is a
// pass-through so the UI plumbing can land independently.
export async function listThreadsForTriage(
  userId: string,
  opts: {
    quadrant: TriageQuadrant;
    mailboxId?: string;
    limit?: number;
    includeMuted?: boolean;
    // #68 category tabs are orthogonal to the (eventual) triage classifier;
    // forwarded straight through to listThreads.
    category?: MessageCategory;
  },
): Promise<ThreadListItem[]> {
  void opts.quadrant;
  return listThreads(userId, {
    mailboxId: opts.mailboxId,
    limit: opts.limit,
    includeMuted: opts.includeMuted,
    category: opts.category,
  });
}
