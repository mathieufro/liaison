-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Time and budgets in Projects, project by project.
--
-- A work project may turn on time and budgets (projects.time_budgets_on, off
-- by default; a pipeline never holds it). Tasks gain a timebox and a
-- milestone mark. New tables, all in app_projects, RLS enabled and forced:
--   time_settings          hours in a day, the shared days-off calendar
--   person_capacity        days per week per person (no row reads 5)
--   project_time_plan      basis, project timebox, biller, dated hours, repos
--   project_billing_terms  rate or fixed price, behind projects:money:*
--   project_timeboxes      a timebox per period
--   task_time              the minutes a person took on a task, on a day
--   cost_rates             a person's cost rate from a date
--   days_off               company days off
--
-- task_time is private to its person. Nobody else reads a row, whatever they
-- hold, except on a project with time and budgets and dated hours on, where
-- the project's owner and an exact holder of projects:timesheet:read read and
-- correct the rows whose work date is on or after the day dated hours were
-- turned on: a later switch never opens earlier rows. Exact means the scope
-- itself is granted: `*` and `projects:*` do not stand for it
-- (app_projects.app_has_exact_scope). Totals per task, with no person in
-- them, come from app_projects.task_time_totals; a project's cost from
-- app_projects.project_time_cost. cost_rates is read and written by exact
-- scope only.
--
-- Forward only, no backfill: every existing project reads off, every task
-- has no timebox and no milestone, and the new tables start empty.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- An exact grant check: the scope itself must be granted. No `*`, no
-- `<app>:*`, no prefix grant stands for it.
CREATE FUNCTION app_projects.app_has_exact_scope(_scope TEXT) RETURNS boolean AS $FUNCTION_BODY$
  SELECT COALESCE(
    _scope <> '' AND _scope = ANY (string_to_array(rls_ctx.scopes(), ',')),
    false
  );
$FUNCTION_BODY$ LANGUAGE sql STABLE;
--> statement-breakpoint
ALTER FUNCTION app_projects.app_has_exact_scope(TEXT) OWNER TO liaison_admin;
--> statement-breakpoint
-- reviewed-dynamic: a privilege grant, no statement is executed
GRANT EXECUTE ON FUNCTION app_projects.app_has_exact_scope(TEXT)
  TO liaison_rls, liaison_app, liaison_admin, liaison_definer;
--> statement-breakpoint
-- expand-safe: the previous release never writes these columns; every existing project reads off, which is what it is
ALTER TABLE app_projects.projects
  ADD COLUMN time_budgets_on boolean NOT NULL DEFAULT false,
  ADD COLUMN time_budgets_changed_by uuid,
  ADD COLUMN time_budgets_changed_at timestamptz;
--> statement-breakpoint
-- expand-safe: time_budgets_on is false on every existing row, so every row passes
ALTER TABLE app_projects.projects
  ADD CONSTRAINT projects_time_budgets_work_only CHECK (NOT time_budgets_on OR kind = 'work');
--> statement-breakpoint
-- expand-safe: the previous release never writes these columns; every existing task has no timebox and is no milestone
ALTER TABLE app_projects.tasks
  ADD COLUMN timebox_minutes integer CONSTRAINT tasks_timebox_minutes_positive CHECK (timebox_minutes > 0),
  ADD COLUMN is_milestone boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- index-build: app_projects.tasks 20000 2
CREATE INDEX idx_tasks_assignee_timebox ON app_projects.tasks (org_id, assignee_id)
  WHERE timebox_minutes IS NOT NULL AND archived_at IS NULL;
