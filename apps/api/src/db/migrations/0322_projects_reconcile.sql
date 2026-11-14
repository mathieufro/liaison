-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Reconciling a project's period, and the claims that keep a source from being
-- billed twice. New tables in app_projects, RLS enabled and forced:
--   reconciliations        one per project, period and person while proposed
--   reconciliation_lines   its lines, in minutes
--   reconciliation_proofs  a line's proofs: a reference and a short label,
--                          never a body
--   billing_claims         a source reserved or billed for a period
--
-- A proposed reconciliation is its creator's alone: nobody else reads it,
-- whatever they hold. Once it leaves 'proposed' (a person pressed Create
-- invoice), holders of projects:reconcile:read read it. Lines and proofs
-- follow their reconciliation. A live claim (reserved or billed) is unique per
-- source and period, so a second reservation of the same source fails.
-- New tables only: nothing existing changes.
CREATE TABLE app_projects.reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES app_projects.projects(id) ON DELETE CASCADE,
  period_start date,
  period_end date,
  basis text NOT NULL,
  state text NOT NULL CHECK (state IN ('proposed', 'drafted', 'invoiced', 'credited')),
  revision integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  thread_id uuid,
  not_seen jsonb NOT NULL DEFAULT '[]'::jsonb,
  foot jsonb NOT NULL DEFAULT '{}'::jsonb,
  excluded_count integer NOT NULL DEFAULT 0,
  document_id uuid,
  waived_overage boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX reconciliations_proposed_uidx
  ON app_projects.reconciliations (org_id, project_id, period_start, created_by) NULLS NOT DISTINCT
  WHERE state = 'proposed';
--> statement-breakpoint
CREATE INDEX reconciliations_project_idx ON app_projects.reconciliations (project_id);
--> statement-breakpoint
CREATE INDEX reconciliations_creator_idx ON app_projects.reconciliations (created_by);
--> statement-breakpoint
CREATE TABLE app_projects.reconciliation_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  reconciliation_id uuid NOT NULL REFERENCES app_projects.reconciliations(id) ON DELETE CASCADE,
  position integer NOT NULL,
  name text,
  wording text,
  why text,
  kind text CHECK (kind IN ('planned', 'unplanned', 'manual', 'other')),
  reason text CHECK (reason IN ('our_mistake', 'client_asked', 'other_client')),
  task_ids uuid[] NOT NULL DEFAULT '{}',
  planned_minutes integer,
  real_minutes integer,
  real_note_minutes integer,
  trace_estimate_minutes integer,
  bill_minutes integer NOT NULL DEFAULT 0,
  billed_after_credit_minutes integer,
  document_line_position integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX reconciliation_lines_parent_idx
  ON app_projects.reconciliation_lines (reconciliation_id, position);
--> statement-breakpoint
CREATE TABLE app_projects.reconciliation_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  line_id uuid NOT NULL REFERENCES app_projects.reconciliation_lines(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('task', 'commit', 'pull_request', 'merge_request',
    'calendar_event', 'knowledge_doc', 'mail', 'ticket', 'note')),
  ref text NOT NULL,
  label text NOT NULL CHECK (char_length(label) <= 60),
  url text,
  occurred_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX reconciliation_proofs_line_idx ON app_projects.reconciliation_proofs (line_id);
--> statement-breakpoint
CREATE TABLE app_projects.billing_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  reconciliation_id uuid,
  line_id uuid,
  source_kind text NOT NULL,
  source_ref text NOT NULL,
  period_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved', 'billed', 'left_off', 'released', 'credited')),
  document_id uuid,
  document_number text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX billing_claims_live_uidx ON app_projects.billing_claims
  (org_id, source_kind, source_ref, period_key) WHERE state IN ('reserved', 'billed');
--> statement-breakpoint
CREATE INDEX billing_claims_project_idx ON app_projects.billing_claims (org_id, project_id);
--> statement-breakpoint
CREATE INDEX billing_claims_reconciliation_idx ON app_projects.billing_claims (reconciliation_id)
  WHERE reconciliation_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE app_projects.reconciliations OWNER TO liaison_admin;
--> statement-breakpoint
ALTER TABLE app_projects.reconciliation_lines OWNER TO liaison_admin;
--> statement-breakpoint
ALTER TABLE app_projects.reconciliation_proofs OWNER TO liaison_admin;
--> statement-breakpoint
ALTER TABLE app_projects.billing_claims OWNER TO liaison_admin;
--> statement-breakpoint
ALTER TABLE app_projects.reconciliations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.reconciliations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.reconciliation_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.reconciliation_lines FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.reconciliation_proofs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.reconciliation_proofs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.billing_claims ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.billing_claims FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  app_projects.reconciliations, app_projects.reconciliation_lines,
  app_projects.reconciliation_proofs, app_projects.billing_claims
  TO liaison_rls, liaison_app, liaison_admin;
--> statement-breakpoint
CREATE POLICY reconciliations_select ON app_projects.reconciliations FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND (
    created_by = (SELECT rls_ctx.user_id())::uuid
    OR (state <> 'proposed' AND app_projects.app_has_scope('projects:reconcile:read'))));
--> statement-breakpoint
CREATE POLICY reconciliations_insert ON app_projects.reconciliations FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid
    AND created_by = (SELECT rls_ctx.user_id())::uuid
    AND app_projects.app_has_scope('projects:reconcile:read'));
--> statement-breakpoint
CREATE POLICY reconciliations_update ON app_projects.reconciliations FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND (
    (created_by = (SELECT rls_ctx.user_id())::uuid AND state = 'proposed')
    OR app_projects.app_has_scope('projects:reconcile:write')))
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND (
    created_by = (SELECT rls_ctx.user_id())::uuid
    OR app_projects.app_has_scope('projects:reconcile:write')));
