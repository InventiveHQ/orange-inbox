import { headers } from "next/headers";
import { getDb } from "./db";

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  is_admin: boolean;
  undo_send_seconds: number;
  // 0 = Sunday (US default), 1 = Monday (ISO). Other ints are reserved
  // (Saturday-first locales) — for now any value besides 1 is treated as 0
  // on the read side.
  week_start_day: number;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  is_admin: number;
  undo_send_seconds: number;
  week_start_day: number | null;
}

const ACCESS_EMAIL_HEADER = "cf-access-authenticated-user-email";

// Resolve the current user from the Cloudflare Access JWT/header set by
// Access in front of the host Worker. In `next dev` (no Access in the loop),
// fall back to DEV_USER_EMAIL so local development is usable.
export async function getCurrentUser(): Promise<User | null> {
  const email = await resolveEmail();
  if (!email) return null;

  const db = getDb();
  const existing = await db
    .prepare(
      "SELECT id, email, display_name, is_admin, undo_send_seconds, week_start_day FROM users WHERE email = ?",
    )
    .bind(email)
    .first<UserRow>();
  if (existing) {
    await db.prepare("UPDATE users SET last_seen_at = unixepoch() WHERE id = ?").bind(existing.id).run();
    return rowToUser(existing);
  }

  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO users (id, email, last_seen_at) VALUES (?, ?, unixepoch())")
    .bind(id, email)
    .run();
  return {
    id,
    email,
    display_name: null,
    is_admin: false,
    undo_send_seconds: 0,
    week_start_day: 0,
  };
}

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    throw new UnauthenticatedError();
  }
  return user;
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (!user.is_admin) {
    throw new ForbiddenError();
  }
  return user;
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("not authenticated");
  }
}

export class ForbiddenError extends Error {
  constructor() {
    super("forbidden");
  }
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    is_admin: row.is_admin === 1,
    undo_send_seconds: row.undo_send_seconds ?? 0,
    week_start_day: row.week_start_day === 1 ? 1 : 0,
  };
}

async function resolveEmail(): Promise<string | null> {
  const h = await headers();
  const fromAccess = h.get(ACCESS_EMAIL_HEADER);
  if (fromAccess) return fromAccess.trim().toLowerCase();

  if (process.env.NODE_ENV === "development" && process.env.DEV_USER_EMAIL) {
    return process.env.DEV_USER_EMAIL.trim().toLowerCase();
  }
  return null;
}
