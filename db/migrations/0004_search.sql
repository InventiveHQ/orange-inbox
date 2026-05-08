-- Full-text search across all messages, used by /search and the global search bar.
--
-- We use SQLite's FTS5 with `content=messages` so the FTS index is "external
-- content": the index stores postings only, not duplicate copies of subject /
-- snippet / text_body. The price is that we have to keep the index in sync
-- with the messages table by hand via triggers, which is what the rest of
-- this migration does.
--
-- rowid plumbing:
--   `messages.id` is a TEXT UUID, so it can't be the FTS rowid (which is
--   INTEGER). FTS5 will use SQLite's implicit integer rowid on `messages`
--   instead — `messages_fts.rowid == messages.rowid`. To get from a search
--   hit back to a real message row, JOIN messages ON messages.rowid =
--   messages_fts.rowid (see web/src/lib/search.ts).
--
-- Tokenizer:
--   Default `unicode61` with diacritic-stripping is good for English-ish
--   email text. `remove_diacritics=2` makes searches for "naive" match
--   "naïve". `tokenchars` keeps a few common punctuation characters out of
--   the tokenizer so things like e-mail addresses split on @ and . the way
--   users expect.

PRAGMA foreign_keys = ON;

CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject,
  snippet,
  text_body,
  content=messages,
  content_rowid=rowid,
  tokenize="unicode61 remove_diacritics 2"
);

-- Backfill: index every existing message.
INSERT INTO messages_fts(rowid, subject, snippet, text_body)
  SELECT rowid, subject, snippet, text_body FROM messages;

-- Keep the index in sync. For external-content FTS5, the canonical pattern
-- (from the SQLite docs) is to mirror INSERT/DELETE/UPDATE on the content
-- table into the FTS table.
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, snippet, text_body)
    VALUES (new.rowid, new.subject, new.snippet, new.text_body);
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, snippet, text_body)
    VALUES ('delete', old.rowid, old.subject, old.snippet, old.text_body);
END;

CREATE TRIGGER messages_au AFTER UPDATE OF subject, snippet, text_body ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, snippet, text_body)
    VALUES ('delete', old.rowid, old.subject, old.snippet, old.text_body);
  INSERT INTO messages_fts(rowid, subject, snippet, text_body)
    VALUES (new.rowid, new.subject, new.snippet, new.text_body);
END;
