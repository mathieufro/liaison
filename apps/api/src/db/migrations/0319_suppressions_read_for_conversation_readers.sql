-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Whoever reads mail conversations reads the opt-out list too (mail:suppressions:read), which the
-- contact page's opt-out check and the agent's suppression check require. 0292 granted it to the
-- roles and direct grants that read conversations then; this grants it again to those written
-- since (an organisation's own custom roles), and adds it to the stored scopes of the routines
-- that read conversations, so their opt-out checks keep working. Only adds: no grant or scope is
-- removed, and the previous release reads the same tables and columns unchanged.
--
-- A routine's scopes change here, but nobody edited the routine: its last editor (0230) is kept,
-- so the routines_mark_definition_edit trigger is held off for this one update only.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: the trigger is off for this transaction's own update only, and on again before it commits
ALTER TABLE kernel.routines DISABLE TRIGGER routines_mark_definition_edit;
--> statement-breakpoint
-- Run as liaison_admin (BYPASSRLS): the grant tables force row security, so a migration login that
-- is no superuser would read no row and change nothing.
SET LOCAL ROLE liaison_admin;
--> statement-breakpoint
WITH added AS (
  INSERT INTO kernel.role_scope_grants (id, role_id, scope)
  SELECT gen_random_uuid(), g.role_id, 'mail:suppressions:read'
    FROM kernel.role_scope_grants g
   WHERE g.scope IN ('mail:conversations:read', 'mail:conversations:*', 'mail:conversations')
     AND NOT EXISTS (
       SELECT 1 FROM kernel.role_scope_grants h
        WHERE h.role_id = g.role_id
          AND h.scope IN ('mail:suppressions:read', 'mail:suppressions:*', 'mail:suppressions',
                          'mail:*', 'mail', '*'))
  ON CONFLICT (role_id, scope) DO NOTHING
  RETURNING role_id
)
UPDATE kernel.users u
   SET permission_version = u.permission_version + 1
 WHERE u.id IN (SELECT ur.user_id FROM kernel.user_roles ur JOIN added a ON a.role_id = ur.role_id);
--> statement-breakpoint
WITH added AS (
  INSERT INTO kernel.user_scope_grants (id, user_id, org_id, scope)
  SELECT gen_random_uuid(), g.user_id, g.org_id, 'mail:suppressions:read'
    FROM kernel.user_scope_grants g
   WHERE g.scope IN ('mail:conversations:read', 'mail:conversations:*', 'mail:conversations')
     AND NOT EXISTS (
       SELECT 1 FROM kernel.user_scope_grants h
        WHERE h.user_id = g.user_id AND h.org_id = g.org_id
          AND h.scope IN ('mail:suppressions:read', 'mail:suppressions:*', 'mail:suppressions',
                          'mail:*', 'mail', '*'))
  ON CONFLICT (user_id, org_id, scope) DO NOTHING
  RETURNING user_id
)
UPDATE kernel.users u
   SET permission_version = u.permission_version + 1
 WHERE u.id IN (SELECT user_id FROM added);
--> statement-breakpoint
UPDATE kernel.routines
   SET scopes = array_append(scopes, 'mail:suppressions:read'),
       inferred_scopes = CASE
         WHEN inferred_scopes && ARRAY['mail:conversations:read', 'mail:conversations:*',
                                       'mail:conversations']::text[]
         THEN array_append(inferred_scopes, 'mail:suppressions:read')
         ELSE inferred_scopes
       END
 WHERE scopes && ARRAY['mail:conversations:read', 'mail:conversations:*', 'mail:conversations']::text[]
   AND NOT scopes && ARRAY['mail:suppressions:read', 'mail:suppressions:*', 'mail:suppressions',
                           'mail:*', 'mail', '*']::text[];
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
-- expand-safe: the trigger 0230 created, back on with its own definition unchanged
ALTER TABLE kernel.routines ENABLE TRIGGER routines_mark_definition_edit;
