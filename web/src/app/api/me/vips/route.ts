import { NextRequest, NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";
import { addVip, removeVip } from "@/lib/vips";
import { listVipAddresses } from "@/lib/queries";

// VIP senders (issue #73). Per-user list of addresses whose mail always
// lands in Primary, gets a star/halo on the avatar, and overrides DnD on
// notifications. Addresses are case-folded on write — see lib/vips.ts.
//
// GET    — list of {addr, added_at} for the current user.
// POST   { addr } — add to the list. Idempotent.
// DELETE { addr } — remove from the list. Body-payload DELETE matches the
//          blocked-senders route: addresses can contain '@' which makes URL
//          composition fiddly, and the natural key is the address.

interface Body {
  addr?: string;
}

export async function GET() {
  try {
    const user = await requireUser();
    const addrs = await listVipAddresses(user.id);
    return NextResponse.json({ vips: addrs });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const b = (await req.json().catch(() => null)) as Body | null;
    const addr = b?.addr?.trim();
    if (!addr) {
      return NextResponse.json({ error: "addr required" }, { status: 400 });
    }
    await addVip(user.id, addr);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await requireUser();
    const b = (await req.json().catch(() => null)) as Body | null;
    const addr = b?.addr?.trim();
    if (!addr) {
      return NextResponse.json({ error: "addr required" }, { status: 400 });
    }
    await removeVip(user.id, addr);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

function errorResponse(e: unknown) {
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  console.error(e);
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