--> statement-breakpoint
-- Lines and proofs: read when their reconciliation is readable; written when
-- it is its creator's and still proposed, or by a reconcile writer.
CREATE POLICY reconciliation_lines_select ON app_projects.reconciliation_lines FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND EXISTS (
    SELECT 1 FROM app_projects.reconciliations r
     WHERE r.id = reconciliation_lines.reconciliation_id AND r.org_id = reconciliation_lines.org_id));
--> statement-breakpoint
CREATE POLICY reconciliation_lines_insert ON app_projects.reconciliation_lines FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND EXISTS (
    SELECT 1 FROM app_projects.reconciliations r
     WHERE r.id = reconciliation_lines.reconciliation_id AND r.org_id = reconciliation_lines.org_id
       AND ((r.created_by = (SELECT rls_ctx.user_id())::uuid AND r.state = 'proposed')
            OR app_projects.app_has_scope('projects:reconcile:write'))));
--> statement-breakpoint
CREATE POLICY reconciliation_lines_update ON app_projects.reconciliation_lines FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND EXISTS (
    SELECT 1 FROM app_projects.reconciliations r
     WHERE r.id = reconciliation_lines.reconciliation_id AND r.org_id = reconciliation_lines.org_id
       AND ((r.created_by = (SELECT rls_ctx.user_id())::uuid AND r.state = 'proposed')
            OR app_projects.app_has_scope('projects:reconcile:write'))))
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND EXISTS (
    SELECT 1 FROM app_projects.reconciliations r
     WHERE r.id = reconciliation_lines.reconciliation_id AND r.org_id = reconciliation_lines.org_id
       AND ((r.created_by = (SELECT rls_ctx.user_id())::uuid AND r.state = 'proposed')
            OR app_projects.app_has_scope('projects:reconcile:write'))));
--> statement-breakpoint
CREATE POLICY reconciliation_lines_delete ON app_projects.reconciliation_lines FOR DELETE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND EXISTS (
    SELECT 1 FROM app_projects.reconciliations r
     WHERE r.id = reconciliation_lines.reconciliation_id AND r.org_id = reconciliation_lines.org_id
       AND ((r.created_by = (SELECT rls_ctx.user_id())::uuid AND r.state = 'proposed')
            OR app_projects.app_has_scope('projects:reconcile:write'))));
--> statement-breakpoint
CREATE POLICY reconciliation_proofs_select ON app_projects.reconciliation_proofs FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND EXISTS (
    SELECT 1 FROM app_projects.reconciliation_lines l
     WHERE l.id = reconciliation_proofs.line_id AND l.org_id = reconciliation_proofs.org_id));
--> statement-breakpoint
CREATE POLICY reconciliation_proofs_insert ON app_projects.reconciliation_proofs FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND EXISTS (
    SELECT 1 FROM app_projects.reconciliation_lines l
      JOIN app_projects.reconciliations r ON r.id = l.reconciliation_id AND r.org_id = l.org_id
     WHERE l.id = reconciliation_proofs.line_id AND l.org_id = reconciliation_proofs.org_id
       AND ((r.created_by = (SELECT rls_ctx.user_id())::uuid AND r.state = 'proposed')
            OR app_projects.app_has_scope('projects:reconcile:write'))));
--> statement-breakpoint
CREATE POLICY reconciliation_proofs_update ON app_projects.reconciliation_proofs FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND EXISTS (
    SELECT 1 FROM app_projects.reconciliation_lines l
      JOIN app_projects.reconciliations r ON r.id = l.reconciliation_id AND r.org_id = l.org_id
     WHERE l.id = reconciliation_proofs.line_id AND l.org_id = reconciliation_proofs.org_id
       AND ((r.created_by = (SELECT rls_ctx.user_id())::uuid AND r.state = 'proposed')
            OR app_projects.app_has_scope('projects:reconcile:write'))))
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND EXISTS (
    SELECT 1 FROM app_projects.reconciliation_lines l
      JOIN app_projects.reconciliations r ON r.id = l.reconciliation_id AND r.org_id = l.org_id
     WHERE l.id = reconciliation_proofs.line_id AND l.org_id = reconciliation_proofs.org_id
       AND ((r.created_by = (SELECT rls_ctx.user_id())::uuid AND r.state = 'proposed')
            OR app_projects.app_has_scope('projects:reconcile:write'))));
--> statement-breakpoint
CREATE POLICY reconciliation_proofs_delete ON app_projects.reconciliation_proofs FOR DELETE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND EXISTS (
    SELECT 1 FROM app_projects.reconciliation_lines l
      JOIN app_projects.reconciliations r ON r.id = l.reconciliation_id AND r.org_id = l.org_id
     WHERE l.id = reconciliation_proofs.line_id AND l.org_id = reconciliation_proofs.org_id
       AND ((r.created_by = (SELECT rls_ctx.user_id())::uuid AND r.state = 'proposed')
            OR app_projects.app_has_scope('projects:reconcile:write'))));
--> statement-breakpoint
CREATE POLICY billing_claims_select ON app_projects.billing_claims FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:reconcile:read'));
--> statement-breakpoint
CREATE POLICY billing_claims_insert ON app_projects.billing_claims FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:reconcile:write'));
--> statement-breakpoint
CREATE POLICY billing_claims_update ON app_projects.billing_claims FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:reconcile:write'))
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:reconcile:write'));
--> statement-breakpoint
CREATE POLICY billing_claims_delete ON app_projects.billing_claims FOR DELETE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:reconcile:write'));
