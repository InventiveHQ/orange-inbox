import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  ALL_SCOPE,
  ensureTokenForScope,
  getActiveTokens,
  listFeedScopes,
  revokeAllTokens,
  rotateTokenForScope,
  type IcsTokenRow,
} from "@/lib/ics-tokens";

// Calendar-subscription management for the ICS feed (#83).
//
// GET   /api/calendar/subscription  → the current { mode, feeds } state.
// POST  /api/calendar/subscription  → body-driven:
//         { action: "rotate", scope }   rotate one feed's token.
//         { action: "set_mode", mode }  switch single ⇄ per_mailbox.
//
// DELETE for revoke-without-replace lives at the per-token route at
// /api/calendar/subscription/[token].
//
// "mode" is not stored — it's derived from which token scopes exist:
// "single" = a lone 'all'-scoped token; "per_mailbox" = one token per
// calendar. set_mode is a hard reset: revoke every token, mint the new set.
//
// These routes are deliberately NOT under /p/ — that prefix carries a
// Cloudflare Access *Bypass* policy so external calendar apps can fetch the
// public feed (/p/api/calendar/ics/<token>) without an Access account. A
// bypass there would strip the Access JWT that requireUser() needs, turning
// every call to this management API into a 401.

type Mode = "single" | "per_mailbox";

interface Feed {
  scope: string;
  label: string;
  token: string;
  created_at: number;
  last_used_at: number | null;
  webcal_url: string;
  https_url: string;
}

interface SubscriptionState {
  mode: Mode;
  feeds: Feed[];
}

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json(await buildState(user.id, await resolveHost()));
  } catch (e) {
    return errorResponse(e, "GET");
  }
}

interface PostBody {
  action?: string;
  mode?: string;
  scope?: string;
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = (await req.json().catch(() => null)) as PostBody | null;
    const host = await resolveHost();

    if (body?.action === "rotate") {
      if (!body.scope || typeof body.scope !== "string") {
        return NextResponse.json({ error: "missing_scope" }, { status: 400 });
      }
      await rotateTokenForScope(user.id, body.scope);
      return NextResponse.json(await buildState(user.id, host));
    }

    if (body?.action === "set_mode") {
      if (body.mode !== "single" && body.mode !== "per_mailbox") {
        return NextResponse.json({ error: "invalid_mode" }, { status: 400 });
      }
      // Switching modes is a hard reset: revoke every current token so the
      // old subscription URLs stop working, then mint the new mode's set.
      await revokeAllTokens(user.id);
      if (body.mode === "single") {
        await ensureTokenForScope(user.id, ALL_SCOPE);
      } else {
        for (const { scope } of await listFeedScopes(user.id)) {
          await ensureTokenForScope(user.id, scope);
        }
      }
      return NextResponse.json(await buildState(user.id, host), {
        status: 201,
      });
    }

    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  } catch (e) {
    return errorResponse(e, "POST");
  }
}

// Resolve the current state. Mode is derived: any active token whose scope
// isn't 'all' means we're in per_mailbox mode. Lazily mints whatever the
// current mode is missing — the 'all' token on first ever view, or a token
// for a mailbox added since the user switched to per_mailbox.
async function buildState(
  userId: string,
  host: string,
): Promise<SubscriptionState> {
  const active = await getActiveTokens(userId);
  const mode: Mode = active.some((t) => t.scope !== ALL_SCOPE)
    ? "per_mailbox"
    : "single";

  if (mode === "single") {
    const row = await ensureTokenForScope(userId, ALL_SCOPE);
    return { mode, feeds: [toFeed(row, "All calendars", host)] };
  }

  const feeds: Feed[] = [];
  for (const { scope, label } of await listFeedScopes(userId)) {
    const row = await ensureTokenForScope(userId, scope);
    feeds.push(toFeed(row, label, host));
  }
  return { mode, feeds };
}

function toFeed(row: IcsTokenRow, label: string, host: string): Feed {
  // webcal:// is the canonical scheme calendar clients sniff on; we also
  // expose the https:// twin for clients that don't recognise webcal://.
  const path = `/p/api/calendar/ics/${row.token}`;
  return {
    scope: row.scope,
    label,
    token: row.token,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    webcal_url: `webcal://${host}${path}`,
    https_url: `https://${host}${path}`,
  };
}

async function resolveHost(): Promise<string> {
  try {
    const h = await headers();
    return h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
  } catch {
    return "localhost";
  }
}

function errorResponse(e: unknown, method: string) {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  console.error(`calendar subscription ${method}`, e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
