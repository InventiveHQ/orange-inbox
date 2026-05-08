import { getDb } from "./db";

// Canned responses ("templates") have two scopes:
//   personal — owned by a user, visible only to them across every mailbox
//   shared   — owned by a mailbox, visible to every user with access to it
// Exactly one of (user_id, mailbox_id) is set; the schema CHECK enforces it.
//
// Placeholders are evaluated client-side at insert time so the user can still
// tweak the result before sending — see ComposeProvider's applyTemplate.

export interface TemplateRow {
  id: string;
  user_id: string | null;
  mailbox_id: string | null;
  name: string;
  subject_template: string | null;
  body_template: string;
  created_at: number;
  updated_at: number;
  scope: "personal" | "shared";
  // Set when scope=shared so the UI can label "Shared on hello@…".
  domain_name: string | null;
  local_part: string | null;
}

export interface TemplateInput {
  name: string;
  subject_template?: string | null;
  body_template: string;
  scope: "personal" | "shared";
  // Required when scope=shared, ignored when scope=personal.
  mailbox_id?: string | null;
}

export async function listTemplatesForUser(userId: string): Promise<TemplateRow[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT t.id, t.user_id, t.mailbox_id, t.name,
              t.subject_template, t.body_template,
              t.created_at, t.updated_at,
              CASE WHEN t.user_id IS NOT NULL THEN 'personal' ELSE 'shared' END AS scope,
              d.name      AS domain_name,
              mb.local_part AS local_part
         FROM canned_responses t
         LEFT JOIN mailboxes mb ON mb.id = t.mailbox_id
         LEFT JOIN domains d   ON d.id  = mb.domain_id
         LEFT JOIN user_mailbox_access uma
                ON uma.mailbox_id = t.mailbox_id AND uma.user_id = ?1
        WHERE t.user_id = ?1 OR uma.user_id IS NOT NULL
        ORDER BY scope, t.name`,
    )
    .bind(userId)
    .all<TemplateRow>();
  return results ?? [];
}

export async function createTemplate(userId: string, input: TemplateInput): Promise<string> {
  const name = input.name.trim();
  const body = (input.body_template ?? "").trim();
  if (!name) throw new TemplateError("invalid", "Name is required.");
  if (!body) throw new TemplateError("invalid", "Body is required.");
  const subject = input.subject_template?.trim() || null;

  let userIdCol: string | null;
  let mailboxIdCol: string | null;
  if (input.scope === "personal") {
    userIdCol = userId;
    mailboxIdCol = null;
  } else {
    if (!input.mailbox_id) {
      throw new TemplateError("invalid", "mailbox_id required for shared templates.");
    }
    if (!await canSendFromMailbox(userId, input.mailbox_id)) {
      throw new TemplateError("forbidden", "You can't add shared templates to that mailbox.");
    }
    userIdCol = null;
    mailboxIdCol = input.mailbox_id;
  }

  const id = crypto.randomUUID();
  await getDb()
    .prepare(
      `INSERT INTO canned_responses
         (id, user_id, mailbox_id, name, subject_template, body_template)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, userIdCol, mailboxIdCol, name, subject, body)
    .run();
  return id;
}

export async function updateTemplate(
  userId: string,
  templateId: string,
  patch: { name?: string; subject_template?: string | null; body_template?: string },
): Promise<boolean> {
  if (!await canEditTemplate(userId, templateId)) return false;

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (!n) throw new TemplateError("invalid", "Name is required.");
    sets.push("name = ?");
    binds.push(n);
  }
  if (patch.subject_template !== undefined) {
    sets.push("subject_template = ?");
    binds.push(patch.subject_template?.trim() || null);
  }
  if (patch.body_template !== undefined) {
    const b = patch.body_template.trim();
    if (!b) throw new TemplateError("invalid", "Body is required.");
    sets.push("body_template = ?");
    binds.push(b);
  }
  if (sets.length === 0) return true;
  sets.push("updated_at = unixepoch()");
  binds.push(templateId);
  await getDb()
    .prepare(`UPDATE canned_responses SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return true;
}

export async function deleteTemplate(userId: string, templateId: string): Promise<boolean> {
  if (!await canEditTemplate(userId, templateId)) return false;
  await getDb().prepare("DELETE FROM canned_responses WHERE id = ?").bind(templateId).run();
  return true;
}

// Edit rights:
//   - personal templates: only the owning user
//   - shared templates: owners/members of the mailbox
async function canEditTemplate(userId: string, templateId: string): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `SELECT t.user_id, t.mailbox_id, uma.role
         FROM canned_responses t
         LEFT JOIN user_mailbox_access uma
                ON uma.mailbox_id = t.mailbox_id AND uma.user_id = ?
        WHERE t.id = ?`,
    )
    .bind(userId, templateId)
    .first<{ user_id: string | null; mailbox_id: string | null; role: string | null }>();
  if (!row) return false;
  if (row.user_id) return row.user_id === userId;
  return row.role === "owner" || row.role === "member";
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

export class TemplateError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
