-- Web Push subscriptions: one row per (user, browser/device endpoint).
-- Stores the encryption material the email-worker needs to deliver an
-- encrypted notification (RFC 8291) to a Push Service: the endpoint URL,
-- the subscriber's P-256 public key (p256dh), and the auth secret.

PRAGMA foreign_keys = ON;

CREATE TABLE push_subscriptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint      TEXT NOT NULL UNIQUE,           -- push service URL
  p256dh        TEXT NOT NULL,                  -- subscriber pubkey (base64url)
  auth_secret   TEXT NOT NULL,                  -- subscriber auth secret (base64url)
  user_agent    TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at  INTEGER
);

CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