--> statement-breakpoint
CREATE TABLE app_projects.time_settings (
  org_id uuid PRIMARY KEY,
  hours_per_day_minutes integer NOT NULL DEFAULT 420
    CHECK (hours_per_day_minutes BETWEEN 60 AND 1440),
  days_off_calendar_id uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE app_projects.person_capacity (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  days_per_week smallint NOT NULL CHECK (days_per_week BETWEEN 1 AND 5),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
--> statement-breakpoint
CREATE INDEX person_capacity_user_idx ON app_projects.person_capacity (user_id);
--> statement-breakpoint
CREATE TABLE app_projects.project_time_plan (
  project_id uuid PRIMARY KEY REFERENCES app_projects.projects(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  basis text NOT NULL DEFAULT 'none'
    CHECK (basis IN ('none', 'hourly', 'daily', 'fixed', 'retainer')),
  timebox_minutes integer CHECK (timebox_minutes > 0),
  biller_id uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  dated_hours boolean NOT NULL DEFAULT false,
  dated_hours_changed_by uuid,
  dated_hours_changed_at timestamptz,
  source_repos jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX project_time_plan_biller_idx ON app_projects.project_time_plan (biller_id)
  WHERE biller_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE app_projects.project_billing_terms (
  project_id uuid PRIMARY KEY REFERENCES app_projects.projects(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  rate_minor bigint CHECK (rate_minor >= 0),
  fixed_price_minor bigint CHECK (fixed_price_minor >= 0),
  currency char(3),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE app_projects.project_timeboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES app_projects.projects(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  minutes integer NOT NULL CHECK (minutes > 0),
  source text NOT NULL CHECK (source IN ('manual', 'retainer')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_timeboxes_period_order CHECK (period_end >= period_start)
);
--> statement-breakpoint
CREATE UNIQUE INDEX project_timeboxes_period_uidx
  ON app_projects.project_timeboxes (org_id, project_id, period_start);
--> statement-breakpoint
CREATE INDEX project_timeboxes_project_idx ON app_projects.project_timeboxes (project_id);
--> statement-breakpoint
CREATE TABLE app_projects.task_time (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  task_id uuid NOT NULL REFERENCES app_projects.tasks(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES app_projects.projects(id) ON DELETE CASCADE,
  user_id uuid REFERENCES kernel.users(id) ON DELETE SET NULL,
  work_date date NOT NULL,
  minutes integer NOT NULL CHECK (minutes > 0 AND minutes <= 44640),
  entered_via text NOT NULL CHECK (entered_via IN ('field', 'agent', 'mcp')),
  changed_by uuid,
  cost_minor bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX task_time_person_day_uidx
  ON app_projects.task_time (org_id, task_id, user_id, work_date);
--> statement-breakpoint
CREATE INDEX task_time_project_day_idx ON app_projects.task_time (org_id, project_id, work_date);
--> statement-breakpoint
CREATE INDEX task_time_task_idx ON app_projects.task_time (task_id);
--> statement-breakpoint
CREATE INDEX task_time_user_idx ON app_projects.task_time (user_id) WHERE user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX task_time_project_idx ON app_projects.task_time (project_id);
--> statement-breakpoint
CREATE TABLE app_projects.cost_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES kernel.users(id) ON DELETE CASCADE,
  rate_minor bigint NOT NULL CHECK (rate_minor >= 0),
  currency char(3),
  effective_from date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX cost_rates_person_from_uidx
  ON app_projects.cost_rates (org_id, user_id, effective_from);
--> statement-breakpoint
CREATE INDEX cost_rates_user_idx ON app_projects.cost_rates (user_id);
--> statement-breakpoint
CREATE TABLE app_projects.days_off (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  recurs_yearly boolean NOT NULL DEFAULT false,
  label text CHECK (char_length(label) <= 60),
  source_event_id uuid,
  created_by uuid,
  created_via text CHECK (created_via IN ('settings', 'agent', 'calendar')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT days_off_order CHECK (ends_on >= starts_on),
  CONSTRAINT days_off_yearly_span CHECK (NOT recurs_yearly OR ends_on - starts_on <= 31)
);
--> statement-breakpoint
CREATE UNIQUE INDEX days_off_span_uidx
  ON app_projects.days_off (org_id, starts_on, ends_on, recurs_yearly);
--> statement-breakpoint
-- App tables belong to liaison_admin, which the app registration acts as.
ALTER TABLE app_projects.time_settings OWNER TO liaison_admin;
--> statement-breakpoint
ALTER TABLE app_projects.person_capacity OWNER TO liaison_admin;
--> statement-breakpoint
ALTER TABLE app_projects.project_time_plan OWNER TO liaison_admin;
--> statement-breakpoint
ALTER TABLE app_projects.project_billing_terms OWNER TO liaison_admin;
--> statement-breakpoint
ALTER TABLE app_projects.project_timeboxes OWNER TO liaison_admin;
--> statement-breakpoint
ALTER TABLE app_projects.task_time OWNER TO liaison_admin;
--> statement-breakpoint
ALTER TABLE app_projects.cost_rates OWNER TO liaison_admin;
--> statement-breakpoint
ALTER TABLE app_projects.days_off OWNER TO liaison_admin;
--> statement-breakpoint
ALTER TABLE app_projects.time_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.time_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.person_capacity ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.person_capacity FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.project_time_plan ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.project_time_plan FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.project_billing_terms ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.project_billing_terms FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.project_timeboxes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.project_timeboxes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.task_time ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.task_time FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.cost_rates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.cost_rates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.days_off ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app_projects.days_off FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
  app_projects.time_settings, app_projects.person_capacity, app_projects.project_time_plan,
  app_projects.project_billing_terms, app_projects.project_timeboxes, app_projects.task_time,
  app_projects.cost_rates, app_projects.days_off
  TO liaison_rls, liaison_app, liaison_admin;
--> statement-breakpoint
CREATE POLICY time_settings_select ON app_projects.time_settings FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:projects:read'));
--> statement-breakpoint
CREATE POLICY time_settings_insert ON app_projects.time_settings FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:settings:admin'));
--> statement-breakpoint
CREATE POLICY time_settings_update ON app_projects.time_settings FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:settings:admin'))
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:settings:admin'));
--> statement-breakpoint
CREATE POLICY time_settings_delete ON app_projects.time_settings FOR DELETE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:settings:admin'));
--> statement-breakpoint
-- Days per week: read like the projects; set by the person, or by whoever
-- manages people or capacity. The tool holds the rest of the rule.
CREATE POLICY person_capacity_select ON app_projects.person_capacity FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:projects:read'));
--> statement-breakpoint
CREATE POLICY person_capacity_insert ON app_projects.person_capacity FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND (
    user_id = (SELECT rls_ctx.user_id())::uuid
    OR app_projects.app_has_scope('kernel:users:admin')
    OR app_projects.app_has_scope('projects:capacity:write')));
--> statement-breakpoint
CREATE POLICY person_capacity_update ON app_projects.person_capacity FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND (
    user_id = (SELECT rls_ctx.user_id())::uuid
    OR app_projects.app_has_scope('kernel:users:admin')
    OR app_projects.app_has_scope('projects:capacity:write')))
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND (
    user_id = (SELECT rls_ctx.user_id())::uuid
    OR app_projects.app_has_scope('kernel:users:admin')
    OR app_projects.app_has_scope('projects:capacity:write')));
--> statement-breakpoint
CREATE POLICY person_capacity_delete ON app_projects.person_capacity FOR DELETE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND (
    user_id = (SELECT rls_ctx.user_id())::uuid
    OR app_projects.app_has_scope('kernel:users:admin')
    OR app_projects.app_has_scope('projects:capacity:write')));
--> statement-breakpoint
CREATE POLICY project_time_plan_select ON app_projects.project_time_plan FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:projects:read'));
--> statement-breakpoint
CREATE POLICY project_time_plan_insert ON app_projects.project_time_plan FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:projects:write'));
--> statement-breakpoint
CREATE POLICY project_time_plan_update ON app_projects.project_time_plan FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:projects:write'))
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:projects:write'));
--> statement-breakpoint
CREATE POLICY project_time_plan_delete ON app_projects.project_time_plan FOR DELETE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:projects:write'));
--> statement-breakpoint
CREATE POLICY project_billing_terms_select ON app_projects.project_billing_terms FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:money:read'));
--> statement-breakpoint
CREATE POLICY project_billing_terms_insert ON app_projects.project_billing_terms FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:money:write'));
--> statement-breakpoint
CREATE POLICY project_billing_terms_update ON app_projects.project_billing_terms FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:money:write'))
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:money:write'));
--> statement-breakpoint
CREATE POLICY project_billing_terms_delete ON app_projects.project_billing_terms FOR DELETE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:money:write'));
--> statement-breakpoint
CREATE POLICY project_timeboxes_select ON app_projects.project_timeboxes FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:projects:read'));
--> statement-breakpoint
CREATE POLICY project_timeboxes_insert ON app_projects.project_timeboxes FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:projects:write'));
--> statement-breakpoint
CREATE POLICY project_timeboxes_update ON app_projects.project_timeboxes FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:projects:write'))
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:projects:write'));
--> statement-breakpoint
CREATE POLICY project_timeboxes_delete ON app_projects.project_timeboxes FOR DELETE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:projects:write'));
--> statement-breakpoint
-- A person's own rows; on a project with time and budgets and dated hours on,
-- also the rows from the day dated hours were turned on, for the project's
-- owner and an exact holder of projects:timesheet:read.
CREATE POLICY task_time_select ON app_projects.task_time FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND (
    user_id = (SELECT rls_ctx.user_id())::uuid
    OR EXISTS (
      SELECT 1
        FROM app_projects.project_time_plan p
        JOIN app_projects.projects pr ON pr.id = p.project_id AND pr.org_id = p.org_id
       WHERE p.project_id = task_time.project_id
         AND p.org_id = task_time.org_id
         AND p.dated_hours
         AND pr.time_budgets_on
         AND task_time.work_date >= (p.dated_hours_changed_at AT TIME ZONE 'UTC')::date
         AND (pr.owner_id = (SELECT rls_ctx.user_id())::uuid
              OR app_projects.app_has_exact_scope('projects:timesheet:read')))));
--> statement-breakpoint
CREATE POLICY task_time_insert ON app_projects.task_time FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid
    AND user_id = (SELECT rls_ctx.user_id())::uuid
    AND app_projects.app_has_scope('projects:tasks:write'));
--> statement-breakpoint
-- The person, or a corrector on a dated project (the same clause as reading).
CREATE POLICY task_time_update ON app_projects.task_time FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND (
    user_id = (SELECT rls_ctx.user_id())::uuid
    OR EXISTS (
      SELECT 1
        FROM app_projects.project_time_plan p
        JOIN app_projects.projects pr ON pr.id = p.project_id AND pr.org_id = p.org_id
       WHERE p.project_id = task_time.project_id
         AND p.org_id = task_time.org_id
         AND p.dated_hours
         AND pr.time_budgets_on
         AND task_time.work_date >= (p.dated_hours_changed_at AT TIME ZONE 'UTC')::date
         AND (pr.owner_id = (SELECT rls_ctx.user_id())::uuid
              OR app_projects.app_has_exact_scope('projects:timesheet:read')))))
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND (
    user_id = (SELECT rls_ctx.user_id())::uuid
    OR EXISTS (
      SELECT 1
        FROM app_projects.project_time_plan p
        JOIN app_projects.projects pr ON pr.id = p.project_id AND pr.org_id = p.org_id
       WHERE p.project_id = task_time.project_id
         AND p.org_id = task_time.org_id
         AND p.dated_hours
         AND pr.time_budgets_on
         AND task_time.work_date >= (p.dated_hours_changed_at AT TIME ZONE 'UTC')::date
         AND (pr.owner_id = (SELECT rls_ctx.user_id())::uuid
              OR app_projects.app_has_exact_scope('projects:timesheet:read')))));
--> statement-breakpoint
CREATE POLICY task_time_delete ON app_projects.task_time FOR DELETE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND user_id = (SELECT rls_ctx.user_id())::uuid);
--> statement-breakpoint
CREATE POLICY cost_rates_select ON app_projects.cost_rates FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_exact_scope('projects:margin:read'));
--> statement-breakpoint
CREATE POLICY cost_rates_insert ON app_projects.cost_rates FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_exact_scope('projects:cost_rates:write'));
--> statement-breakpoint
CREATE POLICY cost_rates_update ON app_projects.cost_rates FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_exact_scope('projects:cost_rates:write'))
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_exact_scope('projects:cost_rates:write'));
--> statement-breakpoint
CREATE POLICY cost_rates_delete ON app_projects.cost_rates FOR DELETE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_exact_scope('projects:cost_rates:write'));
--> statement-breakpoint
CREATE POLICY days_off_select ON app_projects.days_off FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:projects:read'));
--> statement-breakpoint
CREATE POLICY days_off_insert ON app_projects.days_off FOR INSERT TO liaison_rls
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:settings:admin'));
--> statement-breakpoint
CREATE POLICY days_off_update ON app_projects.days_off FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:settings:admin'))
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:settings:admin'));
--> statement-breakpoint
CREATE POLICY days_off_delete ON app_projects.days_off FOR DELETE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND app_projects.app_has_scope('projects:settings:admin'));
--> statement-breakpoint

