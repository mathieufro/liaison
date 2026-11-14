-- SPDX-License-Identifier: FSL-1.1-ALv2
-- The currencies a project's time cost is in.
--
-- A cost rate carries its own currency, so a project's time at cost can mix
-- currencies, and a sum of minor units in two currencies is no amount. Margin
-- asks which currencies the costed time is in before it subtracts anything,
-- and refuses a mix. A row's frozen cost keeps the currency of the rate it was
-- frozen from (task_time.cost_currency, set by the same sweep; a row frozen
-- before it, whose person is gone, reads as the org's currency). Same rule as
-- app_projects.project_time_cost: the org and the exact margin scope are
-- re-checked inside, and the answer names currencies, never people.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: the previous release never reads this column; null means the org's currency, as a rate without one does
ALTER TABLE app_projects.task_time ADD COLUMN cost_currency text;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app_projects TO liaison_definer;
--> statement-breakpoint
GRANT SELECT (cost_currency) ON app_projects.task_time TO liaison_definer;
--> statement-breakpoint
GRANT SELECT (currency) ON app_projects.cost_rates TO liaison_definer;
--> statement-breakpoint
-- The distinct currencies of the costed time over an optional date range: a
-- frozen row's cost_currency, else the currency of the rate in force on its
-- work date. Time with no cost, and a rate with no currency, add none.
CREATE FUNCTION app_projects.project_time_cost_currencies(p_project uuid, p_from date, p_to date)
RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_org uuid := NULLIF((SELECT rls_ctx.org_id()), '')::uuid;
  v_currencies text[];
BEGIN
  IF v_org IS NULL OR NOT app_projects.app_has_exact_scope('projects:margin:read') THEN
    RAISE EXCEPTION 'time_cost_refused' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT x.currency ORDER BY x.currency), '{}'::text[])
    INTO v_currencies
    FROM (
      SELECT CASE WHEN tt.cost_minor IS NOT NULL THEN tt.cost_currency ELSE r.currency END
               AS currency
        FROM app_projects.task_time tt
        LEFT JOIN LATERAL (
          SELECT c.rate_minor, c.currency
            FROM app_projects.cost_rates c
           WHERE c.org_id = v_org
             AND c.user_id = tt.user_id
             AND c.effective_from <= tt.work_date
           ORDER BY c.effective_from DESC
           LIMIT 1
        ) r ON true
       WHERE tt.org_id = v_org
         AND tt.project_id = p_project
         AND (tt.cost_minor IS NOT NULL OR r.rate_minor IS NOT NULL)
         AND (p_from IS NULL OR tt.work_date >= p_from)
         AND (p_to IS NULL OR tt.work_date <= p_to)
    ) x
   WHERE x.currency IS NOT NULL;
  RETURN v_currencies;
END
$fn$;
--> statement-breakpoint
-- reviewed-dynamic: a privilege grant, no statement is executed
GRANT CREATE ON SCHEMA app_projects TO liaison_definer;
--> statement-breakpoint
ALTER FUNCTION app_projects.project_time_cost_currencies(uuid, date, date) OWNER TO liaison_definer;
--> statement-breakpoint
-- expand-safe: taken back from a role that held it for the hand-over above and uses it for nothing else
REVOKE CREATE ON SCHEMA app_projects FROM liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_projects.project_time_cost_currencies(uuid, date, date) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a privilege grant, no statement is executed
GRANT EXECUTE ON FUNCTION app_projects.project_time_cost_currencies(uuid, date, date) TO liaison_rls, liaison_app;
