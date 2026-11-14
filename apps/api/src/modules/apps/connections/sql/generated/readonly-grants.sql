-- SPDX-License-Identifier: FSL-1.1-ALv2
-- GENERATED FILE — do not hand-edit.
-- Rendered by packages/db-core/src/grants-renderer.ts from adapter "liaison-self".
-- Regenerate with `bun run scripts/db-readonly-role.ts --regenerate` after any catalog
-- change; verify with `bun run scripts/db-readonly-role.ts --check-sync`.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_readonly') THEN
    CREATE ROLE liaison_readonly LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS CONNECTION LIMIT 4;
  END IF;
END $$;

ALTER ROLE liaison_readonly BYPASSRLS;
ALTER ROLE liaison_readonly SET default_transaction_read_only = on;
ALTER ROLE liaison_readonly SET statement_timeout = '15s';

GRANT USAGE ON SCHEMA app_knowledge TO liaison_readonly;
GRANT USAGE ON SCHEMA app_mail TO liaison_readonly;
GRANT USAGE ON SCHEMA app_tickets TO liaison_readonly;
GRANT USAGE ON SCHEMA kernel TO liaison_readonly;

GRANT SELECT (archived_at, id, org_id, org_wide, review_status, summary, title, updated_at) ON app_knowledge.documents TO liaison_readonly;
GRANT SELECT (from_email, id, last_message_at, message_count, org_id, owner_type, status) ON app_mail.conversations TO liaison_readonly;
GRANT SELECT (channel, contact_id, created_at, handle, id, org_id, priority, status, subject, updated_at) ON app_tickets.tickets TO liaison_readonly;
GRANT SELECT (action, actor_type, app, entity_id, entity_type, id, org_id, timestamp) ON kernel.audit_log TO liaison_readonly;
GRANT SELECT (app_name, connection_name, id, org_id, status, status_message, token_expires_at, updated_at) ON kernel.connected_accounts TO liaison_readonly;
GRANT SELECT (email, id) ON kernel.contacts TO liaison_readonly;
GRANT SELECT (currency, included_balance, org_id, purchased_balance, updated_at) ON kernel.credit_balances TO liaison_readonly;
GRANT SELECT (amount, balance_after, created_at, description, id, model, org_id, type) ON kernel.credit_transactions TO liaison_readonly;
GRANT SELECT (created_at, id, name, slug, tier) ON kernel.organizations TO liaison_readonly;
GRANT SELECT (created_at, org_id, processed_at) ON kernel.pending_events TO liaison_readonly;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app_knowledge FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app_knowledge FROM liaison_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA app_knowledge REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app_knowledge TO liaison_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app_knowledge TO liaison_rls;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app_knowledge TO liaison_admin;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app_knowledge TO liaison_schema_admin;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app_knowledge TO liaison_definer;
ALTER DEFAULT PRIVILEGES IN SCHEMA app_knowledge GRANT EXECUTE ON FUNCTIONS TO liaison_app, liaison_rls, liaison_admin, liaison_schema_admin, liaison_definer;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app_mail FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app_mail FROM liaison_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA app_mail REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app_mail TO liaison_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app_mail TO liaison_rls;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app_mail TO liaison_admin;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app_mail TO liaison_schema_admin;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app_mail TO liaison_definer;
ALTER DEFAULT PRIVILEGES IN SCHEMA app_mail GRANT EXECUTE ON FUNCTIONS TO liaison_app, liaison_rls, liaison_admin, liaison_schema_admin, liaison_definer;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app_tickets FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app_tickets FROM liaison_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA app_tickets REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app_tickets TO liaison_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app_tickets TO liaison_rls;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app_tickets TO liaison_admin;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app_tickets TO liaison_schema_admin;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app_tickets TO liaison_definer;
ALTER DEFAULT PRIVILEGES IN SCHEMA app_tickets GRANT EXECUTE ON FUNCTIONS TO liaison_app, liaison_rls, liaison_admin, liaison_schema_admin, liaison_definer;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA kernel FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA kernel FROM liaison_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA kernel REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA kernel TO liaison_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA kernel TO liaison_rls;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA kernel TO liaison_admin;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA kernel TO liaison_schema_admin;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA kernel TO liaison_definer;
ALTER DEFAULT PRIVILEGES IN SCHEMA kernel GRANT EXECUTE ON FUNCTIONS TO liaison_app, liaison_rls, liaison_admin, liaison_schema_admin, liaison_definer;

