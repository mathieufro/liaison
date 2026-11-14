-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A project's time with no cost: minutes entered over an optional date range
-- that have neither a frozen cost nor a cost rate in force on their work date.
-- Margin says how much time it could not cost, never whose. Same rule as
-- app_projects.project_time_cost: the org and the exact margin scope are
-- re-checked inside, and the answer is one number.
CREATE FUNCTION app_projects.project_time_minutes_without_rate(p_project uuid, p_from date, p_to date)
RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_org uuid := NULLIF((SELECT rls_ctx.org_id()), '')::uuid;
  v_minutes bigint;
BEGIN
  IF v_org IS NULL OR NOT app_projects.app_has_exact_scope('projects:margin:read') THEN
    RAISE EXCEPTION 'time_cost_refused' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(sum(tt.minutes), 0)::bigint
    INTO v_minutes
    FROM app_projects.task_time tt
   WHERE tt.org_id = v_org
     AND tt.project_id = p_project
     AND tt.cost_minor IS NULL
     AND (p_from IS NULL OR tt.work_date >= p_from)
     AND (p_to IS NULL OR tt.work_date <= p_to)
     AND NOT EXISTS (
       SELECT 1
         FROM app_projects.cost_rates c
        WHERE c.org_id = v_org
          AND c.user_id = tt.user_id
          AND c.effective_from <= tt.work_date);
  RETURN v_minutes;
END
$fn$;
--> statement-breakpoint
-- reviewed-dynamic: a privilege grant, no statement is executed
GRANT CREATE ON SCHEMA app_projects TO liaison_definer;
--> statement-breakpoint
ALTER FUNCTION app_projects.project_time_minutes_without_rate(uuid, date, date) OWNER TO liaison_definer;
--> statement-breakpoint
-- expand-safe: taken back from a role that held it for the hand-over above and uses it for nothing else
REVOKE CREATE ON SCHEMA app_projects FROM liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_projects.project_time_minutes_without_rate(uuid, date, date) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a privilege grant, no statement is executed
GRANT EXECUTE ON FUNCTION app_projects.project_time_minutes_without_rate(uuid, date, date) TO liaison_rls, liaison_app;
