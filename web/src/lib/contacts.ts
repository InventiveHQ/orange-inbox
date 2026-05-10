import { getDb } from "./db";
import { getActiveMailDbs } from "./mail-db";
import {
  inferTzFromDomain,
  inferTzFromSignature,
  isValidIanaTz,
  shouldOverwriteTz,
  type ContactTzSource,
} from "./contact-tz";
import { extractSignature } from "./signature-extract";

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
  // Per-contact timezone (#88). `tz` is the IANA zone string, `tz_source`
  // records where it came from so a manual override survives a re-run of
  // the heuristic. `tz_inferred_at` doubles as the "have we tried yet?"
  // gate — NULL means inference hasn't run for this contact at all.
  tz: string | null;
  tz_source: ContactTzSource | null;
  tz_inferred_at: number | null;
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
  // Manual tz override from the contact card. Setting this routes through
  // setContactTz() with source='manual' so it pins the value against any
  // future heuristic re-scan. Null clears the manual override and lets the
  // next read re-run inference.
  tz?: string | null;
}

// Lightweight set of (a) emails the user has in their address book, (b)
// the unique domains that appear there, and (c) a per-email tz map for the
// "their local time" pill (#88). Used by the thread reader for the
// "In contacts" sender badge, the lookalike-domain check, and the
// RelativeTime pill next to inbound senders. Single SELECT; cheap enough
// to call on every thread render.
export interface ContactsLookup {
  emails: Set<string>;
  domains: Set<string>;
  // email_lc -> { tz, source } for contacts that have a resolved tz.
  // Missing key = no tz known (or contact not in address book).
  tzByEmail: Map<string, { tz: string; source: ContactTzSource }>;
}

export async function getContactsLookup(userId: string): Promise<ContactsLookup> {
  const { results } = await getDb()
    .prepare(
      `SELECT DISTINCT c.email_lc, c.tz, c.tz_source
         FROM contacts c
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = c.mailbox_id
        WHERE uma.user_id = ?1
          AND (c.user_id IS NULL OR c.user_id = ?1)`,
    )
    .bind(userId)
    .all<{ email_lc: string; tz: string | null; tz_source: string | null }>();
  const emails = new Set<string>();
  const domains = new Set<string>();
  const tzByEmail = new Map<string, { tz: string; source: ContactTzSource }>();
  for (const r of results ?? []) {
    if (!r.email_lc) continue;
    emails.add(r.email_lc);
    const at = r.email_lc.lastIndexOf("@");
    if (at !== -1) {
      const dom = r.email_lc.slice(at + 1);
      if (dom) domains.add(dom);
    }
    if (r.tz) {
      const source: ContactTzSource | null =
        r.tz_source === "manual" || r.tz_source === "signature" || r.tz_source === "domain"
          ? r.tz_source
          : null;
      // Source must be one of the known three to surface — defensive
      // against schema drift on older rows. Default to 'domain' (the
      // weakest source) so the pill still renders.
      tzByEmail.set(r.email_lc, { tz: r.tz, source: source ?? "domain" });
    }
  }
  return { emails, domains, tzByEmail };
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
              c.tz, c.tz_source, c.tz_inferred_at,
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
              c.tz, c.tz_source, c.tz_inferred_at,
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
  const base: ContactWithMailbox = {
    ...parseWireRow(row),
    domain_name: row.domain_name,
    local_part: row.local_part,
  };
  // Lazy inference: first time anyone opens the contact card, run the
  // signature heuristic + domain fallback. Subsequent reads stay fast
  // because tz_inferred_at gets stamped either way (#88).
  if (base.tz_inferred_at == null) {
    try {
      const updated = await maybeInferContactTz(base);
      return { ...updated, domain_name: row.domain_name, local_part: row.local_part };
    } catch (err) {
      // Best-effort — don't block the contact page on inference.
      console.warn("contact tz inference failed", err);
    }
  }
  return base;
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
                tz, tz_source, tz_inferred_at,
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
  if (patch.tz !== undefined) {
    // Manual tz override. We treat a non-empty string as a 'manual' source
    // (highest precedence — sticks against any future heuristic re-scan).
    // An empty string / null clears the override and unsets tz_inferred_at
    // so the next read can re-run inference from scratch.
    if (patch.tz && patch.tz.trim()) {
      const tz = patch.tz.trim();
      if (!isValidIanaTz(tz)) {
        throw new ContactError("invalid", "Unknown time zone.");
      }
      sets.push("tz = ?", "tz_source = ?", "tz_inferred_at = ?");
      binds.push(tz, "manual", Math.floor(Date.now() / 1000));
    } else {
      sets.push("tz = NULL", "tz_source = NULL", "tz_inferred_at = NULL");
    }
  }
  if (sets.length === 0) return true;
  binds.push(contactId);
  await getDb()
    .prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return true;
}

