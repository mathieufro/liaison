-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Suppressions: the addresses an org must not send commercial mail to.
--
-- An address is never stored, only its fingerprint:
-- email_hash = sha256(org_id || ':' || lower(trim(email))), hex. That is all a
-- suppression is used for, so it is all that is kept.
--
--   kernel.suppressions       read with mail:suppressions:read (or by a system
--                             actor: the send path), added by anyone who
--                             writes mail (mail:conversations:write) or holds
--                             mail:suppressions:write, removed only with
--                             mail:suppressions:write (mail admins). Never
--                             updated.
--   kernel.suppression_links  the opt-out links' tokens, hashed. No policy for
--                             liaison_rls and no grant to it: only the send path
--                             and the public opt-out route touch them, through
--                             the privileged connection.
--
-- No existing table is altered.
CREATE TABLE kernel.suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  email_hash text NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (reason IN ('link', 'reply', 'person', 'import')),
  -- a mail message id or a user id, never the address
  source text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppressions_org_hash_key UNIQUE (org_id, email_hash)
);
--> statement-breakpoint
CREATE TABLE kernel.suppression_links (
  -- sha256 of a 32 byte random token, hex
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  org_id uuid NOT NULL REFERENCES kernel.organizations(id) ON DELETE CASCADE,
  email_hash text NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX suppression_links_org_idx ON kernel.suppression_links (org_id, created_at);
--> statement-breakpoint
ALTER TABLE kernel.suppressions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.suppressions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.suppression_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kernel.suppression_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON kernel.suppressions TO liaison_rls;
--> statement-breakpoint
-- An opt-out is never edited: no UPDATE right, whatever the schema's defaults gave.
REVOKE UPDATE, TRUNCATE ON kernel.suppressions FROM liaison_rls, PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.suppressions TO liaison_admin, liaison_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON kernel.suppression_links TO liaison_admin, liaison_app;
--> statement-breakpoint
-- The schema's default privileges hand new tables to the request role; this
-- one it never touches.
REVOKE ALL ON kernel.suppression_links FROM liaison_rls, PUBLIC;
--> statement-breakpoint
-- A system actor carries the nil user id (db/rls.ts): the send path checks
-- recipients without a person's scope.
CREATE POLICY suppressions_select ON kernel.suppressions FOR SELECT TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (
      (SELECT kernel.has_scope('mail:suppressions:read'))
      OR (SELECT rls_ctx.user_id()) = '00000000-0000-0000-0000-000000000000'
    )
  );
--> statement-breakpoint
-- An opt-out must be honoured by whoever receives it, so the right to write
-- to people is enough to record one. Removing one lifts a person's refusal
-- and needs the suppressions write scope.
CREATE POLICY suppressions_insert ON kernel.suppressions FOR INSERT TO liaison_rls
  WITH CHECK (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (
      (SELECT kernel.has_scope('mail:suppressions:write'))
      OR (SELECT kernel.has_scope('mail:conversations:write'))
    )
  );
--> statement-breakpoint
CREATE POLICY suppressions_delete ON kernel.suppressions FOR DELETE TO liaison_rls
  USING (
    org_id = (SELECT rls_ctx.org_id())::uuid
    AND (SELECT kernel.has_scope('mail:suppressions:write'))
  );
--> statement-breakpoint

-- Scope seed: whoever reads mail sees who opted out (new orgs get the same
-- through mail's member tier); mail admins may remove an opt-out. Writing
-- mail needs no seed to record one (the insert policy above).
-- Run as liaison_admin (BYPASSRLS): the grant tables force row security, so a
-- migration login that is no superuser would read no row and seed nothing.
SET LOCAL ROLE liaison_admin;
--> statement-breakpoint
WITH pairs (old_scope, new_scope) AS (
  VALUES ('mail:conversations:read', 'mail:suppressions:read'),
         ('mail:accounts:admin', 'mail:suppressions:write'),
         ('mail:conversations:*', 'mail:suppressions:read')
)
INSERT INTO kernel.role_scope_grants (id, role_id, scope)
SELECT gen_random_uuid(), g.role_id, p.new_scope
  FROM kernel.role_scope_grants g
  JOIN pairs p ON p.old_scope = g.scope
ON CONFLICT (role_id, scope) DO NOTHING;
--> statement-breakpoint
WITH pairs (old_scope, new_scope) AS (
  VALUES ('mail:conversations:read', 'mail:suppressions:read'),
         ('mail:accounts:admin', 'mail:suppressions:write'),
         ('mail:conversations:*', 'mail:suppressions:read')
)
INSERT INTO kernel.user_scope_grants (id, user_id, org_id, scope)
SELECT gen_random_uuid(), g.user_id, g.org_id, p.new_scope
  FROM kernel.user_scope_grants g
  JOIN pairs p ON p.old_scope = g.scope
ON CONFLICT (user_id, org_id, scope) DO NOTHING;
--> statement-breakpoint
RESET ROLE;
