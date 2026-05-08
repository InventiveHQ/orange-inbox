import { getDb } from "./db";

export interface Identity {
  mailbox_id: string;
  domain_id: string;
  domain_name: string;
  local_part: string;
  display_name: string | null;
  signature_html: string | null;
  is_catch_all: number;
  role: "admin" | "member" | "reader";
}

// Every (mailbox, domain) pair the user can send from.
export async function listIdentities(userId: string): Promise<Identity[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT mb.id AS mailbox_id, d.id AS domain_id, d.name AS domain_name,
              mb.local_part, mb.display_name, mb.signature_html, mb.is_catch_all,
              uda.role
         FROM mailboxes mb
         INNER JOIN domains d ON d.id = mb.domain_id
         INNER JOIN user_domain_access uda ON uda.domain_id = d.id
        WHERE uda.user_id = ?
        ORDER BY d.name, mb.local_part`,
    )
    .bind(userId)
    .all<Identity>();
  return results ?? [];
}

// Used by the API to verify the chosen mailbox belongs to a domain the user
// can send from before we hand bytes to env.EMAIL.send().
export async function findIdentity(userId: string, mailboxId: string): Promise<Identity | null> {
  const row = await getDb()
    .prepare(
      `SELECT mb.id AS mailbox_id, d.id AS domain_id, d.name AS domain_name,
              mb.local_part, mb.display_name, mb.signature_html, mb.is_catch_all,
              uda.role
         FROM mailboxes mb
         INNER JOIN domains d ON d.id = mb.domain_id
         INNER JOIN user_domain_access uda ON uda.domain_id = d.id
        WHERE mb.id = ? AND uda.user_id = ?`,
    )
    .bind(mailboxId, userId)
    .first<Identity>();
  return row ?? null;
}

export function fullAddress(i: Pick<Identity, "local_part" | "domain_name">): string {
  return `${i.local_part}@${i.domain_name}`;
}
