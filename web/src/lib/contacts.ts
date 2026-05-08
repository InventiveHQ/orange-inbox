import { getDb } from "./db";

// Contacts are per-mailbox. user_id is the visibility key:
//   NULL  -> shared (every member of the mailbox sees this row)
//   set   -> personal (only that user sees it inside this mailbox)
//
// Auto-add on send writes shared rows. Manual add via the contacts page can
// pick either visibility.

export interface ContactRow {
  id: string;
  mailbox_id: string;
  user_id: string | null;
  email: string;
  name: string | null;
  notes: string | null;
  send_count: number;
  receive_count: number;
  first_seen_at: number;
  last_seen_at: number;
  scope: "shared" | "personal";
}

export interface ContactWithMailbox extends ContactRow {
  domain_name: string;
  local_part: string;
}

export interface ContactInput {
  mailbox_id: string;
  email: string;
  name?: string | null;
  notes?: string | null;
  shared: boolean;
}

// Lists everything the user can see in a mailbox (or across all their
// mailboxes if mailboxId is omitted): shared rows on accessible mailboxes
// plus this user's personal rows.
export async function listContactsForUser(
  userId: string,
  mailboxId?: string,
): Promise<ContactWithMailbox[]> {
  const where = [
    `uma.user_id = ?1`,
    `(c.user_id IS NULL OR c.user_id = ?1)`,
  ];
  const binds: unknown[] = [userId];
  if (mailboxId) {
    where.push("c.mailbox_id = ?2");
    binds.push(mailboxId);
  }
  const { results } = await getDb()
    .prepare(
      `SELECT c.id, c.mailbox_id, c.user_id, c.email, c.name, c.notes,
              c.send_count, c.receive_count, c.first_seen_at, c.last_seen_at,
              CASE WHEN c.user_id IS NULL THEN 'shared' ELSE 'personal' END AS scope,
              d.name AS domain_name, mb.local_part
         FROM contacts c
         INNER JOIN mailboxes mb ON mb.id = c.mailbox_id
         INNER JOIN domains d ON d.id = mb.domain_id
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = c.mailbox_id
        WHERE ${where.join(" AND ")}
        ORDER BY c.last_seen_at DESC, c.email`,
    )
    .bind(...binds)
    .all<ContactWithMailbox>();
  return results ?? [];
}

// Typeahead: prefix-ish match on email or name within one mailbox, capped to
// `limit`. Used by the compose To/Cc dropdown.
export async function searchContacts(
  userId: string,
  mailboxId: string,
  query: string,
  limit = 8,
): Promise<ContactRow[]> {
  const lim = Math.min(Math.max(limit, 1), 25);
  if (!await canReadMailbox(userId, mailboxId)) return [];
  const q = query.trim().toLowerCase();
  if (!q) {
    const { results } = await getDb()
      .prepare(
        `SELECT id, mailbox_id, user_id, email, name, notes,
                send_count, receive_count, first_seen_at, last_seen_at,
                CASE WHEN user_id IS NULL THEN 'shared' ELSE 'personal' END AS scope
           FROM contacts
          WHERE mailbox_id = ? AND (user_id IS NULL OR user_id = ?)
          ORDER BY last_seen_at DESC
          LIMIT ?`,
      )
      .bind(mailboxId, userId, lim)
      .all<ContactRow>();
    return results ?? [];
  }
  const like = `%${q}%`;
  const { results } = await getDb()
    .prepare(
      `SELECT id, mailbox_id, user_id, email, name, notes,
              send_count, receive_count, first_seen_at, last_seen_at,
              CASE WHEN user_id IS NULL THEN 'shared' ELSE 'personal' END AS scope
         FROM contacts
        WHERE mailbox_id = ? AND (user_id IS NULL OR user_id = ?)
          AND (email_lc LIKE ? OR LOWER(COALESCE(name,'')) LIKE ?)
        ORDER BY (email_lc LIKE ?) DESC, last_seen_at DESC
        LIMIT ?`,
    )
    .bind(mailboxId, userId, like, like, `${q}%`, lim)
    .all<ContactRow>();
  return results ?? [];
}

