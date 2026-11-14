-- SPDX-License-Identifier: FSL-1.1-ALv2
-- Reconcile lines: the project a line's work belongs to, when it is not this one.
--
-- A line of a reconcile card can say its task was done for another client
-- (reason 'other_client'). The card then offers to move that task to the
-- project it belongs to, so the line keeps the project it names. The project
-- is read under the asker's own rows when the line is saved; deleting that
-- project leaves the line without one.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: the previous release never reads this column; a line without it offers no move, as before
ALTER TABLE app_projects.reconciliation_lines
  ADD COLUMN other_project_id uuid REFERENCES app_projects.projects(id) ON DELETE SET NULL;
