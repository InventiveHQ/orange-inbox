import { getDb } from "./db";
import type { ThreadListItem } from "./queries";
import { searchThreads } from "./search";
import { getSavedSearch } from "./saved-searches";

// Inbox layouts — saved side-by-side / stacked arrangements where each pane
// is driven by a search query (either a saved-searches row reference or an
// inline raw query). Each user can have multiple layouts; one may be marked
// default (enforced by a partial unique index in the schema).
//
// Per-user rows. ON DELETE CASCADE in the schema cleans up when a user is
// removed; every helper below also gates on user_id so one user can never
// read or write another user's layouts.
//
// The pane list is stored as a single JSON column. We parse on read and
// stringify on write — callers see/return a typed shape.

export interface InboxLayoutPane {
  // Either a saved_search_id or a raw query (or both — saved_search_id wins
  // at render time, query is the fallback so a layout still works if its
  // saved-search row gets deleted). At least one must be present.
  saved_search_id?: string;
  query?: string;
  // Column header shown above the pane. Mandatory so the user can tell the
  // panes apart at a glance even if the underlying queries are similar.
  label: string;
}

export interface InboxLayoutRow {
  id: string;
  user_id: string;
  name: string;
  panes: InboxLayoutPane[];
  is_default: boolean;
  created_at: number;
}

export interface InboxLayoutPatch {
  name?: string;
  panes?: InboxLayoutPane[];
  is_default?: boolean;
}

interface InboxLayoutDbRow {
  id: string;
  user_id: string;
  name: string;
  config: string;
  is_default: number;
  created_at: number;
}

const MAX_NAME = 120;
const MAX_LABEL = 80;
const MAX_QUERY = 500;
const MAX_PANES = 8;
const MIN_PANES = 1;

export class InboxLayoutError extends Error {
  constructor(
    public code: "invalid" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

function parseConfig(raw: string): InboxLayoutPane[] {
  // Stored config is whatever we wrote via stringifyConfig — but be defensive
  // in case a row was hand-edited or a future schema change reshapes it.
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: InboxLayoutPane[] = [];
    for (const p of parsed) {
      if (!p || typeof p !== "object") continue;
      const obj = p as Record<string, unknown>;
      const label = typeof obj.label === "string" ? obj.label : "";
      if (!label) continue;
      const pane: InboxLayoutPane = { label };
      if (typeof obj.saved_search_id === "string" && obj.saved_search_id) {
        pane.saved_search_id = obj.saved_search_id;
      }
      if (typeof obj.query === "string" && obj.query) {
        pane.query = obj.query;
      }
      // Drop panes that have neither — same rule as the create/update path.
      if (!pane.saved_search_id && !pane.query) continue;
      out.push(pane);
    }
    return out;
  } catch {
    return [];
  }
}

function rowToLayout(row: InboxLayoutDbRow): InboxLayoutRow {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    panes: parseConfig(row.config),
    is_default: row.is_default !== 0,
    created_at: row.created_at,
  };
}

// Validate + normalise a list of panes from the API. Returns a fresh array
// (so callers can't mutate caller-state by accident) and throws on anything
// the schema can't represent.
function validatePanes(input: unknown): InboxLayoutPane[] {
  if (!Array.isArray(input)) {
    throw new InboxLayoutError("invalid", "panes must be an array.");
  }
  if (input.length < MIN_PANES) {
    throw new InboxLayoutError("invalid", "A layout needs at least one pane.");
  }
  if (input.length > MAX_PANES) {
    throw new InboxLayoutError("invalid", `A layout can hold at most ${MAX_PANES} panes.`);
  }
  const out: InboxLayoutPane[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") {
      throw new InboxLayoutError("invalid", "Each pane must be an object.");
    }
    const obj = raw as Record<string, unknown>;
    const label = typeof obj.label === "string" ? obj.label.trim() : "";
    if (!label) throw new InboxLayoutError("invalid", "Each pane needs a label.");
    if (label.length > MAX_LABEL) {
      throw new InboxLayoutError("invalid", "Pane label is too long.");
    }
    const savedSearchId =
      typeof obj.saved_search_id === "string" ? obj.saved_search_id.trim() : "";
    const query = typeof obj.query === "string" ? obj.query.trim() : "";
    if (!savedSearchId && !query) {
      throw new InboxLayoutError(
        "invalid",
        "Each pane must reference a saved search or include a query.",
      );
    }
    if (query.length > MAX_QUERY) {
      throw new InboxLayoutError("invalid", "Pane query is too long.");
    }
    const pane: InboxLayoutPane = { label };
    if (savedSearchId) pane.saved_search_id = savedSearchId;
    if (query) pane.query = query;
    out.push(pane);
  }
  return out;
}

export async function listInboxLayouts(userId: string): Promise<InboxLayoutRow[]> {
  // Default-first ordering matches the index — handy for the sidebar where
  // the default layout should be the obvious top entry.
  const { results } = await getDb()
    .prepare(
      `SELECT id, user_id, name, config, is_default, created_at
         FROM inbox_layouts
        WHERE user_id = ?
        ORDER BY is_default DESC, name`,
    )
    .bind(userId)
    .all<InboxLayoutDbRow>();
  return (results ?? []).map(rowToLayout);
}

