-- Tombstone queue for R2 keys that are no longer referenced by any DB row.
--
-- D1 FK CASCADE removes child rows but cannot reach across to R2, so when a
-- thread or mailbox is hard-deleted the raw .eml, html bodies, and
-- attachment blobs become orphans. The DELETE handlers now enumerate
-- soon-to-be-orphaned R2 keys and insert tombstones in the same D1 batch
-- as the parent delete, which keeps DB and tombstone state consistent
-- across crashes.
--
-- The email-worker cron picks up the oldest tombstones each minute and
-- deletes them from R2, removing the row on success. Failures bump
-- attempts and stay queued for retry.

PRAGMA foreign_keys = ON;

CREATE TABLE r2_tombstones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket      TEXT NOT NULL CHECK (bucket IN ('RAW_MAIL', 'ATTACHMENTS')),
  r2_key      TEXT NOT NULL,
  queued_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);

-- The sweep query picks the oldest few — the index makes that LIMIT cheap
-- even if a backlog accumulates after an outage.
CREATE INDEX r2_tombstones_oldest ON r2_tombstones(queued_at);
