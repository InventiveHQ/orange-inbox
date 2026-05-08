-- Mini-CRM fields on contacts: company/title/phone etc., a free-form tag list
-- (JSON array), and a single-select lifecycle stage. Tags live as JSON on the
-- row rather than a join table because the contacts page loads everything for
-- the chosen mailbox anyway and filters client-side.
--
-- stage enum lives in lib/contacts.ts (CONTACT_STAGES). NULL means "unset" so
-- existing rows don't get a default bucket they didn't pick.

PRAGMA foreign_keys = ON;

ALTER TABLE contacts ADD COLUMN company   TEXT;
ALTER TABLE contacts ADD COLUMN title     TEXT;
ALTER TABLE contacts ADD COLUMN phone     TEXT;
ALTER TABLE contacts ADD COLUMN website   TEXT;
ALTER TABLE contacts ADD COLUMN linkedin  TEXT;
ALTER TABLE contacts ADD COLUMN address   TEXT;
ALTER TABLE contacts ADD COLUMN stage     TEXT;
ALTER TABLE contacts ADD COLUMN tags_json TEXT;

CREATE INDEX contacts_mailbox_stage ON contacts(mailbox_id, stage);
