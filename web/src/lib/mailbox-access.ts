import { getDb } from "./db";

// Domain admin? Used to gate "create new mailbox on this domain".
export async function isDomainAdmin(userId: string, domainId: string): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `SELECT 1 FROM user_domain_access
        WHERE user_id = ? AND domain_id = ? AND role = 'admin'
        LIMIT 1`,
    )
    .bind(userId, domainId)
    .first();
  return row !== null;
}

// Mailbox owner? Used to gate member-management actions on the mailbox.
export async function isMailboxOwner(userId: string, mailboxId: string): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `SELECT 1 FROM user_mailbox_access
        WHERE user_id = ? AND mailbox_id = ? AND role = 'owner'
        LIMIT 1`,
    )
    .bind(userId, mailboxId)
    .first();
  return row !== null;
}

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
