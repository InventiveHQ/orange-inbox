import { NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { listThreadsForTriage } from "@/lib/triage";
import type { ThreadListItem } from "@/lib/queries";

// Backs the mobile Triage deck (Superhuman-style "swipe through what's left").
// The deck is the post-AI human pile: action-needed humans first (so the CEO
// surfaces early), then quiet humans. Marketing is excluded entirely — the
// auto-archive sweep / Newsletters lane handle that, and the whole point is a
// SMALL deck you can clear in a minute. Both quadrants exclude archived, so
// already-filed mail never reappears here.

const PER_QUADRANT_LIMIT = 100;

export interface TriageDeckCard {
  id: string;
  subject: string | null;
  from_name: string | null;
  from_addr: string | null;
  snippet: string | null;
  mailbox_local_part: string;
  domain_name: string;
  unread: boolean;
  starred: boolean;
  follow_up_enabled: boolean;
  // "action" cards (a human is waiting on a reply) lead the deck; "quiet"
  // cards (FYI humans, no action) follow. Surfaced so the card UI can tint /
  // label the two differently.
  lane: "action" | "quiet";
}

function toCard(t: ThreadListItem, lane: "action" | "quiet"): TriageDeckCard {
  return {
    id: t.id,
    subject: t.last_subject ?? t.subject_normalized ?? null,
    from_name: t.last_from_name,
    from_addr: t.last_from_addr,
    snippet: t.last_snippet,
    mailbox_local_part: t.mailbox_local_part,
    domain_name: t.domain_name,
    unread: t.unread_count > 0,
    starred: t.starred === 1,
    follow_up_enabled: t.follow_up_enabled === 1,
    lane,
  };
}

export async function GET() {
  try {
    const user = await requireUser();
    const [action, quiet] = await Promise.all([
      listThreadsForTriage(user.id, {
        quadrant: "action_needed",
        limit: PER_QUADRANT_LIMIT,
      }),
      listThreadsForTriage(user.id, {
        quadrant: "quiet_humans",
        limit: PER_QUADRANT_LIMIT,
      }),
    ]);

    const seen = new Set<string>();
    const cards: TriageDeckCard[] = [];
    for (const t of action) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      cards.push(toCard(t, "action"));
    }
    for (const t of quiet) {
      // "any message matches" triage semantics can place a thread in both
      // lanes; the action lane wins (it led the loop), so just skip dupes.
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      cards.push(toCard(t, "quiet"));
    }

    return NextResponse.json({ cards });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    throw e;
  }
}
