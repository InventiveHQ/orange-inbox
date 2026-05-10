import { getDb } from "./db";

// Filter rules — declarative "if message matches → do these things" automations
// the user wires up in Settings. Stored in the control DB (`rules` table,
// migration 0016). Evaluated by email-worker on inbound mail; this module owns
// the wire shape, validation, and CRUD only.
//
// Conditions and actions are JSON blobs in the DB but parsed/normalised
// through these types whenever they cross the API. Keep new condition/action
// kinds additive — old rule rows must keep round-tripping after a schema bump.

export type RuleConditionField = "from" | "subject" | "to";
export type RuleConditionOp = "contains" | "equals";

export type RuleCondition =
  | { field: "from"; op: "contains" | "equals"; value: string }
  | { field: "subject"; op: "contains"; value: string }
  | { field: "to"; op: "contains"; value: string }
  | { field: "has_attachment"; value: boolean };

export type RuleAction =
  | { type: "apply_label"; label_id: string }
  | { type: "archive" }
  | { type: "mark_as_read" }
  | { type: "delete" };

export interface RuleRow {
  id: string;
  user_id: string;
  mailbox_id: string | null;
  name: string;
  conditions: RuleCondition[];
  actions: RuleAction[];
  enabled: boolean;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface RuleInput {
  name: string;
  mailbox_id?: string | null;
  conditions: RuleCondition[];
  actions: RuleAction[];
  enabled?: boolean;
  sort_order?: number;
}

interface RawRuleRow {
  id: string;
  user_id: string;
  mailbox_id: string | null;
  name: string;
  conditions_json: string;
  actions_json: string;
  enabled: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

const MAX_NAME = 120;
const MAX_VALUE = 500;
const MAX_CONDITIONS = 8;
const MAX_ACTIONS = 8;

export class RuleError extends Error {
  constructor(
    public code: "invalid" | "forbidden" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

export async function listRulesForUser(userId: string): Promise<RuleRow[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT id, user_id, mailbox_id, name, conditions_json, actions_json,
              enabled, sort_order, created_at, updated_at
         FROM rules
        WHERE user_id = ?
        ORDER BY sort_order, created_at`,
    )
    .bind(userId)
    .all<RawRuleRow>();
  return (results ?? []).map(rowToRule);
}

export async function createRule(userId: string, input: RuleInput): Promise<RuleRow> {
  const normalised = await validateInput(userId, input);

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await getDb()
    .prepare(
      `INSERT INTO rules
         (id, user_id, mailbox_id, name, conditions_json, actions_json,
          enabled, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      userId,
      normalised.mailbox_id,
      normalised.name,
      JSON.stringify(normalised.conditions),
      JSON.stringify(normalised.actions),
      normalised.enabled ? 1 : 0,
      normalised.sort_order,
      now,
      now,
    )
    .run();

  return {
    id,
    user_id: userId,
    mailbox_id: normalised.mailbox_id,
    name: normalised.name,
    conditions: normalised.conditions,
    actions: normalised.actions,
    enabled: normalised.enabled,
    sort_order: normalised.sort_order,
    created_at: now,
    updated_at: now,
  };
}

export async function updateRule(
  userId: string,
  ruleId: string,
  patch: Partial<RuleInput>,
): Promise<RuleRow> {
  const existing = await loadOwnedRule(userId, ruleId);

  // Merge into existing values, then re-validate the whole shape so we
  // can't slip an invalid condition past via a partial update.
  const merged: RuleInput = {
    name: patch.name ?? existing.name,
    mailbox_id: patch.mailbox_id !== undefined ? patch.mailbox_id : existing.mailbox_id,
    conditions: patch.conditions ?? existing.conditions,
    actions: patch.actions ?? existing.actions,
    enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
    sort_order: patch.sort_order !== undefined ? patch.sort_order : existing.sort_order,
  };
  const normalised = await validateInput(userId, merged);

  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .prepare(
      `UPDATE rules
          SET mailbox_id = ?, name = ?, conditions_json = ?, actions_json = ?,
              enabled = ?, sort_order = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`,
    )
    .bind(
      normalised.mailbox_id,
      normalised.name,
      JSON.stringify(normalised.conditions),
      JSON.stringify(normalised.actions),
      normalised.enabled ? 1 : 0,
      normalised.sort_order,
      now,
      ruleId,
      userId,
    )
    .run();

  return {
    ...existing,
    mailbox_id: normalised.mailbox_id,
    name: normalised.name,
    conditions: normalised.conditions,
    actions: normalised.actions,
    enabled: normalised.enabled,
    sort_order: normalised.sort_order,
    updated_at: now,
  };
}

export async function deleteRule(userId: string, ruleId: string): Promise<void> {
  // Check ownership first so we can return a precise error code.
  await loadOwnedRule(userId, ruleId);
  await getDb()
    .prepare("DELETE FROM rules WHERE id = ? AND user_id = ?")
    .bind(ruleId, userId)
    .run();
}

async function loadOwnedRule(userId: string, ruleId: string): Promise<RuleRow> {
  const row = await getDb()
    .prepare(
      `SELECT id, user_id, mailbox_id, name, conditions_json, actions_json,
              enabled, sort_order, created_at, updated_at
         FROM rules
        WHERE id = ? AND user_id = ?`,
    )
    .bind(ruleId, userId)
    .first<RawRuleRow>();
  if (!row) throw new RuleError("not_found", "Rule not found.");
  return rowToRule(row);
}

interface NormalisedInput {
  name: string;
  mailbox_id: string | null;
  conditions: RuleCondition[];
  actions: RuleAction[];
  enabled: boolean;
  sort_order: number;
}

async function validateInput(userId: string, input: RuleInput): Promise<NormalisedInput> {
  const name = input.name?.trim();
  if (!name) throw new RuleError("invalid", "Name is required.");
  if (name.length > MAX_NAME) throw new RuleError("invalid", "Name is too long.");

  const conditions = normaliseConditions(input.conditions);
  if (conditions.length === 0) {
    throw new RuleError("invalid", "At least one condition is required.");
  }
  if (conditions.length > MAX_CONDITIONS) {
    throw new RuleError("invalid", "Too many conditions.");
  }

  const actions = normaliseActions(input.actions);
  if (actions.length === 0) {
    throw new RuleError("invalid", "At least one action is required.");
  }
  if (actions.length > MAX_ACTIONS) {
    throw new RuleError("invalid", "Too many actions.");
  }

  // Mailbox scope: null = applies anywhere; otherwise must be a mailbox the
  // user has any access role on. Using uma rather than ownership so a member/
  // reader can wire up rules on a shared inbox.
  let mailboxId: string | null = null;
  if (input.mailbox_id != null && input.mailbox_id !== "") {
    const ok = await getDb()
      .prepare(
        `SELECT 1 FROM user_mailbox_access
          WHERE user_id = ? AND mailbox_id = ? LIMIT 1`,
      )
      .bind(userId, input.mailbox_id)
      .first();
    if (!ok) throw new RuleError("forbidden", "No access to that mailbox.");
    mailboxId = input.mailbox_id;
  }

  // apply_label actions must reference a label the user can see.
  const labelIds = actions
    .filter((a): a is Extract<RuleAction, { type: "apply_label" }> => a.type === "apply_label")
    .map(a => a.label_id);
  if (labelIds.length > 0) {
    const placeholders = labelIds.map(() => "?").join(",");
    const { results } = await getDb()
      .prepare(
        `SELECT l.id
           FROM labels l
           LEFT JOIN user_mailbox_access uma
             ON uma.mailbox_id = l.mailbox_id AND uma.user_id = ?
          WHERE l.id IN (${placeholders})
            AND (l.mailbox_id IS NULL OR uma.user_id IS NOT NULL)`,
      )
      .bind(userId, ...labelIds)
      .all<{ id: string }>();
    const visible = new Set((results ?? []).map(r => r.id));
    for (const id of labelIds) {
      if (!visible.has(id)) {
        throw new RuleError("invalid", "Unknown label in apply_label action.");
      }
    }
  }

  return {
    name,
    mailbox_id: mailboxId,
    conditions,
    actions,
    enabled: input.enabled ?? true,
    sort_order: Number.isFinite(input.sort_order) ? Number(input.sort_order) : 0,
  };
}

function normaliseConditions(raw: unknown): RuleCondition[] {
  if (!Array.isArray(raw)) {
    throw new RuleError("invalid", "Conditions must be an array.");
  }
  const out: RuleCondition[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") {
      throw new RuleError("invalid", "Bad condition shape.");
    }
    const obj = c as Record<string, unknown>;
    const field = obj.field;
    if (field === "from") {
      const op = obj.op === "equals" ? "equals" : "contains";
      const value = stringValue(obj.value, "from");
      out.push({ field: "from", op, value });
    } else if (field === "subject") {
      out.push({ field: "subject", op: "contains", value: stringValue(obj.value, "subject") });
    } else if (field === "to") {
      out.push({ field: "to", op: "contains", value: stringValue(obj.value, "to") });
    } else if (field === "has_attachment") {
      out.push({ field: "has_attachment", value: !!obj.value });
    } else {
      throw new RuleError("invalid", `Unknown condition field: ${String(field)}`);
    }
  }
  return out;
}

function stringValue(v: unknown, field: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new RuleError("invalid", `${field} value is required.`);
  if (s.length > MAX_VALUE) {
    throw new RuleError("invalid", `${field} value is too long.`);
  }
  return s.toLowerCase();
}

function normaliseActions(raw: unknown): RuleAction[] {
  if (!Array.isArray(raw)) {
    throw new RuleError("invalid", "Actions must be an array.");
  }
  const out: RuleAction[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") {
      throw new RuleError("invalid", "Bad action shape.");
    }
    const obj = a as Record<string, unknown>;
    const type = obj.type;
    if (type === "apply_label") {
      const labelId = typeof obj.label_id === "string" ? obj.label_id : "";
      if (!labelId) throw new RuleError("invalid", "apply_label needs label_id.");
      out.push({ type: "apply_label", label_id: labelId });
    } else if (type === "archive" || type === "mark_as_read" || type === "delete") {
      out.push({ type });
    } else {
      throw new RuleError("invalid", `Unknown action type: ${String(type)}`);
    }
  }
  return out;
}

function rowToRule(row: RawRuleRow): RuleRow {
  return {
    id: row.id,
    user_id: row.user_id,
    mailbox_id: row.mailbox_id,
    name: row.name,
    conditions: parseJsonArray<RuleCondition>(row.conditions_json),
    actions: parseJsonArray<RuleAction>(row.actions_json),
    enabled: row.enabled === 1,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseJsonArray<T>(s: string): T[] {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
