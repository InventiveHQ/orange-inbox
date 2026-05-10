import { getDb } from "./db";

// An identity is something you can compose "as". Today there are two kinds:
//   - "mailbox" — the canonical address that inbound routing actually
//     delivers to. mailbox_id is its own primary key.
//   - "alias"   — a labelling layer over a mailbox (typically a catch-all):
//     you compose using a different local_part on the same domain, but
//     inbound mail still lands in the underlying mailbox. alias_id carries
//     the mailbox_aliases row; mailbox_id points at the mailbox the alias
//     was promoted from (so role/permission checks reuse the mailbox path).
//
// `kind` is the discriminator. `mailbox_id` is set on both kinds — outbound
// permission and reply-thread routing key off the mailbox the alias belongs
// to, so listing/sending code can lean on the same mailbox checks regardless
// of which kind was picked.
export interface Identity {
  // Discriminator. UI and send code branch on this for signature lookup,
  // From-line construction, and "promote/demote" UX gating.
  kind: "mailbox" | "alias";
  // Canonical id used by the composer's <select> and the send API. Equal to
  // mailbox_id for mailbox identities and "alias:<id>" for alias identities;
  // the prefix lets a single dropdown surface both kinds without colliding.
  id: string;
  // Underlying mailbox row. For aliases, this is the mailbox they were
  // promoted from — used for role enforcement and reply-thread routing.
  mailbox_id: string;
  // The mailbox_aliases.id when kind === "alias"; null otherwise.
  alias_id: string | null;
  domain_id: string;
  domain_name: string;
  local_part: string;
  display_name: string | null;
  signature_html: string | null;
  is_catch_all: number;
  role: "owner" | "member" | "reader";
}

interface MailboxIdentityRow {
  mailbox_id: string;
  domain_id: string;
  domain_name: string;
  local_part: string;
  display_name: string | null;
  signature_html: string | null;
  is_catch_all: number;
  role: "owner" | "member" | "reader";
}

interface AliasIdentityRow {
  alias_id: string;
  mailbox_id: string;
  domain_id: string;
  domain_name: string;
  local_part: string;
  display_name: string | null;
  signature_html: string | null;
  role: "owner" | "member" | "reader";
}

// Mailboxes + promoted aliases the user can SEND from — owner/member only.
// Readers are excluded because the role definition forbids outbound for them.
//
// Aliases inherit the role of their parent mailbox (no separate ACL on
// mailbox_aliases): if you can send from the mailbox, you can send as any
// alias promoted from it. Aliases without a custom signature_html fall back
// to the mailbox's signature so users don't have to copy/paste.
export async function listIdentities(userId: string): Promise<Identity[]> {
  const db = getDb();
  const [mailboxRes, aliasRes] = await Promise.all([
    db
      .prepare(
        `SELECT mb.id AS mailbox_id, d.id AS domain_id, d.name AS domain_name,
                mb.local_part, mb.display_name, mb.signature_html, mb.is_catch_all,
                uma.role
           FROM mailboxes mb
           INNER JOIN domains d ON d.id = mb.domain_id
           INNER JOIN user_mailbox_access uma ON uma.mailbox_id = mb.id
          WHERE uma.user_id = ? AND uma.role IN ('owner','member')
          ORDER BY d.name, mb.local_part`,
      )
      .bind(userId)
      .all<MailboxIdentityRow>(),
    db
      .prepare(
        `SELECT a.id AS alias_id, a.mailbox_id, d.id AS domain_id, d.name AS domain_name,
                a.local_part, a.display_name,
                COALESCE(a.signature_html, mb.signature_html) AS signature_html,
                uma.role
           FROM mailbox_aliases a
           INNER JOIN mailboxes mb ON mb.id = a.mailbox_id
           INNER JOIN domains d ON d.id = mb.domain_id
           INNER JOIN user_mailbox_access uma ON uma.mailbox_id = a.mailbox_id
          WHERE uma.user_id = ? AND uma.role IN ('owner','member')
          ORDER BY d.name, a.local_part`,
      )
      .bind(userId)
      .all<AliasIdentityRow>(),
  ]);

  const mailboxes: Identity[] = (mailboxRes.results ?? []).map(r => ({
    kind: "mailbox" as const,
    id: r.mailbox_id,
    mailbox_id: r.mailbox_id,
    alias_id: null,
    domain_id: r.domain_id,
    domain_name: r.domain_name,
    local_part: r.local_part,
    display_name: r.display_name,
    signature_html: r.signature_html,
    is_catch_all: r.is_catch_all,
    role: r.role,
  }));
  const aliases: Identity[] = (aliasRes.results ?? []).map(r => ({
    kind: "alias" as const,
    id: `alias:${r.alias_id}`,
    mailbox_id: r.mailbox_id,
    alias_id: r.alias_id,
    domain_id: r.domain_id,
    domain_name: r.domain_name,
    local_part: r.local_part,
    display_name: r.display_name,
    // Aliases without a custom signature inherit the parent mailbox's signature
    // (the SQL COALESCE above), so the composer doesn't suddenly render an
    // empty signature when you switch the From dropdown to an alias.
    signature_html: r.signature_html,
    is_catch_all: 0,
    role: r.role,
  }));

  // Sort the combined list so each domain's mailbox identities and their
  // aliases appear together — the composer dropdown is easier to scan that
  // way than a "mailboxes first, aliases second" split.
  return [...mailboxes, ...aliases].sort((a, b) => {
    if (a.domain_name !== b.domain_name) return a.domain_name.localeCompare(b.domain_name);
    if (a.local_part !== b.local_part) return a.local_part.localeCompare(b.local_part);
    // Mailbox sorts before alias when local_parts match (defensive — UNIQUE
    // (mailbox_id, local_part) on aliases prevents an alias matching its own
    // mailbox's local_part on the same mailbox, but cross-mailbox collisions
    // on a domain are still possible).
    return a.kind === "mailbox" ? -1 : 1;
  });
}

