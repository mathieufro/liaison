-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Companies: the organisations an org's contacts work for.
--
-- Sharing has the shape of contacts' (0117_resource_sharing.sql), with one
-- difference: a company's sharing branches on who created it (created_by),
-- never on its account manager (owner_user_id). The account manager is a
-- label that routes approvals; it grants no read and no write, so naming
-- someone at creation is never an access question.
--
-- What keeps a company safe is not only its policies. As for contacts
-- (0117:490-523 contacts_sharing_guard, 0117:566-569 contacts_grants_cleanup),
-- the UPDATE policy checks only the org, and a trigger holds the rest for a
-- request transaction:
--   * on insert, created_by is the person writing, and the search ACL columns
--     start empty (they are derived, by kernel.recompute_search_acl only);
--   * on update, created_by never changes, the ACL columns are never written,
--     and org_access changes only for whoever manages the company's sharing;
--   * a deleted company takes its grants with it.
--
-- kernel.contacts, kernel.users and kernel.approval_requests are touched last
-- in the batch (0294 and the end of this file), so their locks are the
-- shortest the one-transaction migrator allows.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE kernel.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  handle text NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  -- lowercase host, never a consumer domain; not unique (a group's companies share one)
  domain text,
  description text,
  -- soft reference, cleared by the merge and delete paths
  main_contact_id uuid,
  tags text[] NOT NULL DEFAULT '{}',
  metadata jsonb,
  not_same_as uuid[] NOT NULL DEFAULT '{}',
  -- the relationship ended
  closed_at timestamptz,
  -- who decides the company's sharing (soft: a person merge re-points it)
  created_by uuid,
  -- the account manager: routes approvals, grants nothing
  owner_user_id uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  org_access text NOT NULL DEFAULT 'editor' CHECK (org_access IN ('none', 'viewer', 'editor')),
  acl_user_ids jsonb NOT NULL DEFAULT '[]',
  acl_role_ids jsonb NOT NULL DEFAULT '[]',
  org_wide boolean GENERATED ALWAYS AS (org_access IN ('viewer', 'editor')) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- a company nobody can see would have nobody to share it again
  CONSTRAINT companies_restricted_has_creator CHECK (org_access <> 'none' OR created_by IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX companies_org_handle_idx ON kernel.companies (org_id, handle);
--> statement-breakpoint
CREATE INDEX companies_org_domain_idx ON kernel.companies (org_id, lower(domain)) WHERE domain IS NOT NULL;
--> statement-breakpoint
CREATE INDEX companies_org_name_idx ON kernel.companies (org_id, lower(name));
--> statement-breakpoint
CREATE INDEX companies_owner_idx ON kernel.companies (org_id, owner_user_id) WHERE owner_user_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE kernel.companies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.companies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.companies TO liaison_rls, liaison_admin, liaison_app;
--> statement-breakpoint
-- kernel.recompute_search_acl (below) and kernel.can_manage_company_sharing
GRANT SELECT ON kernel.companies TO liaison_definer;
--> statement-breakpoint
GRANT UPDATE (acl_user_ids, acl_role_ids) ON kernel.companies TO liaison_definer;
--> statement-breakpoint

-- Who may change a company's sharing: its creator; the org's contact admins
-- when the creator is gone or no longer active (so a private company never
-- becomes nobody's). Being granted editor lets a person edit a company, never
-- re-share it. The account manager has no branch here.
--
-- Owned by liaison_definer (BYPASSRLS, column rights only): a migration login
-- that is no superuser reads nothing under FORCE RLS, so a function it owned
-- would see no row.
GRANT CREATE ON SCHEMA kernel TO liaison_definer;
--> statement-breakpoint
CREATE FUNCTION kernel.can_manage_company_sharing(_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM kernel.companies c
     WHERE c.id = _id
       AND c.org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
       AND (
         c.created_by = NULLIF((SELECT rls_ctx.user_id()), '')::uuid
         OR (
           (c.created_by IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM kernel.users u
                WHERE u.id = c.created_by AND u.status = 'active'))
           AND kernel.has_scope('kernel:contacts:admin')
         )
       )
  )
$fn$;
--> statement-breakpoint
ALTER FUNCTION kernel.can_manage_company_sharing(uuid) OWNER TO liaison_definer;
--> statement-breakpoint
-- expand-safe: taken back from a role that held it for the hand-over above and uses it for nothing else
REVOKE CREATE ON SCHEMA kernel FROM liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kernel.can_manage_company_sharing(uuid) FROM PUBLIC;
--> statement-breakpoint
-- liaison_admin: kernel.can_manage_sharing (its definer) dispatches to it
-- reviewed-dynamic: a privilege grant, no statement is executed
GRANT EXECUTE ON FUNCTION kernel.can_manage_company_sharing(uuid) TO liaison_rls, liaison_app, liaison_admin;
--> statement-breakpoint
INSERT INTO kernel.shareable_resource_types (resource_type, can_manage, resource_table)
VALUES ('kernel.company', 'kernel.can_manage_company_sharing(uuid)', 'kernel.companies')
ON CONFLICT (resource_type) DO UPDATE
  SET can_manage = EXCLUDED.can_manage, resource_table = EXCLUDED.resource_table;
--> statement-breakpoint

CREATE POLICY companies_select ON kernel.companies FOR SELECT TO liaison_rls
  USING (
    org_id = NULLIF(rls_ctx.org_id(), '')::uuid
    AND (
      org_access IN ('viewer', 'editor')
      OR created_by = NULLIF(rls_ctx.user_id(), '')::uuid
      OR kernel.resource_grant_role('kernel.company', id) IS NOT NULL
    )
  );
--> statement-breakpoint
-- A person creates a company as themselves (the trigger below sets
-- created_by), restricted or not; a system actor only an org-wide one.
CREATE POLICY companies_insert ON kernel.companies FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = NULLIF(rls_ctx.org_id(), '')::uuid
    AND (
      created_by = NULLIF(rls_ctx.user_id(), '')::uuid
      OR org_access <> 'none'
    )
  );
--> statement-breakpoint
CREATE POLICY companies_update ON kernel.companies FOR UPDATE TO liaison_rls
  USING (
    org_id = NULLIF(rls_ctx.org_id(), '')::uuid
    AND (
      org_access = 'editor'
      OR created_by = NULLIF(rls_ctx.user_id(), '')::uuid
      OR kernel.resource_grant_role('kernel.company', id) = 'editor'
    )
  )
  WITH CHECK (org_id = NULLIF(rls_ctx.org_id(), '')::uuid);
--> statement-breakpoint
CREATE POLICY companies_delete ON kernel.companies FOR DELETE TO liaison_rls
  USING (
    org_id = NULLIF(rls_ctx.org_id(), '')::uuid
    AND (
      org_access = 'editor'
      OR created_by = NULLIF(rls_ctx.user_id(), '')::uuid
      OR kernel.resource_grant_role('kernel.company', id) = 'editor'
    )
  );
--> statement-breakpoint

-- What RLS cannot express on one row version (contacts_sharing_guard's rules,
-- on created_by). Privileged maintenance (a person merge re-pointing
-- created_by, the search ACL recompute) runs as another role and is not
-- subject to it.
CREATE FUNCTION kernel.companies_sharing_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  me text;
BEGIN
  IF current_user <> 'liaison_rls' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- The creator is whoever writes: nobody files a company under another
    -- person's name. A system actor (the nil user) or an unverified one
    -- creates a company with no creator, which the policy keeps org-wide.
    me := rls_ctx.user_id();
    NEW.created_by := CASE
      WHEN me IS NULL OR me IN ('', '00000000-0000-0000-0000-000000000000',
                                'ffffffff-ffff-ffff-ffff-ffffffffffff') THEN NULL
      ELSE me::uuid
    END;
    -- The search ACL is derived (kernel.recompute_search_acl), never written.
    NEW.acl_user_ids := '[]'::jsonb;
    NEW.acl_role_ids := '[]'::jsonb;
    RETURN NEW;
  END IF;
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'company_creator_immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.acl_user_ids IS DISTINCT FROM OLD.acl_user_ids
     OR NEW.acl_role_ids IS DISTINCT FROM OLD.acl_role_ids THEN
    RAISE EXCEPTION 'company_acl_derived' USING ERRCODE = '42501';
  END IF;
  IF NEW.org_access IS DISTINCT FROM OLD.org_access
     AND NOT kernel.can_manage_sharing('kernel.company', OLD.id) THEN
    RAISE EXCEPTION 'company_sharing_forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kernel.companies_sharing_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER companies_sharing_guard
  BEFORE INSERT OR UPDATE ON kernel.companies
  FOR EACH ROW EXECUTE FUNCTION kernel.companies_sharing_guard();
--> statement-breakpoint
-- A deleted company takes its grants with it (the function contacts use).
CREATE TRIGGER companies_grants_cleanup AFTER DELETE ON kernel.companies
  FOR EACH ROW EXECUTE FUNCTION kernel.resource_grants_cleanup('kernel.company');
--> statement-breakpoint

-- The search projection of a company: its creator plus whoever it is shared
-- with. Same function as for contacts and documents, one more type.
-- expand-safe: adds a resource type; the previous release's two types are computed exactly as before
-- reviewed-dynamic: the UPDATE it executes is 0178's, on the registered table of a known type only; the one change is the company branch of the owner columns
CREATE OR REPLACE FUNCTION kernel.recompute_search_acl(
  p_type text, p_resource_id uuid, p_org uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  -- An untagged context reads as the all-zero org: fall back to p_org as 0178 did for an unset one.
  v_org uuid := COALESCE(NULLIF(NULLIF((SELECT rls_ctx.org_id()), ''), '00000000-0000-0000-0000-000000000000')::uuid, p_org);
  v_table regclass;
  v_owner_cols text[];
  v_owner_union text;
BEGIN
  IF p_org IS NOT NULL AND p_org IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'recompute_search_acl: not the transaction''s org' USING ERRCODE = '42501';
  END IF;
  v_owner_cols := CASE p_type
    WHEN 'kernel.contact' THEN ARRAY['owner_user_id']
    WHEN 'knowledge.document' THEN ARRAY['owner_user_id', 'created_by']
    WHEN 'kernel.dashboard' THEN ARRAY['owner_user_id']
    WHEN 'kernel.dashboard_table' THEN ARRAY['owner_user_id']
    WHEN 'kernel.company' THEN ARRAY['created_by']
  END;
  SELECT resource_table INTO v_table
    FROM kernel.shareable_resource_types WHERE resource_type = p_type;
  IF v_owner_cols IS NULL OR v_table IS NULL THEN
    RAISE EXCEPTION 'not a shareable resource type: %', p_type USING ERRCODE = '22023';
  END IF;
  SELECT string_agg(format('SELECT r.%1$I::text AS uid WHERE r.%1$I IS NOT NULL', c), ' UNION ')
    INTO v_owner_union FROM unnest(v_owner_cols) AS c;
  EXECUTE format($q$
    UPDATE %s r
       SET acl_user_ids = (
             SELECT COALESCE(jsonb_agg(DISTINCT u.uid), '[]'::jsonb) FROM (
               %s
               UNION
               SELECT g.grantee AS uid FROM kernel.resource_grants g
                WHERE g.resource_type = $1 AND g.resource_id = r.id AND g.grantee_kind = 'user'
             ) u),
           acl_role_ids = (
             SELECT COALESCE(jsonb_agg(DISTINCT k.key), '[]'::jsonb) FROM (
               SELECT g.grantee AS key FROM kernel.resource_grants g
                WHERE g.resource_type = $1 AND g.resource_id = r.id AND g.grantee_kind = 'role'
               UNION
               SELECT dk.key
                 FROM kernel.resource_grants g
                 CROSS JOIN LATERAL (
                   SELECT split_part(g.grantee, '=', 1) AS dim,
                          substr(g.grantee, strpos(g.grantee, '=') + 1) AS val
                 ) d
                 CROSS JOIN LATERAL unnest(ARRAY[
                   'dim:' || d.dim || '=' || d.val,
                   'dim:' || regexp_replace(d.dim, '^.*:', '') || '=' || d.val,
                   'dim:' || d.dim || '=*',
                   'dim:' || regexp_replace(d.dim, '^.*:', '') || '=*',
                   'dim:*'
                 ]) AS dk(key)
                WHERE g.resource_type = $1 AND g.resource_id = r.id AND g.grantee_kind = 'dimension'
             ) k)
     WHERE r.id = $2 AND r.org_id = $3
  $q$, v_table, v_owner_union) USING p_type, p_resource_id, v_org;
  -- Without an org context the row matches nothing (r.org_id = NULL).
END
$fn$;
--> statement-breakpoint

-- Scope seed: whoever reads or writes contacts reads or writes companies, so
-- nobody loses reach. Wildcards that already cover kernel:companies:* need
-- nothing; kernel:contacts:* gets kernel:companies:*.
-- Run as liaison_admin (BYPASSRLS): the grant tables force row security, so a
-- migration login that is no superuser would read no row and seed nothing.
SET LOCAL ROLE liaison_admin;
--> statement-breakpoint
WITH pairs (old_scope, new_scope) AS (
  VALUES ('kernel:contacts:read', 'kernel:companies:read'),
         ('kernel:contacts:write', 'kernel:companies:write'),
         ('kernel:contacts:*', 'kernel:companies:*')
)
INSERT INTO kernel.role_scope_grants (id, role_id, scope)
SELECT gen_random_uuid(), g.role_id, p.new_scope
  FROM kernel.role_scope_grants g
  JOIN pairs p ON p.old_scope = g.scope
ON CONFLICT (role_id, scope) DO NOTHING;
--> statement-breakpoint
WITH pairs (old_scope, new_scope) AS (
  VALUES ('kernel:contacts:read', 'kernel:companies:read'),
         ('kernel:contacts:write', 'kernel:companies:write'),
         ('kernel:contacts:*', 'kernel:companies:*')
)
INSERT INTO kernel.user_scope_grants (id, user_id, org_id, scope)
SELECT gen_random_uuid(), g.user_id, g.org_id, p.new_scope
  FROM kernel.user_scope_grants g
  JOIN pairs p ON p.old_scope = g.scope
ON CONFLICT (user_id, org_id, scope) DO NOTHING;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint

-- The two earlier columns that name a company get their foreign keys. No row
-- names a company yet, so neither check can fail.
-- expand-safe: no previous-release row has a company_id (only external users carry one, and none exists before this release)
ALTER TABLE kernel.users
  ADD CONSTRAINT users_company_fk FOREIGN KEY (company_id)
  REFERENCES kernel.companies(id) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
-- expand-safe: validates the constraint above; every row passes
ALTER TABLE kernel.users VALIDATE CONSTRAINT users_company_fk;
--> statement-breakpoint
-- expand-safe: the previous release never writes route_company_id, so every row is NULL and passes
ALTER TABLE kernel.approval_requests
  ADD CONSTRAINT approval_requests_route_company_fk FOREIGN KEY (route_company_id)
  REFERENCES kernel.companies(id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
-- expand-safe: validates the constraint above; every row passes
ALTER TABLE kernel.approval_requests VALIDATE CONSTRAINT approval_requests_route_company_fk;