export async function getInboxLayout(
  id: string,
  userId: string,
): Promise<InboxLayoutRow | null> {
  const row = await getDb()
    .prepare(
      `SELECT id, user_id, name, config, is_default, created_at
         FROM inbox_layouts
        WHERE id = ? AND user_id = ?`,
    )
    .bind(id, userId)
    .first<InboxLayoutDbRow>();
  return row ? rowToLayout(row) : null;
}

export async function getDefaultInboxLayout(
  userId: string,
): Promise<InboxLayoutRow | null> {
  const row = await getDb()
    .prepare(
      `SELECT id, user_id, name, config, is_default, created_at
         FROM inbox_layouts
        WHERE user_id = ? AND is_default = 1
        LIMIT 1`,
    )
    .bind(userId)
    .first<InboxLayoutDbRow>();
  return row ? rowToLayout(row) : null;
}

export async function createInboxLayout(
  userId: string,
  name: string,
  panes: unknown,
  isDefault = false,
): Promise<InboxLayoutRow> {
  const cleanName = (name ?? "").trim();
  if (!cleanName) throw new InboxLayoutError("invalid", "Name is required.");
  if (cleanName.length > MAX_NAME) {
    throw new InboxLayoutError("invalid", "Name is too long.");
  }
  const cleanPanes = validatePanes(panes);

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const config = JSON.stringify(cleanPanes);

  // If the caller asked for default, clear any existing default first — the
  // partial unique index means we can't have two default rows in flight at
  // once, and D1 has no transactions across statements that would let us flip
  // both atomically. The clear-then-insert sequence is safe because we only
  // ever raise the new row to default after demoting whatever was there.
  if (isDefault) {
    await getDb()
      .prepare(
        "UPDATE inbox_layouts SET is_default = 0 WHERE user_id = ? AND is_default = 1",
      )
      .bind(userId)
      .run();
  }

  await getDb()
    .prepare(
      `INSERT INTO inbox_layouts (id, user_id, name, config, is_default, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, userId, cleanName, config, isDefault ? 1 : 0, now)
    .run();

  return {
    id,
    user_id: userId,
    name: cleanName,
    panes: cleanPanes,
    is_default: isDefault,
    created_at: now,
  };
}

export async function updateInboxLayout(
  id: string,
  userId: string,
  patch: InboxLayoutPatch,
): Promise<InboxLayoutRow> {
  const existing = await getInboxLayout(id, userId);
  if (!existing) throw new InboxLayoutError("not_found", "Layout not found.");

  const next: InboxLayoutRow = { ...existing, panes: [...existing.panes] };

  if (patch.name !== undefined) {
    const cleanName = patch.name.trim();
    if (!cleanName) throw new InboxLayoutError("invalid", "Name is required.");
    if (cleanName.length > MAX_NAME) {
      throw new InboxLayoutError("invalid", "Name is too long.");
    }
    next.name = cleanName;
  }

  if (patch.panes !== undefined) {
    next.panes = validatePanes(patch.panes);
  }

  if (patch.is_default !== undefined) {
    next.is_default = Boolean(patch.is_default);
  }

  // Default-flag flip needs the same demote-first dance as createInboxLayout.
  // Skip it when we're clearing the flag (going to false) since that can never
  // collide with the partial unique index.
  if (patch.is_default !== undefined && next.is_default && !existing.is_default) {
    await getDb()
      .prepare(
        "UPDATE inbox_layouts SET is_default = 0 WHERE user_id = ? AND is_default = 1",
      )
      .bind(userId)
      .run();
  }

  await getDb()
    .prepare(
      `UPDATE inbox_layouts
          SET name = ?, config = ?, is_default = ?
        WHERE id = ? AND user_id = ?`,
    )
    .bind(
      next.name,
      JSON.stringify(next.panes),
      next.is_default ? 1 : 0,
      id,
      userId,
    )
    .run();

  return next;
}

export async function deleteInboxLayout(id: string, userId: string): Promise<void> {
  const existing = await getInboxLayout(id, userId);
  if (!existing) throw new InboxLayoutError("not_found", "Layout not found.");
  await getDb()
    .prepare("DELETE FROM inbox_layouts WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
}

// Promote a specific layout to default (and demote any other). Convenience
// helper for the "Set as default" toggle in the sidebar / settings UI.
export async function setDefaultInboxLayout(
  userId: string,
  layoutId: string,
): Promise<InboxLayoutRow> {
  const existing = await getInboxLayout(layoutId, userId);
  if (!existing) throw new InboxLayoutError("not_found", "Layout not found.");
  if (existing.is_default) return existing;

  await getDb()
    .prepare(
      "UPDATE inbox_layouts SET is_default = 0 WHERE user_id = ? AND is_default = 1",
    )
    .bind(userId)
    .run();
  await getDb()
    .prepare("UPDATE inbox_layouts SET is_default = 1 WHERE id = ? AND user_id = ?")
    .bind(layoutId, userId)
    .run();

  return { ...existing, is_default: true };
}

// Resolve a single pane to a list of ThreadListItem rows ready for rendering
// in a <ThreadList>. The pane's saved_search_id (if any) wins over its
// inline `query` so a layout still has a single source of truth when the user
// edits the underlying saved search; the inline query is the fallback for
// when the saved search no longer exists or was never saved in the first
// place.
//
// Implementation: we run searchThreads (the same pipeline the search bar uses)
// to get the matching thread IDs in date-desc order, then pull full
// ThreadListItem rows from threads_index in that order. This keeps the layout
// view consistent with what /search shows for the same query — operators,
// FTS5 matching, and visibility checks behave identically.
export async function loadPaneThreads(
  userId: string,
  pane: InboxLayoutPane,
  opts: { limit?: number } = {},
): Promise<{ query: string; threads: ThreadListItem[] }> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);

  // Resolve the effective query string: saved_search row first, raw query
  // second. If both are missing the pane is malformed (validatePanes should
  // have rejected it) — bail with empty results rather than throwing so a bad
  // row doesn't tank the whole layout render.
  let query = "";
  if (pane.saved_search_id) {
    const saved = await getSavedSearch(pane.saved_search_id, userId);
    if (saved) query = saved.query;
    else if (pane.query) query = pane.query;
  } else if (pane.query) {
    query = pane.query;
  }
  if (!query.trim()) return { query, threads: [] };

  const results = await searchThreads(userId, query, { limit });
  if (results.length === 0) return { query, threads: [] };

  // Search results are already de-duped per thread and sorted by message_date
  // desc — preserve that ordering when we hydrate to ThreadListItem.
  const threadIds = results.map(r => r.thread_id);
  const placeholders = threadIds.map(() => "?").join(",");
  const sql = `
    SELECT
      ti.thread_id AS id,
      ti.subject_normalized,
      ti.last_message_at,
      ti.message_count,
      ti.unread_count,
      ti.starred,
      ti.archived,
      ti.muted,
      ti.pinned,
      ti.follow_up_enabled,
      ti.follow_up_days,
      ti.follow_up_minutes,
      d.id   AS domain_id,
      d.name AS domain_name,
      mb.id  AS mailbox_id,
      mb.local_part AS mailbox_local_part,
      ti.last_subject   AS last_subject,
      ti.last_from_addr AS last_from_addr,
      ti.last_from_name AS last_from_name,
      ti.last_snippet   AS last_snippet,
      (
        SELECT JSON_GROUP_ARRAY(
                 JSON_OBJECT('id', l.id, 'name', l.name, 'color', l.color)
               )
          FROM (
            SELECT l.id, l.name, l.color
              FROM thread_labels tl
              INNER JOIN labels l ON l.id = tl.label_id
             WHERE tl.thread_id = ti.thread_id
             ORDER BY l.name
          ) AS l
      ) AS labels_json
    FROM threads_index ti
    INNER JOIN mailboxes mb ON mb.id = ti.mailbox_id
    INNER JOIN domains d   ON d.id = mb.domain_id
    INNER JOIN user_mailbox_access uma ON uma.mailbox_id = ti.mailbox_id
    WHERE uma.user_id = ?
      AND ti.thread_id IN (${placeholders})
  `;
  interface PaneRow {
    id: string;
    subject_normalized: string;
    last_message_at: number;
    message_count: number;
    unread_count: number;
    starred: number;
    archived: number;
    muted: number;
    pinned: number;
    follow_up_enabled: number;
    follow_up_days: number | null;
    follow_up_minutes: number | null;
    domain_id: string;
    domain_name: string;
    mailbox_id: string;
    mailbox_local_part: string;
    last_subject: string | null;
    last_from_addr: string | null;
    last_from_name: string | null;
    last_snippet: string | null;
    labels_json: string | null;
  }
  const { results: rows } = await getDb()
    .prepare(sql)
    .bind(userId, ...threadIds)
    .all<PaneRow>();

  // Re-sort to match the search-result order (the IN clause doesn't preserve
  // it). Threads not in `rows` (e.g. archived after the search but before this
  // hydrate) silently fall out — same trade-off as listThreads.
  const byId = new Map(rows?.map(r => [r.id, r]) ?? []);
  const threads: ThreadListItem[] = [];
  for (const id of threadIds) {
    const row = byId.get(id);
    if (!row) continue;
    let labels: ThreadListItem["labels"] = [];
    if (row.labels_json) {
      try {
        const parsed = JSON.parse(row.labels_json) as ThreadListItem["labels"];
        if (Array.isArray(parsed)) labels = parsed;
      } catch {
        labels = [];
      }
    }
    const { labels_json: _unused, ...rest } = row;
    void _unused;
    threads.push({ ...rest, labels });
  }
  return { query, threads };
}

