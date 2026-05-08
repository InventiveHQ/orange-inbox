import { NextResponse } from "next/server";
import { UnauthenticatedError, requireUser } from "@/lib/auth";

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ user });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    throw e;
  }
}
