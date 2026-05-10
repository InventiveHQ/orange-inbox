import { getDb } from "./db";

// Per-user VIP sender list (issue #73). VIP addresses are decorated with a
// star/halo on their avatar, always classified Primary, and bypass DnD on
// notifications. Storage lives on the control DB in `vip_senders`, keyed by
// (user_id, addr) — addresses are normalised to lowercase on write so the
// case-insensitive lookups stay an exact-match index hit.

function normalise(addr: string): string {
  return addr.trim().toLowerCase();
}

// Add an address to the user's VIP list. Idempotent — re-adding is a no-op
// thanks to the (user_id, addr) primary key.
export async function addVip(userId: string, addr: string): Promise<void> {
  const a = normalise(addr);
  if (!a) return;
  await getDb()
    .prepare(
      `INSERT INTO vip_senders (user_id, addr)
         VALUES (?, ?)
         ON CONFLICT (user_id, addr) DO NOTHING`,
    )
    .bind(userId, a)
    .run();
}

// Remove an address from the user's VIP list.
export async function removeVip(userId: string, addr: string): Promise<void> {
  const a = normalise(addr);
  if (!a) return;
  await getDb()
    .prepare("DELETE FROM vip_senders WHERE user_id = ? AND addr = ?")
    .bind(userId, a)
    .run();
}

// True if the given address is in the user's VIP list. Case-insensitive.
export async function isVip(userId: string, addr: string): Promise<boolean> {
  const a = normalise(addr);
  if (!a) return false;
  const row = await getDb()
    .prepare("SELECT 1 AS ok FROM vip_senders WHERE user_id = ? AND addr = ? LIMIT 1")
    .bind(userId, a)
    .first<{ ok: number }>();
  return !!row;
}
