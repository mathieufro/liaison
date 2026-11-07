-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The portal's database side: one role, one schema of views.
--
-- liaison_portal logs in as nothing and holds less than liaison_rls. It can use
-- the schema `portal` and read what is listed there; a kernel table raises
-- permission denied rather than returning no rows. db/portal-role-grants.test.ts
-- holds the complete list of what it reaches.
--
-- Each later view: security_barrier, a named column list, filtered on
-- portal.company_id() and the shared flag, no NULL branch. A view runs with its
-- owner's rights, and liaison_admin bypasses row-level security, so a view is
-- protected by its own WHERE alone. Portal writes go through a privileged, listed
-- path, never a grant.
--
-- liaison_request becomes a member of it, because withPortalContext runs on the
-- request pool and steps down into it. The login is also a member of liaison_rls,
-- so a statement run inside that transaction (RESET ROLE, SET ROLE liaison_rls)
-- can return to the login's roles: the boundary holds because portal code runs
-- only static SQL, never text a caller supplies (db/portal-rls.test.ts records it).

-- reviewed-dynamic: the role is cluster wide, so it is created once and given to the logins that step into it, each only when missing
DO $$
DECLARE
  login text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_portal') THEN
    CREATE ROLE liaison_portal NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  FOREACH login IN ARRAY ARRAY['liaison_app', 'postgres', 'liaison_request', current_user::text] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = login)
       AND NOT pg_has_role(login, 'liaison_portal', 'MEMBER') THEN
      EXECUTE format('GRANT liaison_portal TO %I', login);
    END IF;
  END LOOP;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO liaison_portal', current_database());
END $$;
--> statement-breakpoint
CREATE SCHEMA portal;
--> statement-breakpoint
-- expand-safe: a schema this file creates, which nothing has used yet
REVOKE ALL ON SCHEMA portal FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA portal TO liaison_portal;
--> statement-breakpoint
-- A login that is no superuser may hand an object only to a role holding CREATE
-- on its schema. liaison_admin keeps it, for the views later migrations add.
GRANT CREATE ON SCHEMA portal TO liaison_admin, liaison_definer;
--> statement-breakpoint
CREATE FUNCTION portal.company_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT u.company_id FROM kernel.users u
   WHERE u.id = (SELECT rls_ctx.user_id())::uuid AND u.user_type = 'external' AND u.status = 'active'
$fn$;
--> statement-breakpoint
ALTER FUNCTION portal.company_id() OWNER TO liaison_definer;
--> statement-breakpoint
-- expand-safe: granted above in this file, for the hand-over just made
REVOKE CREATE ON SCHEMA portal FROM liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION portal.company_id() FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a plain grant; EXECUTE here is the privilege, not dynamic SQL
GRANT EXECUTE ON FUNCTION portal.company_id() TO liaison_portal;
--> statement-breakpoint
CREATE VIEW portal.me WITH (security_barrier = true) AS
  SELECT id, name, email, locale, timezone, company_id
    FROM kernel.users
   WHERE id = (SELECT rls_ctx.user_id())::uuid AND user_type = 'external' AND status = 'active';
--> statement-breakpoint
ALTER VIEW portal.me OWNER TO liaison_admin;
--> statement-breakpoint
GRANT SELECT ON portal.me TO liaison_portal;
