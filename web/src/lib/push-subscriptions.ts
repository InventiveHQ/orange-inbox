import { getDb } from "./db";

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth_secret: string;
}

export async function insertSubscription(args: {
  userId: string;
  endpoint: string;
  p256dh: string;
  authSecret: string;
  userAgent: string | null;
}): Promise<void> {
  // Re-subscribing the same endpoint just refreshes ownership and keys.
  // (Push services rotate auth_secret in some flows; keep the latest.)
  await getDb()
    .prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth_secret, user_agent)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id,
         p256dh = excluded.p256dh,
         auth_secret = excluded.auth_secret,
         user_agent = excluded.user_agent,
         last_used_at = unixepoch()`,
    )
    .bind(args.userId, args.endpoint, args.p256dh, args.authSecret, args.userAgent)
    .run();
}

export async function deleteSubscriptionByEndpoint(
  userId: string,
  endpoint: string,
): Promise<void> {
  await getDb()
    .prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?")
    .bind(userId, endpoint)
    .run();
}

// Used by the email-worker fan-out path. Joins via user_mailbox_access so
// every device of every user with any role on the mailbox gets pushed.
export async function listSubscriptionsForMailbox(
  mailboxId: string,
): Promise<PushSubscriptionRow[]> {
  const { results } = await getDb()
    .prepare(
      `SELECT ps.endpoint, ps.p256dh, ps.auth_secret
         FROM push_subscriptions ps
         INNER JOIN user_mailbox_access uma ON uma.user_id = ps.user_id
        WHERE uma.mailbox_id = ?`,
    )
    .bind(mailboxId)
    .all<PushSubscriptionRow>();
  return results ?? [];
}

// Push services return 404/410 when the user-agent has discarded the
// subscription. Drop the row so we stop trying.
export async function pruneSubscription(endpoint: string): Promise<void> {
  await getDb()
    .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
    .bind(endpoint)
    .run();
}

export async function markSubscriptionUsed(endpoint: string): Promise<void> {
  await getDb()
    .prepare("UPDATE push_subscriptions SET last_used_at = unixepoch() WHERE endpoint = ?")
    .bind(endpoint)
    .run();
}
