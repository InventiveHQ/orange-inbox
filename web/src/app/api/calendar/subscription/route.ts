import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import {
  ensureTokenForUser,
  rotateTokenForUser,
  type IcsTokenRow,
} from "@/lib/ics-tokens";

// Token management for the calendar subscription feed (#83).
//
// GET   /api/calendar/subscription        → returns the active token (lazy-
//                                           mints if none exists) plus the
//                                           webcal:// URL.
// POST  /api/calendar/subscription        → rotates: revokes the old, mints
//                                           a new.
//
// DELETE for revoke-without-replace lives at the per-token route at
// /api/calendar/subscription/[token] so the URL identifies what's being
// revoked.
//
// These routes are deliberately NOT under /p/ — that prefix carries a
// Cloudflare Access *Bypass* policy so external calendar apps can fetch the
// public feed (/p/api/calendar/ics/<token>) without an Access account. A
// bypass there would strip the Access JWT that requireUser() needs, turning
// every call to this management API into a 401.

export async function GET() {
  try {
    const user = await requireUser();
    const row = await ensureTokenForUser(user.id);
    return NextResponse.json(buildResponse(row, await resolveHost()));
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("ics tokens GET", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function POST() {
  try {
    const user = await requireUser();
    const row = await rotateTokenForUser(user.id);
    return NextResponse.json(buildResponse(row, await resolveHost()), {
      status: 201,
    });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    console.error("ics tokens POST", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

interface TokenResponse {
  token: string;
  scope: string;
  created_at: number;
  last_used_at: number | null;
  webcal_url: string;
  https_url: string;
}

function buildResponse(row: IcsTokenRow, host: string): TokenResponse {
  // webcal:// is the canonical scheme calendar clients sniff on; we also
  // expose the https:// twin so the user can paste it manually if their
  // client doesn't recognise webcal://.
  const path = `/p/api/calendar/ics/${row.token}`;
  return {
    token: row.token,
    scope: row.scope,
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
