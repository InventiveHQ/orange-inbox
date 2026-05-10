-- Per-message trust signals.
--
-- Adds three columns to `messages` so the reader UI can render:
--   * a DMARC/SPF/DKIM verdict chip (parsed from the inbound
--     `Authentication-Results` header at ingest time), and
--   * a "first contact" / "Reply-To differs from From" safety banner.
--
-- auth_results stores a JSON blob of the form
--   {"spf":"pass"|"fail"|"softfail"|"neutral"|"none"|"temperror"|"permerror",
--    "dkim":"pass"|...,
--    "dmarc":"pass"|...,
--    "from_domain":"example.com"}
-- with NULL == header was absent or unparseable.
--
-- first_contact is set to 1 by the email worker when no prior message from
-- this from_addr exists in the same mailbox; it is NEVER updated after
-- insert. Old rows stay 0; we don't backfill.
--
-- reply_to_addr is the bare address from the Reply-To header, normalized
-- via postal-mime, but only if it differs from from_addr — NULL otherwise.
-- (Storing only the differing case keeps the "is reply-to suspicious?"
-- predicate in the UI a simple `IS NOT NULL`.)
--
-- Applies to mail DBs (where messages lives). For existing overflow DBs
-- run the same ALTER manually via wrangler d1 execute. New overflow DBs
-- get this from db/mail-plane-bootstrap.sql (also updated).

ALTER TABLE messages ADD COLUMN auth_results TEXT;       -- JSON {spf,dkim,dmarc,from_domain}
ALTER TABLE messages ADD COLUMN first_contact INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN reply_to_addr TEXT;       -- from Reply-To header, NULL if absent or matches from_addr