// Direct tz writer. Used by both the manual-override path (source='manual')
// and the lazy inference path (source='signature' | 'domain'). Enforces
// the precedence rule: a higher-precedence existing value can't be
// overwritten by a lower-precedence new one.
//
// Always updates tz_inferred_at — even when the value didn't change — so
// subsequent reads see "we already tried" and skip the heuristic.
export async function setContactTz(
  contactId: string,
  tz: string | null,
  source: ContactTzSource,
): Promise<void> {
  if (tz != null && !isValidIanaTz(tz)) return;
  const db = getDb();
  const existing = await db
    .prepare(`SELECT tz, tz_source FROM contacts WHERE id = ?`)
    .bind(contactId)
    .first<{ tz: string | null; tz_source: string | null }>();
  if (!existing) return;
  if (!shouldOverwriteTz(existing.tz_source, source)) {
    // Higher-precedence value already set; just update the inferred_at
    // gate so we don't keep re-running the heuristic on every read.
    await db
      .prepare(`UPDATE contacts SET tz_inferred_at = ? WHERE id = ?`)
      .bind(Math.floor(Date.now() / 1000), contactId)
      .run();
    return;
  }
  await db
    .prepare(
      `UPDATE contacts
          SET tz = ?, tz_source = ?, tz_inferred_at = ?
        WHERE id = ?`,
    )
    .bind(tz, source, Math.floor(Date.now() / 1000), contactId)
    .run();
}

// Read-only lookup. Returns the stored tz + source, or null if there isn't
// one. Auth-scoped: callers should pre-validate the contact belongs to a
// mailbox the viewer can read; we don't gate that here so server-side
// triage hooks can call it without a userId in hand.
export async function getContactTz(
  contactId: string,
): Promise<{ tz: string | null; source: ContactTzSource | null } | null> {
  const row = await getDb()
    .prepare(`SELECT tz, tz_source FROM contacts WHERE id = ?`)
    .bind(contactId)
    .first<{ tz: string | null; tz_source: string | null }>();
  if (!row) return null;
  const source: ContactTzSource | null =
    row.tz_source === "manual" || row.tz_source === "signature" || row.tz_source === "domain"
      ? row.tz_source
      : null;
  return { tz: row.tz, source };
}

