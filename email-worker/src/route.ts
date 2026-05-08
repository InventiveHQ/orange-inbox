import type { Env } from "./types";

export interface Recipient {
  domainId: string;
  mailboxId: string;
}

// Resolve the envelope `to` to a (domain, mailbox). Falls back to the domain's
// catch-all mailbox if no exact local-part match exists. Returns null when the
// domain isn't registered or no catch-all is configured — caller should reject.
export async function resolveRecipient(env: Env, envelopeTo: string): Promise<Recipient | null> {
  const at = envelopeTo.lastIndexOf("@");
  if (at === -1) return null;

  const localPart = envelopeTo.slice(0, at).toLowerCase();
  const domainName = envelopeTo.slice(at + 1).toLowerCase();

  const domain = await env.DB
    .prepare("SELECT id FROM domains WHERE name = ?")
    .bind(domainName)
    .first<{ id: string }>();
  if (!domain) return null;

  const exact = await env.DB
    .prepare("SELECT id FROM mailboxes WHERE domain_id = ? AND local_part = ?")
    .bind(domain.id, localPart)
    .first<{ id: string }>();
  if (exact) return { domainId: domain.id, mailboxId: exact.id };

  const catchAll = await env.DB
    .prepare("SELECT id FROM mailboxes WHERE domain_id = ? AND is_catch_all = 1 LIMIT 1")
    .bind(domain.id)
    .first<{ id: string }>();
  if (catchAll) return { domainId: domain.id, mailboxId: catchAll.id };

  return null;
}
