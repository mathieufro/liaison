// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One writer for a deal's outcome. A deal's outcome follows the stage its task
// sits in, and `syncDealOutcome` (service/deals.ts) is the only code that
// writes it. This guard reads the api source and fails when:
//   - a function writes a projects task's status (an UPDATE setting
//     `status_id`, an INSERT into the tasks table, a query-builder `.set` of
//     `statusId`) without calling `syncDealOutcome`, or
//   - any file other than service/deals.ts writes a deal's `outcome`,
//     `closed_at`, `closed_by` or `lost_reason`.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const API_SRC = path.resolve(import.meta.dir, "../../..")
const WRITER = path.join(API_SRC, "apps/projects/service/deals.ts")

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "migrations") continue
      sourceFiles(full, out)
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(full)
    }
  }
  return out
}

const TOUCHES_TASKS = /projectsRel\("tasks"\)|app_projects"?\."?tasks\b|schema\/app_projects/
const FUNCTION_START = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm

/** Line offsets where a projects task's status is written. */
function statusWrites(src: string): number[] {
  const at: number[] = []
  const lineWrite =
    /^[ \t]*(?:SET[ \t]+)?status_id[ \t]*=[ \t]*\$\{|sets\.push\(drizzleSql`status_id[ \t]*=/gm
  for (const m of src.matchAll(lineWrite)) at.push(m.index ?? 0)
  const insert =
    /INSERT\s+INTO\s+(?:\$\{projectsRel\("tasks"\)\}|"?app_projects"?\."?tasks"?)\s*\(([^)]*)\)/g
  for (const m of src.matchAll(insert)) if (/\bstatus_id\b/.test(m[1] ?? "")) at.push(m.index ?? 0)
  for (const m of src.matchAll(/\.set\(\{[^}]*\bstatusId\b/g)) at.push(m.index ?? 0)
  return at
}

/** Functions (by name) that write a task status and never call the writer. */
function unsyncedStatusWrites(src: string): string[] {
  if (!TOUCHES_TASKS.test(src)) return []
  const starts = [...src.matchAll(FUNCTION_START)].map((m) => ({
    name: m[1] ?? "?",
    index: m.index ?? 0,
  }))
  const missing = new Set<string>()
  for (const offset of statusWrites(src)) {
    const i = starts.findLastIndex((s) => s.index <= offset)
    const start = i >= 0 ? starts[i]!.index : 0
    const end = i >= 0 && i + 1 < starts.length ? starts[i + 1]!.index : src.length
    const body = src.slice(start, end)
    if (!/\bsyncDealOutcome\(/.test(body)) missing.add(i >= 0 ? starts[i]!.name : "<module>")
  }
  return [...missing]
}

/** True when the source writes a deal's outcome or close stamps. */
function writesDealOutcome(src: string): boolean {
  const sqlWrite =
    /(?:UPDATE|INSERT\s+INTO)\s+(?:\$\{projectsRel\("deals"\)\}|"?app_projects"?\."?deals"?\b)([\s\S]*?)(?:WHERE|RETURNING|`)/g
  for (const m of src.matchAll(sqlWrite)) {
    if (/\b(?:outcome|closed_at|closed_by|lost_reason)\b/.test(m[1] ?? "")) return true
  }
  return /\.(?:update|insert)\(\s*deals\s*\)[\s\S]{0,400}?\b(?:outcome|closedAt|closedBy|lostReason)\b/.test(
    src,
  )
}

describe("deal outcome writer", () => {
  const files = sourceFiles(API_SRC)

  it("every status write in the projects service syncs the deal outcome", () => {
    const found: string[] = []
    for (const file of files) {
      for (const fn of unsyncedStatusWrites(readFileSync(file, "utf8"))) {
        found.push(`${path.relative(API_SRC, file)}: ${fn}`)
      }
    }
    expect(found).toEqual([])
    // The scan sees the writes it is meant to see.
    const service = path.join(API_SRC, "apps/projects/service")
    const seen = ["move-task.ts", "tasks.ts", "statuses.ts"].map(
      (f) => statusWrites(readFileSync(path.join(service, f), "utf8")).length,
    )
    expect(seen.every((n) => n > 0)).toBe(true)
  })

  it("only the outcome writer writes a deal's outcome", () => {
    const writers = files
      .filter((file) => writesDealOutcome(readFileSync(file, "utf8")))
      .map((file) => path.relative(API_SRC, file))
    expect(writers).toEqual([path.relative(API_SRC, WRITER)])
  })

  it("flags a status write that skips the writer and an outcome written elsewhere", () => {
    const bad = `export async function sneakyMove(tx) {
  await tx.execute(drizzleSql\`
    UPDATE \${projectsRel("tasks")}
    SET status_id = \${next}::uuid
    WHERE id = \${id}::uuid\`)
}
export async function fine(tx) {
  await tx.execute(drizzleSql\`UPDATE \${projectsRel("tasks")}
    SET status_id = \${next}::uuid WHERE id = \${id}::uuid\`)
  await syncDealOutcome(tx, orgId, actor, [id])
}`
    expect(unsyncedStatusWrites(bad)).toEqual(["sneakyMove"])
    expect(
      writesDealOutcome(
        `await tx.execute(drizzleSql\`UPDATE \${projectsRel("deals")} SET outcome = 'won' WHERE task_id = \${id}\`)`,
      ),
    ).toBe(true)
    expect(
      writesDealOutcome(
        `await tx.execute(drizzleSql\`UPDATE \${projectsRel("deals")} SET company_id = \${c} WHERE task_id = \${id}\`)`,
      ),
    ).toBe(false)
  })
})
