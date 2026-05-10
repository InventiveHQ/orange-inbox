import { getDb } from "./db";

// Contacts are per-mailbox. user_id is the visibility key:
//   NULL  -> shared (every member of the mailbox sees this row)
//   set   -> personal (only that user sees it inside this mailbox)
//
// Auto-add on send writes shared rows. Manual add via the contacts page can
// pick either visibility.

// Lifecycle pipeline. NULL means "unset" — we never default new rows into a
// stage so the picker shows the user's actual choice.
export const CONTACT_STAGES = [
  "lead",
  "contacted",
  "qualified",
  "customer",
  "lost",
] as const;
export type ContactStage = (typeof CONTACT_STAGES)[number];

export interface ContactRow {
  id: string;
  mailbox_id: string;
  user_id: string | null;
  email: string;
  name: string | null;
  notes: string | null;
  company: string | null;
  title: string | null;
  phone: string | null;
  website: string | null;
  linkedin: string | null;
  address: string | null;
  stage: ContactStage | null;
  tags: string[];
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
  company?: string | null;
  title?: string | null;
  phone?: string | null;
  website?: string | null;
  linkedin?: string | null;
  address?: string | null;
  stage?: ContactStage | null;
  tags?: string[];
  shared: boolean;
}

export interface ContactPatch {
  name?: string | null;
  notes?: string | null;
  email?: string;
  company?: string | null;
  title?: string | null;
  phone?: string | null;
  website?: string | null;
  linkedin?: string | null;
  address?: string | null;
  stage?: ContactStage | null;
  tags?: string[];
}

// Lightweight set of (a) emails the user has in their address book and (b)
// the unique domains that appear there. Used by the thread reader for the
// "In contacts" sender badge and to feed the lookalike-domain check
// (warn when a sender resembles a contact's domain). Single SELECT; cheap
// enough to call on every thread render.
export interface ContactsLookup {
  emails: Set<string>;
  domains: Set<string>;
}

export async function getContactsLookup(userId: string): Promise<ContactsLookup> {
  const { results } = await getDb()
    .prepare(
      `SELECT DISTINCT c.email_lc
         FROM contacts c
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = c.mailbox_id
        WHERE uma.user_id = ?1
          AND (c.user_id IS NULL OR c.user_id = ?1)`,
    )
    .bind(userId)
    .all<{ email_lc: string }>();
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const r of results ?? []) {
    if (!r.email_lc) continue;
    emails.add(r.email_lc);
    const at = r.email_lc.lastIndexOf("@");
    if (at !== -1) {
      const dom = r.email_lc.slice(at + 1);
      if (dom) domains.add(dom);
    }
  }
  return { emails, domains };
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
              c.company, c.title, c.phone, c.website, c.linkedin, c.address,
              c.stage, c.tags_json,
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
    .all<ContactWireRow & { domain_name: string; local_part: string }>();
  return (results ?? []).map(row => ({ ...parseWireRow(row), domain_name: row.domain_name, local_part: row.local_part }));
}

// Single-contact load for the detail page. Auth scoped: returns null if the
// caller doesn't have access to the row's mailbox or it's someone else's
// personal contact.
export async function getContactForUser(
  userId: string,
  contactId: string,
): Promise<ContactWithMailbox | null> {
  const row = await getDb()
    .prepare(
      `SELECT c.id, c.mailbox_id, c.user_id, c.email, c.name, c.notes,
              c.company, c.title, c.phone, c.website, c.linkedin, c.address,
              c.stage, c.tags_json,
              c.send_count, c.receive_count, c.first_seen_at, c.last_seen_at,
              CASE WHEN c.user_id IS NULL THEN 'shared' ELSE 'personal' END AS scope,
              d.name AS domain_name, mb.local_part
         FROM contacts c
         INNER JOIN mailboxes mb ON mb.id = c.mailbox_id
         INNER JOIN domains d ON d.id = mb.domain_id
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = c.mailbox_id
        WHERE c.id = ? AND uma.user_id = ?
          AND (c.user_id IS NULL OR c.user_id = ?)`,
    )
    .bind(contactId, userId, userId)
    .first<ContactWireRow & { domain_name: string; local_part: string }>();
  if (!row) return null;
  return { ...parseWireRow(row), domain_name: row.domain_name, local_part: row.local_part };
}