export async function createContact(
  userId: string,
  input: ContactInput,
): Promise<string> {
  if (!await canSendFromMailbox(userId, input.mailbox_id)) {
    throw new ContactError("forbidden", "You can't manage contacts on that mailbox.");
  }
  const email = input.email.trim();
  const emailLc = email.toLowerCase();
  if (!email || !emailLc.includes("@")) {
    throw new ContactError("invalid", "Email address is required.");
  }
  const id = crypto.randomUUID();
  try {
    await getDb()
      .prepare(
        `INSERT INTO contacts
           (id, mailbox_id, user_id, email, email_lc, name, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.mailbox_id,
        input.shared ? null : userId,
        email,
        emailLc,
        input.name?.trim() || null,
        input.notes?.trim() || null,
      )
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE")) {
      throw new ContactError("duplicate", "That contact already exists in this mailbox.");
    }
    throw e;
  }
  return id;
}

export async function updateContact(
  userId: string,
  contactId: string,
  patch: { name?: string | null; notes?: string | null; email?: string },
): Promise<boolean> {
  const c = await loadContactForUser(userId, contactId);
  if (!c) return false;

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    binds.push(patch.name == null ? null : String(patch.name).trim() || null);
  }
  if (patch.notes !== undefined) {
    sets.push("notes = ?");
    binds.push(patch.notes == null ? null : String(patch.notes).trim() || null);
  }
  if (patch.email !== undefined) {
    const email = String(patch.email).trim();
    if (!email.includes("@")) {
      throw new ContactError("invalid", "Email address is required.");
    }
    sets.push("email = ?", "email_lc = ?");
    binds.push(email, email.toLowerCase());
  }
  if (sets.length === 0) return true;
  binds.push(contactId);
  await getDb()
    .prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return true;
}

export async function deleteContact(userId: string, contactId: string): Promise<boolean> {
  const c = await loadContactForUser(userId, contactId);
  if (!c) return false;
  await getDb().prepare("DELETE FROM contacts WHERE id = ?").bind(contactId).run();
  return true;
}

// Auto-add on send: bumps send_count + last_seen_at, fills name if we didn't
// know one, on shared rows (user_id NULL). Idempotent — INSERT ... ON CONFLICT
// updates instead of failing the whole send if the contact already exists.
export async function recordSendRecipients(
  mailboxId: string,
  recipients: { email: string; name?: string | null }[],
): Promise<void> {
  if (recipients.length === 0) return;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const stmts: D1PreparedStatement[] = [];
  for (const r of recipients) {
    const email = r.email.trim();
    if (!email || !email.includes("@")) continue;
    const emailLc = email.toLowerCase();
    const id = crypto.randomUUID();
    stmts.push(
      db
        .prepare(
          `INSERT INTO contacts
             (id, mailbox_id, user_id, email, email_lc, name,
              send_count, first_seen_at, last_seen_at)
           VALUES (?, ?, NULL, ?, ?, ?, 1, ?, ?)
           ON CONFLICT (mailbox_id, COALESCE(user_id, ''), email_lc) DO UPDATE SET
             send_count   = send_count + 1,
             last_seen_at = excluded.last_seen_at,
             name         = COALESCE(contacts.name, excluded.name)`,
        )
        .bind(id, mailboxId, email, emailLc, r.name?.trim() || null, now, now),
    );
  }
  if (stmts.length > 0) await db.batch(stmts);
}

async function loadContactForUser(userId: string, contactId: string): Promise<ContactRow | null> {
  const row = await getDb()
    .prepare(
      `SELECT c.id, c.mailbox_id, c.user_id, c.email, c.name, c.notes,
              c.send_count, c.receive_count, c.first_seen_at, c.last_seen_at,
              CASE WHEN c.user_id IS NULL THEN 'shared' ELSE 'personal' END AS scope
         FROM contacts c
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = c.mailbox_id
        WHERE c.id = ? AND uma.user_id = ?
          AND (c.user_id IS NULL OR c.user_id = ?)`,
    )
    .bind(contactId, userId, userId)
    .first<ContactRow>();
  return row ?? null;
}

async function canReadMailbox(userId: string, mailboxId: string): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `SELECT 1 FROM user_mailbox_access WHERE user_id = ? AND mailbox_id = ? LIMIT 1`,
    )
    .bind(userId, mailboxId)
    .first();
  return row !== null;
}

async function canSendFromMailbox(userId: string, mailboxId: string): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `SELECT 1 FROM user_mailbox_access
        WHERE user_id = ? AND mailbox_id = ? AND role IN ('owner','member')
        LIMIT 1`,
    )
    .bind(userId, mailboxId)
    .first();
  return row !== null;
}

export class ContactError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
