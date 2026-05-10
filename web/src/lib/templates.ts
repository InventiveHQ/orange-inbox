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

// ─── Variable substitution ──────────────────────────────────────────────────
//
// Snippets v2: a small fixed vocabulary of `{{var}}` placeholders, evaluated
// client-side at insert time. We keep the set tight on purpose — anything
// more elaborate (loops/conditionals) is a footgun for non-technical users
// editing canned responses, and the rest of the app has no ergonomic story
// for "preview the rendered template" yet.
//
// Variables (case-insensitive, with both new and legacy names accepted):
//   {{first_name}}            — recipient's first name (display_name first
//                               word; falls back to local-part of the email).
//   {{last_thread_subject}}   — the subject of the thread we're replying to,
//                               with any leading "Re:" / "Fwd:" stripped.
//   {{thread_sender_name}}    — display name of the message we're replying
//                               to (falls back to first_name when unknown).
//   {{my_name}}               — sender's display name on the From identity.
//   {{today}}                 — today's date in the user's locale, long form.
//
// Legacy v1 names ({{recipient_name}}, {{recipient_email}}, {{my_email}},
// {{date}}, {{subject}}) are still substituted so existing user templates
// keep rendering unchanged.

export interface TemplateContext {
  // Primary recipient (first entry in To). May be empty for new compose.
  recipientEmail: string;
  // Display name we know for the recipient — typically pulled from contacts
  // or from a signature on a prior message. Optional.
  recipientName?: string | null;
  // Identity sending the mail.
  myName: string | null;
  myEmail: string;
  // Compose subject as currently typed.
  subject: string;
  // Reply context, when available. last_thread_subject is the *original*
  // subject (without "Re: " etc); thread_sender_name is the display name on
  // the message being replied to.
  lastThreadSubject?: string | null;
  threadSenderName?: string | null;
}

export function substituteVariables(text: string, c: TemplateContext): string {
  const recipientName = (c.recipientName ?? "").trim();
  const fallbackFirst = c.recipientEmail
    ? c.recipientEmail.split("@")[0].replace(/[._-]+/g, " ")
    : "";
  const firstName = (recipientName ? recipientName.split(/\s+/)[0] : fallbackFirst) || "";
  const today = new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const cleanedThreadSubject = (c.lastThreadSubject ?? c.subject ?? "")
    .replace(/^\s*(re|fwd?)\s*:\s*/i, "")
    .replace(/^\s*(re|fwd?)\s*:\s*/i, "")
    .trim();

  const map: Record<string, string> = {
    // v2
    first_name: firstName,
    last_thread_subject: cleanedThreadSubject,
    thread_sender_name: (c.threadSenderName ?? "").trim() || firstName,
    my_name: c.myName ?? "",
    today,
    // v1 legacy aliases — preserved so existing templates keep working.
    recipient_name: recipientName || fallbackFirst,
    recipient_email: c.recipientEmail,
    my_email: c.myEmail,
    date: today,
    subject: c.subject,
  };
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, key) => {
    const k = String(key).toLowerCase();
    return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : m;
  });
}

// The full list of variables surfaced to the UI (manage-templates help text,
// slash-menu hint, etc). Order matters — it's the order shown in any cheat
// sheet.
export const TEMPLATE_VARIABLES: { name: string; description: string }[] = [
  { name: "first_name", description: "Recipient's first name" },
  { name: "last_thread_subject", description: "Subject of the thread (no Re:)" },
  { name: "thread_sender_name", description: "Name of the person you're replying to" },
  { name: "my_name", description: "Your display name on the From identity" },
  { name: "today", description: "Today's date" },
];
