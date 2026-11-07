-- SPDX-License-Identifier: FSL-1.1-ALv2
-- An external user: someone from a client's company who signs in to the portal.
--
-- The only ACCESS EXCLUSIVE lock on kernel.users in its batch, so it runs last
-- of everything that touches an existing table.
--
-- Three things hold the boundary on this side:
--   users_members_only   a restrictive policy: RLS, not a query, hides a client
--                        from members. Privileged code is not narrowed by it.
--   users_type_immutable a person never changes kind.
--   user_roles_member_only  a role never lands on an external row. Its function
--                        is SECURITY DEFINER and owned by liaison_definer with
--                        column rights only: the policy above hides that row
--                        from whoever assigns, and FORCE RLS hides every row
--                        from a migration login that is no superuser, so a
--                        function reading as either would see nothing there
--                        and let the insert through.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE kernel.users
  ADD COLUMN user_type text NOT NULL DEFAULT 'member',
  ADD COLUMN company_id uuid;
--> statement-breakpoint
-- expand-safe: no previous-release row violates it; every existing row is member with no company
ALTER TABLE kernel.users ADD CONSTRAINT users_type_check
  CHECK (user_type IN ('member', 'external'));
--> statement-breakpoint
-- expand-safe: no previous-release row violates it; every existing row is member with no company
ALTER TABLE kernel.users ADD CONSTRAINT users_external_company_check
  CHECK ((user_type = 'external') = (company_id IS NOT NULL));
--> statement-breakpoint
-- index-build: kernel.users 1000000 61
CREATE INDEX users_external_company_idx ON kernel.users (org_id, company_id)
  WHERE user_type = 'external';
--> statement-breakpoint
GRANT SELECT (id, user_type, company_id, status) ON kernel.users TO liaison_definer;
--> statement-breakpoint
CREATE FUNCTION kernel.users_type_immutable() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  RAISE EXCEPTION 'user_type cannot change once a user exists';
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kernel.users_type_immutable() FROM PUBLIC;
--> statement-breakpoint
-- expand-safe: the previous release never writes user_type, so the condition is never true for it
CREATE TRIGGER users_type_immutable BEFORE UPDATE ON kernel.users
  FOR EACH ROW WHEN (OLD.user_type IS DISTINCT FROM NEW.user_type)
  EXECUTE FUNCTION kernel.users_type_immutable();
--> statement-breakpoint
-- A login that is no superuser may hand a function only to a role holding
-- CREATE on its schema, so liaison_definer holds it for the length of the hand-over.
GRANT CREATE ON SCHEMA kernel TO liaison_definer;
--> statement-breakpoint
CREATE FUNCTION kernel.user_roles_member_only() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM kernel.users u WHERE u.id = NEW.user_id AND u.user_type = 'external') THEN
    RAISE EXCEPTION 'an external user holds no role';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION kernel.user_roles_member_only() OWNER TO liaison_definer;
--> statement-breakpoint
-- expand-safe: taken back from a role that held it for the hand-over above and uses it for nothing else
REVOKE CREATE ON SCHEMA kernel FROM liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kernel.user_roles_member_only() FROM PUBLIC;
--> statement-breakpoint
-- expand-safe: no external row exists yet, so the previous release's role assignments all pass
CREATE TRIGGER user_roles_member_only BEFORE INSERT OR UPDATE OF user_id ON kernel.user_roles
  FOR EACH ROW EXECUTE FUNCTION kernel.user_roles_member_only();
--> statement-breakpoint
-- expand-safe: every row the previous release can read or write is a member row, which this passes
CREATE POLICY users_members_only ON kernel.users AS RESTRICTIVE
  FOR ALL TO liaison_rls
  USING (user_type = 'member' OR kernel.has_scope('kernel:portal:admin'))
  WITH CHECK (user_type = 'member' OR kernel.has_scope('kernel:portal:admin'));