-- Totals and cost, for callers who may not read the rows. Owned by
-- liaison_definer (BYPASSRLS) with only the column rights they use. Each
-- re-checks the org and the scope and raises 42501 when either fails.
GRANT USAGE ON SCHEMA app_projects TO liaison_definer;
--> statement-breakpoint
GRANT SELECT (id, org_id, task_id, project_id, user_id, work_date, minutes, cost_minor)
  ON app_projects.task_time TO liaison_definer;
--> statement-breakpoint
GRANT SELECT (org_id, user_id, rate_minor, effective_from) ON app_projects.cost_rates TO liaison_definer;
--> statement-breakpoint
GRANT SELECT (id, org_id, project_id) ON app_projects.tasks TO liaison_definer;
--> statement-breakpoint
-- reviewed-dynamic: a privilege grant, no statement is executed
GRANT EXECUTE ON FUNCTION app_projects.app_has_scope(TEXT) TO liaison_definer;
--> statement-breakpoint
-- A login that is no superuser may hand a function only to a role holding
-- CREATE on its schema, so liaison_definer holds it for the hand-over.
GRANT CREATE ON SCHEMA app_projects TO liaison_definer;
--> statement-breakpoint
-- Minutes per task of a project, over an optional date range, with no person
-- in the answer. Every task of the project has a row: 0 and false when it has
-- no time.
CREATE FUNCTION app_projects.task_time_totals(p_project uuid, p_from date, p_to date)
RETURNS TABLE (task_id uuid, minutes bigint, has_entries boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
#variable_conflict use_column
DECLARE
  v_org uuid := NULLIF((SELECT rls_ctx.org_id()), '')::uuid;
BEGIN
  IF v_org IS NULL OR NOT app_projects.app_has_scope('projects:projects:read') THEN
    RAISE EXCEPTION 'time_totals_refused' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT t.id,
         COALESCE(sum(tt.minutes), 0)::bigint,
         count(tt.id) > 0
    FROM app_projects.tasks t
    LEFT JOIN app_projects.task_time tt
      ON tt.task_id = t.id
     AND tt.org_id = v_org
     AND (p_from IS NULL OR tt.work_date >= p_from)
     AND (p_to IS NULL OR tt.work_date <= p_to)
   WHERE t.project_id = p_project
     AND t.org_id = v_org
   GROUP BY t.id;
END
$fn$;
--> statement-breakpoint
-- A project's cost over an optional date range: a row's frozen cost_minor
-- when it has one, else its minutes at the person's rate in force on its work
-- date; a row with neither counts 0.
CREATE FUNCTION app_projects.project_time_cost(p_project uuid, p_from date, p_to date)
RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_org uuid := NULLIF((SELECT rls_ctx.org_id()), '')::uuid;
  v_cost bigint;
BEGIN
  IF v_org IS NULL OR NOT app_projects.app_has_exact_scope('projects:margin:read') THEN
    RAISE EXCEPTION 'time_cost_refused' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(sum(COALESCE(
           tt.cost_minor,
           round(tt.minutes::numeric * r.rate_minor / 60)::bigint,
           0)), 0)::bigint
    INTO v_cost
    FROM app_projects.task_time tt
    LEFT JOIN LATERAL (
      SELECT c.rate_minor
        FROM app_projects.cost_rates c
       WHERE c.org_id = v_org
         AND c.user_id = tt.user_id
         AND c.effective_from <= tt.work_date
       ORDER BY c.effective_from DESC
       LIMIT 1
    ) r ON true
   WHERE tt.org_id = v_org
     AND tt.project_id = p_project
     AND (p_from IS NULL OR tt.work_date >= p_from)
     AND (p_to IS NULL OR tt.work_date <= p_to);
  RETURN v_cost;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION app_projects.task_time_totals(uuid, date, date) OWNER TO liaison_definer;
--> statement-breakpoint
ALTER FUNCTION app_projects.project_time_cost(uuid, date, date) OWNER TO liaison_definer;
--> statement-breakpoint
-- expand-safe: taken back from a role that held it for the hand-over above and uses it for nothing else
REVOKE CREATE ON SCHEMA app_projects FROM liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_projects.task_time_totals(uuid, date, date) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_projects.project_time_cost(uuid, date, date) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a privilege grant, no statement is executed
GRANT EXECUTE ON FUNCTION app_projects.task_time_totals(uuid, date, date) TO liaison_rls, liaison_app;
--> statement-breakpoint
-- reviewed-dynamic: a privilege grant, no statement is executed
GRANT EXECUTE ON FUNCTION app_projects.project_time_cost(uuid, date, date) TO liaison_rls, liaison_app;