// Lazy-on-read inference. Runs the signature heuristic against the contact's
// most recent inbound message body, then falls back to the TLD lookup. Only
// fires when `tz_inferred_at` is NULL — once we've tried, we don't re-try
// even if the signature changes (the user can hit "Edit time zone" to force
// a re-scan via the manual override clear path).
//
// Does nothing for personal contacts whose user-scoped row would otherwise
// require a per-user history scan; the heuristic applies equally well to
// shared rows so we just gate on "have we tried", not visibility.
//
// Best-effort: any failure (no inbound messages, R2 hiccup, malformed body)
// silently leaves tz_inferred_at NULL so the next read can retry.
export async function maybeInferContactTz(
  contact: ContactRow,
): Promise<ContactRow> {
  if (contact.tz_inferred_at != null) return contact;
  // Already pinned by the user — nothing to infer.
  if (contact.tz_source === "manual" && contact.tz != null) return contact;

  // Step 1: signature scan against the most recent inbound message body
  // for this email in any mail DB. We only sample the latest one; a real
  // signature-extraction pipeline would deduplicate the trailer block but
  // we don't have one yet.
  const sigTz = await inferTzFromLatestMessage(contact.email);
  if (sigTz) {
    await setContactTz(contact.id, sigTz, "signature");
    return {
      ...contact,
      tz: contact.tz_source === "manual" ? contact.tz : sigTz,
      tz_source: contact.tz_source === "manual" ? contact.tz_source : "signature",
      tz_inferred_at: Math.floor(Date.now() / 1000),
    };
  }

  // Step 2: domain TLD fallback. Cheap, no R2 reads.
  const domTz = inferTzFromDomain(contact.email);
  if (domTz) {
    await setContactTz(contact.id, domTz, "domain");
    return {
      ...contact,
      tz: contact.tz ?? domTz,
      tz_source: contact.tz_source ?? "domain",
      tz_inferred_at: Math.floor(Date.now() / 1000),
    };
  }

  // Nothing matched. Stamp tz_inferred_at anyway so we don't keep retrying
  // every render — the user can still set a manual override.
  await getDb()
    .prepare(`UPDATE contacts SET tz_inferred_at = ? WHERE id = ?`)
    .bind(Math.floor(Date.now() / 1000), contact.id)
    .run();
  return { ...contact, tz_inferred_at: Math.floor(Date.now() / 1000) };
}

// Pull the most recent inbound message body for `email`, extract the
// signature trailer, and run the tz heuristic against it. Returns the IANA
// zone or null. Cap the scan at one message; signatures are stable
// per-sender so revisiting older messages doesn't add information.
//
// If the extractor finds nothing (no `-- ` delimiter, no recognisable
// bottom block) we still fall back to scanning the raw body — the legacy
// behaviour from #88. This keeps recall up for messages whose senders
// don't use a structured trailer; the extracted-sig path just gives us
// cleaner input when it works.
async function inferTzFromLatestMessage(email: string): Promise<string | null> {
  const addr = email.trim().toLowerCase();
  if (!addr || !addr.includes("@")) return null;
  const dbs = await getActiveMailDbs();
  if (dbs.length === 0) return null;
  // Take the newest message from any DB (we don't know which one the
  // contact lives on; the cap is per-DB and we keep the freshest overall).
  let best: { date: number; text: string } | null = null;
  for (const { db } of dbs) {
    try {
      const row = await db
        .prepare(
          `SELECT date, COALESCE(text_body, snippet, '') AS body
             FROM messages
            WHERE direction = 'inbound' AND lower(from_addr) = ?
            ORDER BY date DESC
            LIMIT 1`,
        )
        .bind(addr)
        .first<{ date: number; body: string }>();
      if (row && (!best || row.date > best.date)) {
        best = { date: row.date, text: row.body || "" };
      }
    } catch {
      // skip a flaky DB; the rest still get a chance
    }
  }
  if (!best) return null;
  const sig = extractSignature(best.text);
  if (sig) {
    const fromSig = inferTzFromSignature(sig);
    if (fromSig) return fromSig;
  }
  // Extractor didn't isolate a sig (or sig didn't contain a tz token) — try
  // the raw body as a last resort. Same heuristic, noisier input.
  return inferTzFromSignature(best.text);
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
interface ContactWireRow extends Omit<ContactRow, "tags" | "stage" | "tz_source"> {
  stage: string | null;
  tags_json: string | null;
  tz_source: string | null;
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
  const { tags_json: _t, stage, tz_source, ...rest } = row;
  void _t;
  // Coerce tz_source into the ContactTzSource union or null. Anything that
  // isn't one of the three known sources is treated as null so callers
  // can rely on the discriminated union.
  const normalizedSource: ContactTzSource | null =
    tz_source === "manual" || tz_source === "signature" || tz_source === "domain"
      ? tz_source
      : null;
  return {
    ...rest,
    stage: CONTACT_STAGES.includes(stage as ContactStage) ? (stage as ContactStage) : null,
    tags,
    tz_source: normalizedSource,
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
