import { getDb } from "./db";

export interface Identity {
  mailbox_id: string;
  domain_id: string;
  domain_name: string;
  local_part: string;
  display_name: string | null;
  signature_html: string | null;
  is_catch_all: number;
  role: "owner" | "member" | "reader";
}

// Mailboxes the user can SEND from — owner/member only. Readers are excluded
// because the role definition forbids outbound for them.
export async function listIdentities(userId: string): Promise<Identity[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT mb.id AS mailbox_id, d.id AS domain_id, d.name AS domain_name,
              mb.local_part, mb.display_name, mb.signature_html, mb.is_catch_all,
              uma.role
         FROM mailboxes mb
         INNER JOIN domains d ON d.id = mb.domain_id
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = mb.id
        WHERE uma.user_id = ? AND uma.role IN ('owner','member')
        ORDER BY d.name, mb.local_part`,
    )
    .bind(userId)
    .all<Identity>();
  return results ?? [];
}

// Every mailbox in the system, exposed in the Identity shape so the admin
// management UI can re-use the components built for the per-user list. The
// role is reported as 'owner' for sort/UI convenience; no per-user join is
// performed here since admin access is global.
export async function listAllIdentities(): Promise<Identity[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT mb.id AS mailbox_id, d.id AS domain_id, d.name AS domain_name,
              mb.local_part, mb.display_name, mb.signature_html, mb.is_catch_all,
              'owner' AS role
         FROM mailboxes mb
         INNER JOIN domains d ON d.id = mb.domain_id
        ORDER BY d.name, mb.local_part`,
    )
    .all<Identity>();
  return results ?? [];
}

// Used by the API to verify the chosen mailbox belongs to a (mailbox, role)
// the user can send from before we hand bytes to env.EMAIL.send().
export async function findIdentity(userId: string, mailboxId: string): Promise<Identity | null> {
  const row = await getDb()
    .prepare(
      `SELECT mb.id AS mailbox_id, d.id AS domain_id, d.name AS domain_name,
              mb.local_part, mb.display_name, mb.signature_html, mb.is_catch_all,
              uma.role
         FROM mailboxes mb
         INNER JOIN domains d ON d.id = mb.domain_id
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = mb.id
        WHERE mb.id = ? AND uma.user_id = ?`,
    )
    .bind(mailboxId, userId)
    .first<Identity>();
  return row ?? null;
}

export function fullAddress(i: Pick<Identity, "local_part" | "domain_name">): string {
  return `${i.local_part}@${i.domain_name}`;
}
