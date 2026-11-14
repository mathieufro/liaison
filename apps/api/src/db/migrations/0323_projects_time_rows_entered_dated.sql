-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Time rows: what the dated sheet may show is decided when the row is entered.
--
-- A row joins a project's dated sheet only when it was entered while its
-- project used time and budgets with dated hours on, at or after the moment
-- dated hours were last turned on. The rule compares instants (the row's
-- created_at with the switch's dated_hours_changed_at), never a day: an entry
-- made in the morning before the switch is turned on in the afternoon stays
-- private, in every timezone. A row entered on a project without dated hours
-- stays private to its author for good, also after its task moves or merges
-- into a project that uses them (task_time.entered_dated, set when the row is
-- written and never by its author).
--
-- Moves and merges carry the rows in the same transaction, whatever door made
-- them: a task's project change re-points its rows (a trigger), and a merge
-- folds the source's rows into the target (app_projects.merge_task_time).
--
-- Turning dated hours on or off stamps its time and author in the database
-- itself, so no writer can choose the switch time.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: the previous release never reads this column; the default keeps every row private, the safe reading
ALTER TABLE app_projects.task_time
  ADD COLUMN entered_dated boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- The rows already entered on a dated project after its switch keep the sheet they were on.
UPDATE app_projects.task_time tt
   SET entered_dated = true
  FROM app_projects.project_time_plan p
  JOIN app_projects.projects pr ON pr.id = p.project_id AND pr.org_id = p.org_id
 WHERE p.project_id = tt.project_id
   AND p.org_id = tt.org_id
   AND p.dated_hours
   AND pr.time_budgets_on
   AND p.dated_hours_changed_at IS NOT NULL
   AND tt.created_at >= p.dated_hours_changed_at;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app_projects TO liaison_definer;
--> statement-breakpoint
GRANT SELECT (project_id, org_id, dated_hours) ON app_projects.project_time_plan TO liaison_definer;
--> statement-breakpoint
GRANT SELECT (id, org_id, time_budgets_on) ON app_projects.projects TO liaison_definer;
--> statement-breakpoint
GRANT SELECT (entered_dated, entered_via, changed_by, created_at, updated_at)
  ON app_projects.task_time TO liaison_definer;
--> statement-breakpoint
GRANT UPDATE (task_id, project_id, minutes, entered_dated, created_at, updated_at)
  ON app_projects.task_time TO liaison_definer;
--> statement-breakpoint
GRANT DELETE ON app_projects.task_time TO liaison_definer;
--> statement-breakpoint
GRANT SELECT (archived_at) ON app_projects.tasks TO liaison_definer;
--> statement-breakpoint
-- reviewed-dynamic: a privilege grant, no statement is executed
GRANT CREATE ON SCHEMA app_projects TO liaison_definer;
--> statement-breakpoint
-- Does this project of the caller's org use dated hours now? The person
-- entering a row may not read the plan; the answer is one boolean.
CREATE FUNCTION app_projects.project_dated_now(p_project uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM app_projects.project_time_plan p
      JOIN app_projects.projects pr ON pr.id = p.project_id AND pr.org_id = p.org_id
     WHERE p.project_id = p_project
       AND p.org_id = NULLIF((SELECT rls_ctx.org_id()), '')::uuid
       AND p.dated_hours
       AND pr.time_budgets_on);
$fn$;
--> statement-breakpoint
-- A task moved to another project takes its time rows along, in the mover's
-- transaction. The rows are other people's, so this runs as the definer.
CREATE FUNCTION app_projects.task_time_follow_task() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  UPDATE app_projects.task_time
     SET project_id = NEW.project_id, updated_at = now()
   WHERE task_id = NEW.id AND org_id = NEW.org_id AND project_id <> NEW.project_id;
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
-- A merge: each of the source's rows joins the target task. With dated hours
-- on the target, a row folds into the same person's row of the same day; without,
-- into the person's one row on the target. Otherwise it moves. A folded row is
-- on the sheet only if both parts were, and counts from the earlier entry.
-- Minutes are never capped: a fold over the most one row holds refuses the
-- whole merge. With p_check_only it writes nothing and only refuses, so a
-- caller checks before its own first write.
CREATE FUNCTION app_projects.merge_task_time(p_source uuid, p_target uuid, p_check_only boolean)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_org uuid := NULLIF((SELECT rls_ctx.org_id()), '')::uuid;
  v_target_project uuid;
  v_dated boolean;
  v_into app_projects.task_time%ROWTYPE;
  r app_projects.task_time%ROWTYPE;
  v_moved integer := 0;
BEGIN
  IF v_org IS NULL OR NOT app_projects.app_has_scope('projects:tasks:write') THEN
    RAISE EXCEPTION 'time_merge_refused' USING ERRCODE = '42501';
  END IF;
  SELECT t.project_id INTO v_target_project
    FROM app_projects.tasks t WHERE t.id = p_target AND t.org_id = v_org;
  IF v_target_project IS NULL
     OR NOT EXISTS (SELECT 1 FROM app_projects.tasks t WHERE t.id = p_source AND t.org_id = v_org) THEN
    RAISE EXCEPTION 'time_merge_refused' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(bool_or(p.dated_hours), false) INTO v_dated
    FROM app_projects.project_time_plan p
   WHERE p.project_id = v_target_project AND p.org_id = v_org;
  -- One person's rows that end as one row: all of them without dated hours,
  -- those of one day with.
  IF EXISTS (
    SELECT 1 FROM app_projects.task_time tt
     WHERE tt.org_id = v_org AND tt.task_id IN (p_source, p_target) AND tt.user_id IS NOT NULL
     GROUP BY tt.user_id, CASE WHEN v_dated THEN tt.work_date END
    HAVING sum(tt.minutes) > 44640) THEN
    RAISE EXCEPTION 'time_merge_over_limit' USING ERRCODE = '22003';
  END IF;
  IF p_check_only THEN
    RETURN 0;
  END IF;
  FOR r IN
    SELECT * FROM app_projects.task_time tt
     WHERE tt.task_id = p_source AND tt.org_id = v_org
     ORDER BY tt.work_date, tt.id
  LOOP
    v_into := NULL;
    IF r.user_id IS NOT NULL THEN
      SELECT * INTO v_into FROM app_projects.task_time tt
       WHERE tt.task_id = p_target AND tt.org_id = v_org AND tt.user_id = r.user_id
         AND (NOT v_dated OR tt.work_date = r.work_date)
       ORDER BY tt.work_date, tt.id
       LIMIT 1;
    END IF;
    IF v_into.id IS NULL THEN
      UPDATE app_projects.task_time
         SET task_id = p_target, project_id = v_target_project, updated_at = now()
       WHERE id = r.id;
    ELSE
      UPDATE app_projects.task_time
         SET minutes = v_into.minutes + r.minutes,
             entered_dated = v_into.entered_dated AND r.entered_dated,
             created_at = LEAST(v_into.created_at, r.created_at),
             updated_at = now()
       WHERE id = v_into.id;
      DELETE FROM app_projects.task_time WHERE id = r.id;
    END IF;
    v_moved := v_moved + 1;
  END LOOP;
  RETURN v_moved;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION app_projects.project_dated_now(uuid) OWNER TO liaison_definer;
--> statement-breakpoint
ALTER FUNCTION app_projects.task_time_follow_task() OWNER TO liaison_definer;
--> statement-breakpoint
ALTER FUNCTION app_projects.merge_task_time(uuid, uuid, boolean) OWNER TO liaison_definer;
--> statement-breakpoint
-- expand-safe: taken back from a role that held it for the hand-over above and uses it for nothing else
REVOKE CREATE ON SCHEMA app_projects FROM liaison_definer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_projects.project_dated_now(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_projects.task_time_follow_task() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_projects.merge_task_time(uuid, uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
-- reviewed-dynamic: a privilege grant, no statement is executed
GRANT EXECUTE ON FUNCTION app_projects.project_dated_now(uuid) TO liaison_rls;
--> statement-breakpoint
-- reviewed-dynamic: a privilege grant, no statement is executed
GRANT EXECUTE ON FUNCTION app_projects.merge_task_time(uuid, uuid, boolean) TO liaison_rls, liaison_app;
--> statement-breakpoint
-- expand-safe: the previous release moves the same rows after its commit; this only does it sooner, in the mover's transaction
CREATE TRIGGER tasks_time_rows_follow
  AFTER UPDATE OF project_id ON app_projects.tasks
  FOR EACH ROW WHEN (OLD.project_id IS DISTINCT FROM NEW.project_id)
  EXECUTE FUNCTION app_projects.task_time_follow_task();
--> statement-breakpoint
-- What a person's own transaction may not set on a time row: when it was
-- entered and whether it was entered on a dated sheet. Privileged maintenance
-- (moves, merges, a person merge, a restore) runs as another role.
CREATE FUNCTION app_projects.task_time_entry_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF current_user <> 'liaison_rls' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.entered_dated := app_projects.project_dated_now(NEW.project_id);
  ELSE
    NEW.created_at := OLD.created_at;
    NEW.entered_dated := OLD.entered_dated;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION app_projects.task_time_entry_guard() OWNER TO liaison_admin;
--> statement-breakpoint
-- expand-safe: the previous release never sets created_at or entered_dated on a person's row
CREATE TRIGGER task_time_entry_guard
  BEFORE INSERT OR UPDATE ON app_projects.task_time
  FOR EACH ROW EXECUTE FUNCTION app_projects.task_time_entry_guard();
--> statement-breakpoint
-- Turning dated hours on or off records now and the person who did it; no
-- other write moves the switch time.
CREATE FUNCTION app_projects.project_time_plan_dated_stamp() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  me uuid := NULLIF(rls_ctx.user_id(), '')::uuid;
BEGIN
  IF current_user <> 'liaison_rls' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.dated_hours THEN
      NEW.dated_hours_changed_at := now();
      NEW.dated_hours_changed_by := me;
    ELSE
      NEW.dated_hours_changed_at := NULL;
      NEW.dated_hours_changed_by := NULL;
    END IF;
  ELSIF NEW.dated_hours IS DISTINCT FROM OLD.dated_hours THEN
    NEW.dated_hours_changed_at := now();
    NEW.dated_hours_changed_by := me;
  ELSE
    NEW.dated_hours_changed_at := OLD.dated_hours_changed_at;
    NEW.dated_hours_changed_by := OLD.dated_hours_changed_by;
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
ALTER FUNCTION app_projects.project_time_plan_dated_stamp() OWNER TO liaison_admin;
--> statement-breakpoint
-- expand-safe: the previous release stamps the same now() and the same person when it turns dated hours
CREATE TRIGGER project_time_plan_dated_stamp
  BEFORE INSERT OR UPDATE ON app_projects.project_time_plan
  FOR EACH ROW EXECUTE FUNCTION app_projects.project_time_plan_dated_stamp();
--> statement-breakpoint
-- expand-safe: replaced in this transaction by a policy that shows the previous release less, never more
DROP POLICY task_time_select ON app_projects.task_time;
--> statement-breakpoint
-- expand-safe: replaced in this transaction by a policy that lets the previous release change less, never more
DROP POLICY task_time_update ON app_projects.task_time;
--> statement-breakpoint
-- A person's own rows; on a project with time and budgets and dated hours on,
-- also the rows entered on that sheet since dated hours were last turned on,
-- for the project's owner and an exact holder of projects:timesheet:read.
-- expand-safe: narrower than the policy it replaces; the previous release reads a subset of what it read
CREATE POLICY task_time_select ON app_projects.task_time FOR SELECT TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND (
    user_id = (SELECT rls_ctx.user_id())::uuid
    OR (task_time.entered_dated AND EXISTS (
      SELECT 1
        FROM app_projects.project_time_plan p
        JOIN app_projects.projects pr ON pr.id = p.project_id AND pr.org_id = p.org_id
       WHERE p.project_id = task_time.project_id
         AND p.org_id = task_time.org_id
         AND p.dated_hours
         AND pr.time_budgets_on
         AND task_time.created_at >= p.dated_hours_changed_at
         AND (pr.owner_id = (SELECT rls_ctx.user_id())::uuid
              OR app_projects.app_has_exact_scope('projects:timesheet:read'))))));
--> statement-breakpoint
-- The person, or a corrector on a dated project (the same clause as reading).
-- expand-safe: narrower than the policy it replaces; the previous release corrects a subset of what it corrected
CREATE POLICY task_time_update ON app_projects.task_time FOR UPDATE TO liaison_rls
  USING (org_id = (SELECT rls_ctx.org_id())::uuid AND (
    user_id = (SELECT rls_ctx.user_id())::uuid
    OR (task_time.entered_dated AND EXISTS (
      SELECT 1
        FROM app_projects.project_time_plan p
        JOIN app_projects.projects pr ON pr.id = p.project_id AND pr.org_id = p.org_id
       WHERE p.project_id = task_time.project_id
         AND p.org_id = task_time.org_id
         AND p.dated_hours
         AND pr.time_budgets_on
         AND task_time.created_at >= p.dated_hours_changed_at
         AND (pr.owner_id = (SELECT rls_ctx.user_id())::uuid
              OR app_projects.app_has_exact_scope('projects:timesheet:read'))))))
  WITH CHECK (org_id = (SELECT rls_ctx.org_id())::uuid AND (
    user_id = (SELECT rls_ctx.user_id())::uuid
    OR (task_time.entered_dated AND EXISTS (
      SELECT 1
        FROM app_projects.project_time_plan p
        JOIN app_projects.projects pr ON pr.id = p.project_id AND pr.org_id = p.org_id
       WHERE p.project_id = task_time.project_id
         AND p.org_id = task_time.org_id
         AND p.dated_hours
         AND pr.time_budgets_on
         AND task_time.created_at >= p.dated_hours_changed_at
         AND (pr.owner_id = (SELECT rls_ctx.user_id())::uuid
              OR app_projects.app_has_exact_scope('projects:timesheet:read'))))));