// Every mailbox in the system, exposed in the Identity shape so the admin
// management UI can re-use the components built for the per-user list. The
// role is reported as 'owner' for sort/UI convenience; no per-user join is
// performed here since admin access is global. Aliases are NOT included —
// admin management of aliases happens through the per-user listIdentities /
// /inbox/aliases page (admins have access to every mailbox anyway, so the
// per-user list reaches the same set).
export async function listAllIdentities(): Promise<Identity[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT mb.id AS mailbox_id, d.id AS domain_id, d.name AS domain_name,
              mb.local_part, mb.display_name, mb.signature_html, mb.is_catch_all,
              'owner' AS role
         FROM mailboxes mb
         INNER JOIN domains d ON d.id = mb.domain_id
        ORDER BY d.name, mb.local_part`,
    )
    .all<MailboxIdentityRow>();
  return (results ?? []).map(r => ({
    kind: "mailbox" as const,
    id: r.mailbox_id,
    mailbox_id: r.mailbox_id,
    alias_id: null,
    domain_id: r.domain_id,
    domain_name: r.domain_name,
    local_part: r.local_part,
    display_name: r.display_name,
    signature_html: r.signature_html,
    is_catch_all: r.is_catch_all,
    role: r.role,
  }));
}

// Used by the API to verify the chosen mailbox belongs to a (mailbox, role)
// the user can send from before we hand bytes to env.EMAIL.send().
export async function findIdentity(userId: string, mailboxId: string): Promise<Identity | null> {
  const row = await getDb()
    .prepare(
      `SELECT mb.id AS mailbox_id, d.id AS domain_id, d.name AS domain_name,
              mb.local_part, mb.display_name, mb.signature_html, mb.is_catch_all,
              uma.role
         FROM mailboxes mb
         INNER JOIN domains d ON d.id = mb.domain_id
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = mb.id
        WHERE mb.id = ? AND uma.user_id = ?`,
    )
    .bind(mailboxId, userId)
    .first<MailboxIdentityRow>();
  if (!row) return null;
  return {
    kind: "mailbox",
    id: row.mailbox_id,
    mailbox_id: row.mailbox_id,
    alias_id: null,
    domain_id: row.domain_id,
    domain_name: row.domain_name,
    local_part: row.local_part,
    display_name: row.display_name,
    signature_html: row.signature_html,
    is_catch_all: row.is_catch_all,
    role: row.role,
  };
}

// Look up a promoted alias and verify the user can send from its parent
// mailbox. Returned in Identity shape so send code can swap the alias's
// local_part / display_name / signature into the From line while keeping
// every downstream check (role gating, reply-thread routing) keyed on the
// underlying mailbox.
export async function findAliasIdentity(
  userId: string,
  aliasId: string,
): Promise<Identity | null> {
  const row = await getDb()
    .prepare(
      `SELECT a.id AS alias_id, a.mailbox_id, d.id AS domain_id, d.name AS domain_name,
              a.local_part, a.display_name,
              COALESCE(a.signature_html, mb.signature_html) AS signature_html,
              uma.role
         FROM mailbox_aliases a
         INNER JOIN mailboxes mb ON mb.id = a.mailbox_id
         INNER JOIN domains d ON d.id = mb.domain_id
         INNER JOIN user_mailbox_access uma ON uma.mailbox_id = a.mailbox_id
        WHERE a.id = ? AND uma.user_id = ?`,
    )
    .bind(aliasId, userId)
    .first<AliasIdentityRow>();
  if (!row) return null;
  return {
    kind: "alias",
    id: `alias:${row.alias_id}`,
    mailbox_id: row.mailbox_id,
    alias_id: row.alias_id,
    domain_id: row.domain_id,
    domain_name: row.domain_name,
    local_part: row.local_part,
    display_name: row.display_name,
    signature_html: row.signature_html,
    is_catch_all: 0,
    role: row.role,
  };
}

export function fullAddress(i: Pick<Identity, "local_part" | "domain_name">): string {
  return `${i.local_part}@${i.domain_name}`;
}
