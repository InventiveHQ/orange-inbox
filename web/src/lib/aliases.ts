import { getDb } from "./db";
import { getActiveMailDbs } from "./mail-db";

// Aliases are a labelling layer on top of mailboxes. The control DB stores
// every promoted alias (one row per (mailbox_id, local_part)); inbound mail
// continues to land in the parent mailbox via Cloudflare Email Routing
// catch-alls, so threading and per-mailbox role checks are unaffected.
//
// "Observed aliases" are addresses we've seen on inbound mail that hit a
// catch-all mailbox but aren't yet promoted — surfaced in the dashboard as
// candidates for one-click promotion.

export interface PromotedAlias {
  id: string;
  mailbox_id: string;
  local_part: string;
  display_name: string | null;
  signature_html: string | null;
  promoted_at: number;
  // Joined for the management UI: the parent mailbox + domain + role so we
  // can render "promoted on hello@example.com" and gate destructive actions.
  domain_id: string;
  domain_name: string;
  parent_local_part: string;
  parent_is_catch_all: number;
  role: "owner" | "member" | "reader";
}

export interface ObservedAlias {
  // Local part observed on a To: header for a catch-all mailbox.
  local_part: string;
  domain_id: string;
  domain_name: string;
  // mailbox_id of the catch-all that received the mail. Promoting needs this
  // since aliases attach to a specific mailbox row.
  mailbox_id: string;
  parent_local_part: string;
  // How many times this address has been seen on inbound mail. Coarse — we
  // sample recent messages, see the implementation comment in
  // listObservedAliases for the cap.
  hits: number;
  // Most recent unix-seconds we saw it.
  last_seen_at: number;
}

// Promoted aliases for any mailbox the user can send from. Mirrors
// listIdentities in scope: owner/member rows only. The role column is a
// straight pass-through from user_mailbox_access so the management UI can
// hide demote/edit when the user only has reader access (which shouldn't
// happen in practice — readers can't promote — but defensive).
export async function listAliases(userId: string): Promise<PromotedAlias[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT a.id, a.mailbox_id, a.local_part, a.display_name, a.signature_html,
              a.promoted_at,
              d.id AS domain_id, d.name AS domain_name,
              mb.local_part AS parent_local_part,
              mb.is_catch_all AS parent_is_catch_all,
              uma.role
         FROM mailbox_aliases a
         INNER JOIN mailboxes mb ON mb.id = a.mailbox_id
         INNER JOIN domains d ON d.id = mb.domain_id
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = a.mailbox_id
        WHERE uma.user_id = ? AND uma.role IN ('owner','member')
        ORDER BY d.name, a.local_part`,
    )
    .bind(userId)
    .all<PromotedAlias>();
  return results ?? [];
}

// Promote an inbound address into a tracked alias. The caller must have
// owner/member access on the target mailbox; we re-check here so the API
// route doesn't have to repeat the SQL.
//
// Throws AliasError("invalid") for bad inputs and AliasError("forbidden")
// when the user can't send from the parent mailbox. Duplicate promotions
// (same mailbox_id + local_part) surface as AliasError("duplicate").
export async function promoteAlias(
  userId: string,
  mailboxId: string,
  localPart: string,
  displayName: string | null,
  signatureHtml: string | null,
): Promise<string> {
  const lp = sanitizeLocalPart(localPart);
  if (!lp) throw new AliasError("invalid", "local_part is required.");

  if (!(await canManageAliasesOnMailbox(userId, mailboxId))) {
    throw new AliasError("forbidden", "You can't promote aliases on that mailbox.");
  }

  const id = crypto.randomUUID();
  try {
    await getDb()
      .prepare(
        `INSERT INTO mailbox_aliases (id, mailbox_id, local_part, display_name, signature_html)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(id, mailboxId, lp, displayName?.trim() || null, signatureHtml?.trim() || null)
      .run();
    return id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE|constraint/i.test(msg)) {
      throw new AliasError("duplicate", "That alias is already promoted.");
    }
    throw err;
  }
}

