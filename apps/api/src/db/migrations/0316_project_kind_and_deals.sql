-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Pipelines and deals in Projects.
--
-- A project is a work project or a pipeline. A deal is a root task of a
-- pipeline with two rows beside it:
--   app_projects.deals        company, contact, outcome. Read with
--                             projects:projects:read, written with
--                             projects:tasks:write, like the task.
--   app_projects.deal_values  the amount alone. Read with projects:deals:read,
--                             written with projects:deals:write: a reader
--                             without deal access sees the deal, not its value.
-- A deal's value row is created with the task for any task writer through
-- app_projects.ensure_deal_value(task), which only ever inserts an empty
-- (NULL amount) row, only for a root task of a pipeline of the caller's org
-- that has a deals row. It takes no amount, so it cannot write one.
--
-- company_id and contact_id are soft (cross-schema, no foreign key), as
-- conversations.contact_id is: the kernel's merge and delete paths re-point or
-- clear them in their own transaction.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: the previous release never writes kind or company_id; every existing project reads 'work', which is what it is
ALTER TABLE app_projects.projects
  ADD COLUMN kind text NOT NULL DEFAULT 'work' CHECK (kind IN ('work', 'pipeline')),
  ADD COLUMN company_id uuid;
--> statement-breakpoint
-- expand-safe: a nullable column the previous release never writes; every existing row is NULL
ALTER TABLE app_projects.project_statuses
  ADD COLUMN deal_outcome text CHECK (deal_outcome IN ('won', 'lost'));
--> statement-breakpoint
-- expand-safe: deal_outcome is NULL on every existing row, so every row passes
ALTER TABLE app_projects.project_statuses
  ADD CONSTRAINT status_outcome_terminal CHECK (deal_outcome IS NULL OR terminal);
--> statement-breakpoint
CREATE TABLE app_projects.deals (
  task_id uuid PRIMARY KEY REFERENCES app_projects.tasks(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  company_id uuid,
  contact_id uuid,
  outcome text NOT NULL DEFAULT 'open' CHECK (outcome IN ('open', 'won', 'lost')),
  next_step text,
  lost_reason text,
  reopen_status_id uuid REFERENCES app_projects.project_statuses(id) ON DELETE SET NULL,
  closed_at timestamptz,
  closed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deals_closed_when_decided CHECK ((outcome = 'open') = (closed_at IS NULL))
);
--> statement-breakpoint
CREATE INDEX deals_company_idx ON app_projects.deals (org_id, company_id) WHERE company_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX deals_contact_idx ON app_projects.deals (org_id, contact_id) WHERE contact_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX deals_open_idx ON app_projects.deals (org_id, outcome, closed_at);
--> statement-breakpoint
CREATE TABLE app_projects.deal_values (
  task_id uuid PRIMARY KEY REFERENCES app_projects.deals(task_id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  amount_minor bigint,
  currency text,
  amount_period text NOT NULL DEFAULT 'once' CHECK (amount_period IN ('once', 'month', 'year')),
  probability smallint CHECK (probability BETWEEN 0 AND 100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deal_values_amount_has_currency CHECK ((amount_minor IS NULL) = (currency IS NULL))
);
--> statement-breakpoint
-- App tables belong to liaison_admin, which the app registration acts as.
ALTER TABLE app_projects.deals OWNER TO liaison_admin;
--> statement-breakpoint
ALTER TABLE app_projects.deal_values OWNER TO liaison_admin;
--> statement-breakpoint
ALTER TABLE app_projects.deals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.deals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.deal_values ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.deal_values FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app_projects.deals, app_projects.deal_values
  TO liaison_rls, liaison_app, liaison_admin;
--> statement-breakpoint
CREATE POLICY deals_select ON app_projects.deals FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:projects:read'));
--> statement-breakpoint
CREATE POLICY deals_insert ON app_projects.deals FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:tasks:write'));
--> statement-breakpoint
CREATE POLICY deals_update ON app_projects.deals FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:tasks:write'))
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:tasks:write'));
--> statement-breakpoint
CREATE POLICY deals_delete ON app_projects.deals FOR DELETE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:tasks:write'));
--> statement-breakpoint
CREATE POLICY deal_values_select ON app_projects.deal_values FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:deals:read'));
--> statement-breakpoint
CREATE POLICY deal_values_insert ON app_projects.deal_values FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:deals:write'));
--> statement-breakpoint
CREATE POLICY deal_values_update ON app_projects.deal_values FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:deals:write'))
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:deals:write'));
--> statement-breakpoint
CREATE POLICY deal_values_delete ON app_projects.deal_values FOR DELETE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:deals:write'));
--> statement-breakpoint

-- The empty value row of a new deal, for a caller who may write tasks but not
-- amounts. Owned by liaison_definer (BYPASSRLS) with only the column rights
-- it uses. Raises 42501 for anything that is not a root task of a pipeline of
-- the caller's org with a deals row; returns false when the row exists.
GRANT USAGE ON SCHEMA app_projects TO liaison_definer;
--> statement-breakpoint
GRANT SELECT (task_id, org_id) ON app_projects.deals TO liaison_definer;
--> statement-breakpoint
GRANT SELECT (id, org_id, project_id, parent_task_id) ON app_projects.tasks TO liaison_definer;
--> statement-breakpoint
GRANT SELECT (id, org_id, kind) ON app_projects.projects TO liaison_definer;
--> statement-breakpoint
GRANT SELECT (task_id), INSERT (task_id, org_id) ON app_projects.deal_values TO liaison_definer;
--> statement-breakpoint
-- A login that is no superuser may hand a function only to a role holding
-- CREATE on its schema, so liaison_definer holds it for the hand-over.
GRANT CREATE ON SCHEMA app_projects TO liaison_definer;
--> statement-breakpoint
CREATE FUNCTION app_projects.ensure_deal_value(_task uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_org uuid := NULLIF((SELECT rls_ctx.org_id()), '')::uuid;
  v_deal_org uuid;
BEGIN
  IF v_org IS NULL OR NOT app_projects.app_has_scope('projects:tasks:write') THEN
    RAISE EXCEPTION 'deal_value_refused' USING ERRCODE = '42501';
  END IF;
  SELECT d.org_id INTO v_deal_org
    FROM app_projects.deals d
    JOIN app_projects.tasks t ON t.id = d.task_id AND t.org_id = d.org_id
    JOIN app_projects.projects p ON p.id = t.project_id AND p.org_id = t.org_id
   WHERE d.task_id = _task
     AND d.org_id = v_org
     AND t.parent_task_id IS NULL
     AND p.kind = 'pipeline';
  IF v_deal_org IS NULL THEN
    RAISE EXCEPTION 'deal_value_refused' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app_projects.deal_values (task_id, org_id)
  VALUES (_task, v_deal_org)
  ON CONFLICT (task_id) DO NOTHING;
  RETURN FOUND;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION app_projects.ensure_deal_value(uuid) OWNER TO liaison_definer;
--> statement-breakpoint
-- expand-safe: taken back from a role that held it for the hand-over above and uses it for nothing else
REVOKE CREATE ON SCHEMA app_projects FROM liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_projects.ensure_deal_value(uuid) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a privilege grant, no statement is executed
GRANT EXECUTE ON FUNCTION app_projects.ensure_deal_value(uuid) TO liaison_rls, liaison_app;
