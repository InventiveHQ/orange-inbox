import { getDb } from "./db";

// Saved searches — a.k.a. Smart Mailboxes. Each row is a named pointer to a
// raw search query string (operator-aware: `from:`, `is:unread`,
// `has:attachment`, `before:`, `after:`, `mailbox:` …). Clicking the entry in
// the sidebar re-runs the query against the live FTS5 index, so this table
// never holds a result set — only the inputs to /search.
//
// Per-user rows. ON DELETE CASCADE in the schema cleans up when a user is
// removed; every helper below also gates on user_id so one user can never
// read or write another user's saved searches.

export interface SavedSearchRow {
  id: string;
  user_id: string;
  name: string;
  query: string;
  sort_order: number;
  created_at: number;
}

export interface SavedSearchPatch {
  name?: string;
  query?: string;
  sort_order?: number;
}

const MAX_NAME = 120;
const MAX_QUERY = 500;

export class SavedSearchError extends Error {
  constructor(
    public code: "invalid" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

export async function listSavedSearches(userId: string): Promise<SavedSearchRow[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT id, user_id, name, query, sort_order, created_at
         FROM saved_searches
        WHERE user_id = ?
        ORDER BY sort_order, name`,
    )
    .bind(userId)
    .all<SavedSearchRow>();
  return results ?? [];
}

export async function getSavedSearch(
  id: string,
  userId: string,
): Promise<SavedSearchRow | null> {
  const row = await getDb()
    .prepare(
      `SELECT id, user_id, name, query, sort_order, created_at
         FROM saved_searches
        WHERE id = ? AND user_id = ?`,
    )
    .bind(id, userId)
    .first<SavedSearchRow>();
  return row ?? null;
}

export async function createSavedSearch(
  userId: string,
  name: string,
  query: string,
): Promise<SavedSearchRow> {
  const cleanName = (name ?? "").trim();
  const cleanQuery = (query ?? "").trim();
  if (!cleanName) throw new SavedSearchError("invalid", "Name is required.");
  if (cleanName.length > MAX_NAME) {
    throw new SavedSearchError("invalid", "Name is too long.");
  }
  if (!cleanQuery) throw new SavedSearchError("invalid", "Query is required.");
  if (cleanQuery.length > MAX_QUERY) {
    throw new SavedSearchError("invalid", "Query is too long.");
  }

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await getDb()
    .prepare(
      `INSERT INTO saved_searches (id, user_id, name, query, sort_order, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    )
    .bind(id, userId, cleanName, cleanQuery, now)
    .run();

  return {
    id,
    user_id: userId,
    name: cleanName,
    query: cleanQuery,
    sort_order: 0,
    created_at: now,
  };
}

export async function updateSavedSearch(
  id: string,
  userId: string,
  patch: SavedSearchPatch,
): Promise<SavedSearchRow> {
  const existing = await getSavedSearch(id, userId);
  if (!existing) throw new SavedSearchError("not_found", "Saved search not found.");

  const next: SavedSearchRow = { ...existing };

  if (patch.name !== undefined) {
    const cleanName = patch.name.trim();
    if (!cleanName) throw new SavedSearchError("invalid", "Name is required.");
    if (cleanName.length > MAX_NAME) {
      throw new SavedSearchError("invalid", "Name is too long.");
    }
    next.name = cleanName;
  }
  if (patch.query !== undefined) {
    const cleanQuery = patch.query.trim();
    if (!cleanQuery) throw new SavedSearchError("invalid", "Query is required.");
    if (cleanQuery.length > MAX_QUERY) {
      throw new SavedSearchError("invalid", "Query is too long.");
    }
    next.query = cleanQuery;
  }
  if (patch.sort_order !== undefined) {
    if (!Number.isFinite(patch.sort_order)) {
      throw new SavedSearchError("invalid", "sort_order must be a number.");
    }
    next.sort_order = Math.trunc(patch.sort_order);
  }

  await getDb()
    .prepare(
      `UPDATE saved_searches
          SET name = ?, query = ?, sort_order = ?
        WHERE id = ? AND user_id = ?`,
    )
    .bind(next.name, next.query, next.sort_order, id, userId)
    .run();

  return next;
}

export async function deleteSavedSearch(id: string, userId: string): Promise<void> {
  const existing = await getSavedSearch(id, userId);
  if (!existing) throw new SavedSearchError("not_found", "Saved search not found.");
  await getDb()
    .prepare("DELETE FROM saved_searches WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .run();
}