// Patch the mutable fields on a promoted alias. Returns false when the alias
// doesn't exist or the user lacks owner/member access to its parent mailbox.
export async function updateAlias(
  userId: string,
  aliasId: string,
  patch: { display_name?: string | null; signature_html?: string | null },
): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `SELECT a.mailbox_id
         FROM mailbox_aliases a
         INNER JOIN user_mailbox_access uma
                ON uma.mailbox_id = a.mailbox_id AND uma.user_id = ?
        WHERE a.id = ? AND uma.role IN ('owner','member')`,
    )
    .bind(userId, aliasId)
    .first<{ mailbox_id: string }>();
  if (!row) return false;

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.display_name !== undefined) {
    sets.push("display_name = ?");
    binds.push(patch.display_name?.trim() || null);
  }
  if (patch.signature_html !== undefined) {
    sets.push("signature_html = ?");
    binds.push(patch.signature_html?.trim() || null);
  }
  if (sets.length === 0) return true;
  binds.push(aliasId);
  await getDb()
    .prepare(`UPDATE mailbox_aliases SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return true;
}

// Demote (delete) a promoted alias. Inbound mail keeps landing in the parent
// mailbox; only the send-as label disappears.
export async function demoteAlias(userId: string, aliasId: string): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `SELECT a.id
         FROM mailbox_aliases a
         INNER JOIN user_mailbox_access uma
                ON uma.mailbox_id = a.mailbox_id AND uma.user_id = ?
        WHERE a.id = ? AND uma.role IN ('owner','member')`,
    )
    .bind(userId, aliasId)
    .first<{ id: string }>();
  if (!row) return false;
  await getDb().prepare("DELETE FROM mailbox_aliases WHERE id = ?").bind(aliasId).run();
  return true;
}

// Sample of recent To: addresses for catch-all mailboxes the user has
// owner/member access to, minus addresses already promoted and minus the
// catch-all's own local_part. The result is what the dashboard surfaces as
// "addresses you've been receiving on; click to promote".
//
// We fan out across active mail DBs (multi-DB deploys split mail across
// several D1 instances; see web/src/lib/mail-db.ts) and bound the per-DB
// scan with a LIMIT — we don't need exhaustive history, just enough recent
// observations to surface useful candidates. The aggregation is in JS so we
// don't need every DB to ship back the same join shape.
const OBSERVED_SAMPLE_PER_DB = 1000;

export async function listObservedAliases(userId: string): Promise<ObservedAlias[]> {
  // Catch-all mailboxes the user can send from. Anything else can't have
  // aliases (a non-catch-all only receives mail at its own local_part).
  const { results: catchAlls } = await getDb()
    .prepare(
      `SELECT mb.id AS mailbox_id, mb.local_part AS parent_local_part,
              d.id AS domain_id, d.name AS domain_name
         FROM mailboxes mb
         INNER JOIN domains d ON d.id = mb.domain_id
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = mb.id
        WHERE uma.user_id = ?
          AND uma.role IN ('owner','member')
          AND mb.is_catch_all = 1`,
    )
    .bind(userId)
    .all<{
      mailbox_id: string;
      parent_local_part: string;
      domain_id: string;
      domain_name: string;
    }>();
  if (!catchAlls || catchAlls.length === 0) return [];

  // Already-promoted aliases — exclude these from the observed list since
  // they're already on the "promoted" table and surfacing them as
  // candidates would be confusing.
  const { results: promotedRows } = await getDb()
    .prepare(
      `SELECT mailbox_id, local_part FROM mailbox_aliases
        WHERE mailbox_id IN (${catchAlls.map(() => "?").join(",")})`,
    )
    .bind(...catchAlls.map(c => c.mailbox_id))
    .all<{ mailbox_id: string; local_part: string }>();
  const promoted = new Set(
    (promotedRows ?? []).map(r => `${r.mailbox_id}|${r.local_part.toLowerCase()}`),
  );

  // Per-mailbox aggregation: { mailbox_id → Map<local_part_lower, {hits, last_seen_at}> }
  const acc = new Map<
    string,
    Map<string, { hits: number; last_seen_at: number }>
  >();
  for (const c of catchAlls) acc.set(c.mailbox_id, new Map());

  const mailDbs = await getActiveMailDbs();
  for (const c of catchAlls) {
    for (const { db } of mailDbs) {
      const { results } = await db
        .prepare(
          `SELECT to_json, date FROM messages
            WHERE mailbox_id = ? AND direction = 'inbound'
            ORDER BY date DESC
            LIMIT ?`,
        )
        .bind(c.mailbox_id, OBSERVED_SAMPLE_PER_DB)
        .all<{ to_json: string; date: number }>();
      const bucket = acc.get(c.mailbox_id)!;
      for (const r of results ?? []) {
        const addrs = parseAddrs(r.to_json);
        for (const a of addrs) {
          const at = a.indexOf("@");
          if (at <= 0) continue;
          const local = a.slice(0, at).toLowerCase();
          const dom = a.slice(at + 1).toLowerCase();
          if (dom !== c.domain_name.toLowerCase()) continue;
          // Skip the catch-all's own local_part — that IS the mailbox, not
          // an alias of it.
          if (local === c.parent_local_part.toLowerCase()) continue;
          if (promoted.has(`${c.mailbox_id}|${local}`)) continue;
          const cur = bucket.get(local);
          if (cur) {
            cur.hits += 1;
            if (r.date > cur.last_seen_at) cur.last_seen_at = r.date;
          } else {
            bucket.set(local, { hits: 1, last_seen_at: r.date });
          }
        }
      }
    }
  }

  // Flatten + join back to the per-mailbox metadata.
  const out: ObservedAlias[] = [];
  for (const c of catchAlls) {
    const bucket = acc.get(c.mailbox_id)!;
    for (const [local, stats] of bucket.entries()) {
      out.push({
        local_part: local,
        domain_id: c.domain_id,
        domain_name: c.domain_name,
        mailbox_id: c.mailbox_id,
        parent_local_part: c.parent_local_part,
        hits: stats.hits,
        last_seen_at: stats.last_seen_at,
      });
    }
  }
  // Most-recent first, then by hit count — the user almost always cares
  // about an address that just hit their inbox.
  out.sort((a, b) => {
    if (b.last_seen_at !== a.last_seen_at) return b.last_seen_at - a.last_seen_at;
    return b.hits - a.hits;
  });
  return out;
}

// Validate a local-part for the alias UNIQUE(mailbox_id, local_part) row.
// Cloudflare Email Routing accepts the standard RFC 5321 local-part charset;
// we apply a slightly tighter set (alnum + . + - + _ + +) to dodge the
// dot-atom edge cases that postal-mime sometimes mangles. Lowercased so
// case differences don't create duplicate rows.
function sanitizeLocalPart(input: string): string | null {
  const lp = input.trim().toLowerCase();
  if (!lp) return null;
  if (lp.length > 64) return null;
  if (!/^[a-z0-9._+-]+$/.test(lp)) return null;
  return lp;
}

async function canManageAliasesOnMailbox(userId: string, mailboxId: string): Promise<boolean> {
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

// Mail-DB messages.to_json is JSON [{addr, name}]. Defensive parse — a
// malformed value should not nuke the whole sample.
function parseAddrs(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v
      .map(x => (x && typeof x === "object" && typeof x.addr === "string" ? x.addr : null))
      .filter((x): x is string => !!x);
  } catch {
    return [];
  }
}

export class AliasError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
