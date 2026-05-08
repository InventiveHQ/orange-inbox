import { getDb } from "./db";
import { findIdentity } from "./identities";

// Drafts are owned by the user — every helper takes userId and scopes the
// query to it. mailbox_id on the draft is the From address; we still verify
// the user can send from that mailbox before we let them save (otherwise a
// draft would be a path to "send from" any mailbox just by editing it later).

export interface DraftRow {
  id: string;
  user_id: string;
  mailbox_id: string;
  to_json: string | null;
  cc_json: string | null;
  bcc_json: string | null;
  subject: string | null;
  body: string | null;
  reply_to_message_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface DraftListItem {
  id: string;
  mailbox_id: string;
  domain_name: string;
  local_part: string;
  to_json: string | null;
  cc_json: string | null;
  subject: string | null;
  body: string | null;
  snippet: string | null;
  updated_at: number;
}

export interface DraftPayload {
  mailbox_id: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  reply_to_message_id?: string | null;
}

export async function listDraftsForUser(userId: string): Promise<DraftListItem[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT d.id, d.mailbox_id, dom.name AS domain_name, mb.local_part,
              d.to_json, d.cc_json, d.subject, d.body,
              SUBSTR(COALESCE(d.body, ''), 1, 200) AS snippet,
              d.updated_at
         FROM drafts d
         INNER JOIN mailboxes mb ON mb.id = d.mailbox_id
         INNER JOIN domains dom ON dom.id = mb.domain_id
        WHERE d.user_id = ?
        ORDER BY d.updated_at DESC`,
    )
    .bind(userId)
    .all<DraftListItem>();
  return results ?? [];
}

export async function getDraft(userId: string, draftId: string): Promise<DraftRow | null> {
  const row = await getDb()
    .prepare("SELECT * FROM drafts WHERE id = ? AND user_id = ?")
    .bind(draftId, userId)
    .first<DraftRow>();
  return row ?? null;
}

export async function createDraft(userId: string, p: DraftPayload): Promise<string> {
  await assertCanSendFrom(userId, p.mailbox_id);
  const id = crypto.randomUUID();
  await getDb()
    .prepare(
      `INSERT INTO drafts
         (id, user_id, mailbox_id, to_json, cc_json, bcc_json, subject, body, reply_to_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      userId,
      p.mailbox_id,
      JSON.stringify(p.to),
      p.cc?.length ? JSON.stringify(p.cc) : null,
      p.bcc?.length ? JSON.stringify(p.bcc) : null,
      p.subject || null,
      p.body || null,
      p.reply_to_message_id ?? null,
    )
    .run();
  return id;
}

export async function updateDraft(
  userId: string,
  draftId: string,
  p: DraftPayload,
): Promise<boolean> {
  await assertCanSendFrom(userId, p.mailbox_id);
  const res = await getDb()
    .prepare(
      `UPDATE drafts
          SET mailbox_id = ?, to_json = ?, cc_json = ?, bcc_json = ?,
              subject = ?, body = ?, reply_to_message_id = ?, updated_at = unixepoch()
        WHERE id = ? AND user_id = ?`,
    )
    .bind(
      p.mailbox_id,
      JSON.stringify(p.to),
      p.cc?.length ? JSON.stringify(p.cc) : null,
      p.bcc?.length ? JSON.stringify(p.bcc) : null,
      p.subject || null,
      p.body || null,
      p.reply_to_message_id ?? null,
      draftId,
      userId,
    )
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function deleteDraft(userId: string, draftId: string): Promise<boolean> {
  const res = await getDb()
    .prepare("DELETE FROM drafts WHERE id = ? AND user_id = ?")
    .bind(draftId, userId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

async function assertCanSendFrom(userId: string, mailboxId: string): Promise<void> {
  const identity = await findIdentity(userId, mailboxId);
  if (!identity) throw new DraftError("not_authorised", "You can't use that mailbox.");
  if (identity.role === "reader") {
    throw new DraftError("forbidden", "Your role on this mailbox is read-only.");
  }
}

export class DraftError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
