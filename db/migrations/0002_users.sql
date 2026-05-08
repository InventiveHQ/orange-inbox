-- Adds the control-plane: users (login identity) and which mail-plane domains
-- each user can read/send from.
--
-- The host domain (e.g., orangemail.inventivehq.com) is where users sign in,
-- via Cloudflare Access. It is intentionally separate from the mail-plane
-- domains stored in `domains`, which are the addresses Email Routing handles
-- (e.g., glitchreplay.com). One sign-in, many mail domains.

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id            TEXT PRIMARY KEY,                      -- uuid
  email         TEXT NOT NULL UNIQUE,                  -- Cf-Access-Authenticated-User-Email
  display_name  TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at  INTEGER
);

-- Many-to-many between users and mail-plane domains. A user can hold a
-- different role per domain (e.g. admin on personal.com, reader on work.com).
CREATE TABLE user_domain_access (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain_id  TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('admin','member','reader')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, domain_id)
);

CREATE INDEX user_domain_access_domain ON user_domain_access(domain_id);
