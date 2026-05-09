import { getDb } from "./db";

// Mailbox membership and per-mailbox role helpers. Management actions
// (member CRUD, mailbox CRUD, domain CRUD) are gated globally via
// users.is_admin — see web/src/lib/auth.ts. The role column on
// user_mailbox_access is retained as an access grant (owner/member/reader
// determine outbound-send eligibility) but no longer drives gating.

export interface MailboxMember {
  user_id: string;
  email: string;
  display_name: string | null;
  role: "owner" | "member" | "reader";
  created_at: number;
}

export async function listMailboxMembers(mailboxId: string): Promise<MailboxMember[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT u.id AS user_id, u.email, u.display_name, uma.role, uma.created_at
         FROM user_mailbox_access uma
         INNER JOIN users u ON u.id = uma.user_id
        WHERE uma.mailbox_id = ?
        ORDER BY uma.role, u.email`,
    )
    .bind(mailboxId)
    .all<MailboxMember>();
  return results ?? [];
}

// Look up an existing user row by email, or create one. Lets a mailbox owner
// invite someone before that someone has ever signed in — they'll get the
// access on first auth.
export async function findOrCreateUserByEmail(email: string): Promise<{ id: string; created: boolean }> {
  const norm = email.trim().toLowerCase();
  const existing = await getDb()
    .prepare("SELECT id FROM users WHERE email = ?")
    .bind(norm)
    .first<{ id: string }>();
  if (existing) return { id: existing.id, created: false };

  const id = crypto.randomUUID();
  await getDb()
    .prepare("INSERT INTO users (id, email) VALUES (?, ?)")
    .bind(id, norm)
    .run();
  return { id, created: true };
}
