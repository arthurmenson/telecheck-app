-- =============================================================================
-- rollback/078_rollback.sql — unwind 078_email_pin_auth.sql.
--
-- Restores the DB to its "through 077" shape: drops the email+PIN tables and
-- the accounts additions, and restores accounts.phone_e164 NOT NULL.
--
-- CAVEAT: restoring phone_e164 NOT NULL fails if any email-ONLY account
-- (phone_e164 IS NULL) was created while 078 was live. On a pristine chain
-- (CI) there are none, so this is clean. In an environment with live
-- email-only accounts, either backfill/placeholder those phones or drop the
-- NOT NULL restore from this rollback before running it — the accounts rows
-- are durable and must not be deleted to satisfy a DDL rollback.
-- =============================================================================

DROP TABLE IF EXISTS email_passcodes;

DROP TRIGGER IF EXISTS trg_pin_cred_updated_at ON account_pin_credentials;
DROP TABLE IF EXISTS account_pin_credentials;
DROP FUNCTION IF EXISTS account_pin_credentials_set_updated_at();

DROP INDEX IF EXISTS idx_accounts_tenant_email_active;
DROP INDEX IF EXISTS uq_account_tenant_email;

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS account_has_identifier;

ALTER TABLE accounts ALTER COLUMN phone_e164 SET NOT NULL;
