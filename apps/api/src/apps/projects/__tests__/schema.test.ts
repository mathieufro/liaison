// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { getTableConfig } from "drizzle-orm/pg-core"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { projects, taskChecklistItems, tasks, taskTransitions } from "~/db/schema/app_projects"
import manifest from "../app.manifest.json"

const snake = (s: string) => s.replace(/([A-Z])/g, "_$1").toLowerCase()

async function listTables(schema: string): Promise<string[]> {
  const rows = extractRows<{ table_name: string }>(
    await db.execute(drizzleSql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema}
      ORDER BY table_name
    `),
  )
  return rows.map((r) => r.table_name)
}

async function listColumns(
  schema: string,
  table: string,
): Promise<Record<string, { data_type: string; is_nullable: string }>> {
  const rows = extractRows<{ column_name: string; data_type: string; is_nullable: string }>(
    await db.execute(drizzleSql`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = ${table}
    `),
  )
  const out: Record<string, { data_type: string; is_nullable: string }> = {}
  for (const r of rows) out[r.column_name] = { data_type: r.data_type, is_nullable: r.is_nullable }
  return out
}

describe("projects.schema", () => {
  it("projects.schema.tables-exist", async () => {
    const tables = await listTables("app_projects")
    expect(tables.sort()).toEqual([
      "billing_claims",
      "cost_rates",
      "days_off",
      "deal_values",
      "deals",
      "labels",
      "person_capacity",
      "project_billing_terms",
      "project_statuses",
      "project_templates",
      "project_time_plan",
      "project_timeboxes",
      "projects",
      "reconciliation_lines",
      "reconciliation_proofs",
      "reconciliations",
      "task_checklist_items",
      "task_dependencies",
      "task_labels",
      "task_time",
      "task_transitions",
      "tasks",
      "time_settings",
    ])
  })

  it("projects.schema.tasks-have-position-and-parent-fk", async () => {
    const cols = await listColumns("app_projects", "tasks")
    expect(cols.position).toBeDefined()
    expect(cols.parent_task_id).toBeDefined()
    expect(cols.position.data_type).toBe("double precision")
  })

  it("projects.schema.rls-enabled", async () => {
    const rows = extractRows<{
      relname: string
      relrowsecurity: boolean
      relforcerowsecurity: boolean
    }>(
      await db.execute(drizzleSql`
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app_projects' AND c.relname IN ('projects', 'project_statuses', 'tasks', 'task_checklist_items', 'labels', 'task_labels', 'task_transitions')
      `),
    )
    expect(rows).toHaveLength(7)
    for (const r of rows) {
      expect(r.relrowsecurity).toBe(true)
      expect(r.relforcerowsecurity).toBe(true)
    }
  })

  it("projects.schema.checklist-manifest-drizzle-db-agree", async () => {
    const schema = manifest.schema as Record<string, { fields: Record<string, unknown> }>
    const pairs = [
      { table: "task_checklist_items", drizzle: taskChecklistItems },
      { table: "projects", drizzle: projects },
      { table: "tasks", drizzle: tasks },
      { table: "task_transitions", drizzle: taskTransitions },
    ] as const
    const added: Record<string, string[]> = {
      task_checklist_items: [
        "task_id",
        "position",
        "title",
        "details",
        "checked",
        "validations",
        "created_by",
      ],
      projects: [
        "validation_levels",
        "checklist_on_cards",
        "time_budgets_on",
        "time_budgets_changed_by",
        "time_budgets_changed_at",
        "task_fields",
      ],
      tasks: ["release", "timebox_minutes", "is_milestone", "fields"],
      task_transitions: ["task_id", "from_status_id", "to_status_id", "actor_type", "at"],
    }
    for (const { table, drizzle } of pairs) {
      const entity = schema[table]
      expect(entity).toBeDefined()
      const manifestCols = new Set(Object.keys(entity!.fields).map(snake))
      const drizzleCols = new Map(
        getTableConfig(drizzle).columns.map((c) => [c.name, c.notNull] as const),
      )
      const live = await listColumns("app_projects", table)
      for (const col of added[table]!) {
        expect({ table, col, manifest: manifestCols.has(col) }).toEqual({
          table,
          col,
          manifest: true,
        })
        expect({ table, col, drizzle: drizzleCols.has(col) }).toEqual({ table, col, drizzle: true })
        expect({ table, col, live: live[col] !== undefined }).toEqual({ table, col, live: true })
        expect({ table, col, notNull: drizzleCols.get(col) }).toEqual({
          table,
          col,
          notNull: live[col]!.is_nullable === "NO",
        })
      }
      // Every manifest field of the new table is a real column in Drizzle.
      if (table === "task_checklist_items") {
        for (const col of manifestCols) expect(drizzleCols.has(col)).toBe(true)
      }
    }
  })
})
