-- Remind me + VIP senders.
--
-- Both live in the control DB (threads_index + new vip_senders). No mail-DB /
-- bootstrap change needed. "Remind" is a thread-level flag — different from
-- snooze: snooze HIDES a thread until a time, while remind keeps the thread
-- visible and pops a "Reminder due" banner at the chosen time. VIPs are a
-- per-user list of addresses whose mail always lands in Primary, gets a star
-- decoration on the avatar, and overrides DnD on notifications.

-- Remind: column on threads_index (control DB), like pinned/muted.
ALTER TABLE threads_index ADD COLUMN remind_at INTEGER;
CREATE INDEX threads_index_remind ON threads_index(remind_at) WHERE remind_at IS NOT NULL;

-- VIPs: per-user list of addresses.
CREATE TABLE vip_senders (
  user_id TEXT NOT NULL,
  addr    TEXT NOT NULL,
  added_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, addr)
);
CREATE INDEX vip_senders_addr ON vip_senders(addr);