export interface ContactThreadRow {
  thread_id: string;
  subject_normalized: string;
  last_message_at: number;
  message_count: number;
  unread_count: number;
  domain_name: string;
  mailbox_id: string;
  mailbox_local_part: string;
  last_subject: string | null;
  last_snippet: string | null;
}

// Cross-mailbox thread history for a contact: every thread (in mailboxes the
// user can read) where this email appears as sender or recipient. The
// to_json/cc_json columns are JSON blobs so we use a LIKE on the lowercased
// `"addr":"<email>"` substring — quoted to avoid prefix collisions.
export async function listThreadsForContactEmail(
  userId: string,
  email: string,
  limit = 50,
): Promise<ContactThreadRow[]> {
  const lim = Math.min(Math.max(limit, 1), 200);
  const lc = email.toLowerCase();
  const jsonNeedle = `%"${lc.replace(/"/g, '""')}"%`;
  const { results } = await getDb()
    .prepare(
      `SELECT t.id AS thread_id, t.subject_normalized, t.last_message_at,
              t.message_count, t.unread_count,
              d.name AS domain_name,
              mb.id AS mailbox_id, mb.local_part AS mailbox_local_part,
              (SELECT subject  FROM messages WHERE thread_id = t.id ORDER BY date DESC LIMIT 1) AS last_subject,
              (SELECT snippet  FROM messages WHERE thread_id = t.id ORDER BY date DESC LIMIT 1) AS last_snippet
         FROM threads t
         INNER JOIN mailboxes mb ON mb.id = t.mailbox_id
         INNER JOIN domains d ON d.id = mb.domain_id
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = t.mailbox_id
        WHERE uma.user_id = ?
          AND EXISTS (
            SELECT 1 FROM messages m
             WHERE m.thread_id = t.id
               AND (
                 LOWER(m.from_addr) = ?
                 OR LOWER(COALESCE(m.to_json,'')) LIKE ?
                 OR LOWER(COALESCE(m.cc_json,'')) LIKE ?
               )
          )
        ORDER BY t.last_message_at DESC
        LIMIT ?`,
    )
    .bind(userId, lc, jsonNeedle, jsonNeedle, lim)
    .all<ContactThreadRow>();
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
                company, title, phone, website, linkedin, address,
                stage, tags_json,
                send_count, receive_count, first_seen_at, last_seen_at,
                CASE WHEN user_id IS NULL THEN 'shared' ELSE 'personal' END AS scope
           FROM contacts
          WHERE mailbox_id = ? AND (user_id IS NULL OR user_id = ?)
          ORDER BY last_seen_at DESC
          LIMIT ?`,
      )
      .bind(mailboxId, userId, lim)
      .all<ContactWireRow>();
    return (results ?? []).map(parseWireRow);
  }
  const like = `%${q}%`;
  const { results } = await getDb()
    .prepare(
      `SELECT id, mailbox_id, user_id, email, name, notes,
              company, title, phone, website, linkedin, address,
              stage, tags_json,
              send_count, receive_count, first_seen_at, last_seen_at,
              CASE WHEN user_id IS NULL THEN 'shared' ELSE 'personal' END AS scope
         FROM contacts
        WHERE mailbox_id = ? AND (user_id IS NULL OR user_id = ?)
          AND (email_lc LIKE ? OR LOWER(COALESCE(name,'')) LIKE ?)
        ORDER BY (email_lc LIKE ?) DESC, last_seen_at DESC
        LIMIT ?`,
    )
    .bind(mailboxId, userId, like, like, `${q}%`, lim)
    .all<ContactWireRow>();
  return (results ?? []).map(parseWireRow);
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
           (id, mailbox_id, user_id, email, email_lc, name, notes,
            company, title, phone, website, linkedin, address, stage, tags_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.mailbox_id,
        input.shared ? null : userId,
        email,
        emailLc,
        input.name?.trim() || null,
        input.notes?.trim() || null,
        input.company?.trim() || null,
        input.title?.trim() || null,
        input.phone?.trim() || null,
        input.website?.trim() || null,
        input.linkedin?.trim() || null,
        input.address?.trim() || null,
        normalizeStage(input.stage),
        serializeTags(input.tags),
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
  patch: ContactPatch,
): Promise<boolean> {
  const c = await loadContactForUser(userId, contactId);
  if (!c) return false;

  const sets: string[] = [];
  const binds: unknown[] = [];
  const setStr = (col: string, v: string | null | undefined) => {
    if (v === undefined) return;
    sets.push(`${col} = ?`);
    binds.push(v == null ? null : String(v).trim() || null);
  };
  setStr("name", patch.name);
  setStr("notes", patch.notes);
  setStr("company", patch.company);
  setStr("title", patch.title);
  setStr("phone", patch.phone);
  setStr("website", patch.website);
  setStr("linkedin", patch.linkedin);
  setStr("address", patch.address);
  if (patch.stage !== undefined) {
    sets.push("stage = ?");
    binds.push(normalizeStage(patch.stage));
  }
  if (patch.tags !== undefined) {
    sets.push("tags_json = ?");
    binds.push(serializeTags(patch.tags));
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

// Wire shape for everything we read out of the contacts table — JSON-encoded
// fields land here and get inflated by `parseWireRow`.
interface ContactWireRow extends Omit<ContactRow, "tags" | "stage"> {
  stage: string | null;
  tags_json: string | null;
}

function parseWireRow(row: ContactWireRow): ContactRow {
  let tags: string[] = [];
  if (row.tags_json) {
    try {
      const parsed = JSON.parse(row.tags_json);
      if (Array.isArray(parsed)) {
        tags = parsed.filter((t): t is string => typeof t === "string");
      }
    } catch {
      tags = [];
    }
  }
  const { tags_json: _t, stage, ...rest } = row;
  void _t;
  return {
    ...rest,
    stage: CONTACT_STAGES.includes(stage as ContactStage) ? (stage as ContactStage) : null,
    tags,
  };
}

function serializeTags(tags: string[] | undefined): string | null {
  if (!tags) return null;
  const cleaned = Array.from(
    new Set(
      tags
        .map(t => (typeof t === "string" ? t.trim() : ""))
        .filter(t => t.length > 0 && t.length <= 40),
    ),
  );
  return cleaned.length === 0 ? null : JSON.stringify(cleaned);
}

function normalizeStage(stage: ContactStage | null | undefined): string | null {
  if (stage == null) return null;
  return CONTACT_STAGES.includes(stage) ? stage : null;
}

async function loadContactForUser(userId: string, contactId: string): Promise<ContactRow | null> {
  const row = await getDb()
    .prepare(
      `SELECT c.id, c.mailbox_id, c.user_id, c.email, c.name, c.notes,
              c.company, c.title, c.phone, c.website, c.linkedin, c.address,
              c.stage, c.tags_json,
              c.send_count, c.receive_count, c.first_seen_at, c.last_seen_at,
              CASE WHEN c.user_id IS NULL THEN 'shared' ELSE 'personal' END AS scope
         FROM contacts c
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = c.mailbox_id
        WHERE c.id = ? AND uma.user_id = ?
          AND (c.user_id IS NULL OR c.user_id = ?)`,
    )
    .bind(contactId, userId, userId)
    .first<ContactWireRow>();
  return row ? parseWireRow(row) : null;
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
