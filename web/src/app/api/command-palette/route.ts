import { NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  listDomainsForUser,
  listMailboxesForUser,
  listThreads,
} from "@/lib/queries";
import { listSavedSearches } from "@/lib/saved-searches";
import { listContactsForUser } from "@/lib/contacts";

// Bundle endpoint backing the command palette (issue #57). The palette opens
// on first ⌘K and fetches this once, caching client-side; the four lists are
// small (mailboxes/saved-searches are bounded by user; recent threads/contacts
// are capped server-side at 10) so a single round-trip beats four parallel
// calls and lets the search box become responsive without an empty state.
//
// Everything here is already access-scoped by user_id in the underlying
// queries; this route just narrows the wire shape to the fields the palette
// actually renders, to keep the response small.

const RECENT_LIMIT = 10;

export interface CommandPaletteMailbox {
  id: string;
  local_part: string;
  domain_name: string;
  is_catch_all: number;
}

export interface CommandPaletteDomain {
  id: string;
  name: string;
}

export interface CommandPaletteSavedSearch {
  id: string;
  name: string;
  query: string;
}

export interface CommandPaletteThread {
  id: string;
  subject: string;
  from_name: string | null;
  from_addr: string | null;
  mailbox_id: string;
  mailbox_local_part: string;
  domain_name: string;
  last_message_at: number;
}

export interface CommandPaletteContact {
  id: string;
  email: string;
  name: string | null;
  mailbox_id: string;
}

export interface CommandPaletteBundle {
  mailboxes: CommandPaletteMailbox[];
  domains: CommandPaletteDomain[];
  savedSearches: CommandPaletteSavedSearch[];
  recentThreads: CommandPaletteThread[];
  contacts: CommandPaletteContact[];
}

export async function GET() {
  try {
    const user = await requireUser();

    // Fan out the four reads in parallel — they hit different tables and
    // there's no inter-dependency. listThreads on the unified scope already
    // orders by pinned/last_message_at; we slice to RECENT_LIMIT for the
    // palette since the user is fuzzy-jumping, not browsing.
    const [mailboxes, domains, savedSearches, threads, contacts] =
      await Promise.all([
        listMailboxesForUser(user.id),
        listDomainsForUser(user.id),
        listSavedSearches(user.id),
        listThreads(user.id, { limit: RECENT_LIMIT, includeMuted: true }),
        listContactsForUser(user.id),
      ]);

    const bundle: CommandPaletteBundle = {
      mailboxes: mailboxes.map(mb => ({
        id: mb.id,
        local_part: mb.local_part,
        domain_name: mb.domain_name,
        is_catch_all: mb.is_catch_all,
      })),
      domains: domains.map(d => ({ id: d.id, name: d.name })),
      savedSearches: savedSearches.map(s => ({
        id: s.id,
        name: s.name,
        query: s.query,
      })),
      recentThreads: threads.slice(0, RECENT_LIMIT).map(t => ({
        id: t.id,
        subject: t.last_subject ?? t.subject_normalized ?? "(no subject)",
        from_name: t.last_from_name,
        from_addr: t.last_from_addr,
        mailbox_id: t.mailbox_id,
        mailbox_local_part: t.mailbox_local_part,
        domain_name: t.domain_name,
        last_message_at: t.last_message_at,
      })),
      // listContactsForUser orders by last_seen_at DESC already; take the
      // top 10 most recent so the palette doesn't ship every contact the
      // user has ever emailed.
      contacts: contacts.slice(0, RECENT_LIMIT).map(c => ({
        id: c.id,
        email: c.email,
        name: c.name,
        mailbox_id: c.mailbox_id,
      })),
    };

    return NextResponse.json(bundle, {
      // The palette's client cache (60s) is what users see — the response is
      // user-specific and changes whenever a thread arrives, so we don't ask
      // intermediate caches to hold it.
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    throw e;
  }
}
