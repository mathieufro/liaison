// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Rows the whole-org archive leaves out because the admin who downloads it may
 * not read them: the archive holds what an admin's own view holds. People's time
 * is private to its author except on a project's dated sheet; a proposed
 * reconciliation is its creator's alone; a person's cost rate reaches anyone else
 * only as a project's cost. A full copy of these tables moves only with an
 * instance transfer, operator to operator (`modules/org/transfer`).
 *
 * Each rule is a SQL predicate on the exported row (alias `t`), added to the
 * org filter. Keys are `<logical schema>.<table>`.
 */
import { schemaRef } from "~/db/schema-ref"

export interface WithheldRows {
  why: string
  /** The rows kept, as a predicate on alias `t`; `false` keeps none. */
  keep: () => string
}

const P = () => schemaRef("app_projects")

/** A time row on its project's dated sheet (the row policy's own clause, for any reader). */
const onDatedSheet = () => `t.entered_dated AND EXISTS (
  SELECT 1 FROM ${P()}.project_time_plan p
    JOIN ${P()}.projects pr ON pr.id = p.project_id AND pr.org_id = p.org_id
   WHERE p.project_id = t.project_id AND p.org_id = t.org_id
     AND p.dated_hours AND pr.time_budgets_on
     AND t.created_at >= p.dated_hours_changed_at)`

const notProposed = (reconciliationRef: string) => `EXISTS (
  SELECT 1 FROM ${P()}.reconciliations r
   WHERE r.id = ${reconciliationRef} AND r.org_id = t.org_id AND r.state <> 'proposed')`

export const WITHHELD_ROWS: Readonly<Record<string, WithheldRows>> = {
  "app_projects.task_time": {
    why: "a person's own time, except the rows on a project's dated sheet",
    keep: onDatedSheet,
  },
  "app_projects.cost_rates": {
    why: "a person's cost rate; a project's cost is what finance reads",
    keep: () => "false",
  },
  "app_projects.reconciliations": {
    why: "a proposed reconciliation is its creator's alone",
    keep: () => "t.state <> 'proposed'",
  },
  "app_projects.reconciliation_lines": {
    why: "the lines of a proposed reconciliation",
    keep: () => notProposed("t.reconciliation_id"),
  },
  "app_projects.reconciliation_proofs": {
    why: "the proofs of a proposed reconciliation's lines",
    keep: () => `EXISTS (
      SELECT 1 FROM ${P()}.reconciliation_lines l
       WHERE l.id = t.line_id AND l.org_id = t.org_id AND ${notProposed("l.reconciliation_id")})`,
  },
}
