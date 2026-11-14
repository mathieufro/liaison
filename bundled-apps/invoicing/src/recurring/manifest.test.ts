// SPDX-License-Identifier: FSL-1.1-ALv2
// What the manifest declares for recurring schedules: who can reach the tables, how each write is
// gated, and that every handler it names exists.
import { describe, expect, test } from "bun:test"
import manifest from "../../app.manifest.json"
import * as handlers from "../handlers"
import * as summarizers from "../summarizers"

type Tool = Record<string, unknown> & {
  description: string
  requiredScopes: string[]
  params: { properties: Record<string, unknown> }
}
const m = manifest as unknown as {
  schema: Record<
    string,
    { rlsScope?: string; fields: Record<string, unknown>; constraints?: { unique?: string[][] } }
  >
  tools: Record<string, Tool>
  import: { kinds: Record<string, { handler: string; check: string; tables: string[] }> }
}
const TOOLS = [
  "recurring_schedule_create",
  "recurring_schedule_update",
  "recurring_schedule_pause",
  "recurring_list",
]

describe("recurring tables", () => {
  test("each table is reachable with the documents scope, so a member who can read documents sees them", () => {
    for (const t of ["recurring_schedules", "recurring_runs", "recurring_run_items"])
      expect(m.schema[t]?.rlsScope).toBe("documents")
  })

  test("a run is unique per issuer and issue day, an item per schedule and period and per document", () => {
    expect(m.schema.recurring_runs?.constraints?.unique).toEqual([
      ["issuer_profile_id", "issue_on"],
    ])
    expect(m.schema.recurring_run_items?.constraints?.unique).toEqual([
      ["schedule_id", "period_key"],
      ["document_id"],
    ])
  })
})

describe("recurring tools", () => {
  test("every write that creates or changes a schedule is gated: create and update park for an agent, a pause parks after outside text", () => {
    const create = m.tools.recurring_schedule_create!
    const update = m.tools.recurring_schedule_update!
    const pause = m.tools.recurring_schedule_pause!
    expect(create.gated).toBe(true)
    expect(create.approvalImpact).toBe("external")
    expect(update.gated).toBe(true)
    // An org auto-approve policy never approves a change that can turn on issuing by itself.
    expect(update.noAutoApprove).toBe(true)
    expect(pause.conditionalGate).toBe(true)
    expect(pause.externalEffect).toBe(true)
    expect(m.tools.recurring_list?.readOnly).toBe(true)
    expect(m.tools.recurring_list?.gated).toBeUndefined()
  })

  test("create names issue_mode only to refuse auto, and update is where it is set", () => {
    const create = m.tools.recurring_schedule_create!.params.properties.issue_mode as {
      enum: string[]
    }
    expect(create.enum).toEqual(["review", "auto"])
    expect(Object.keys(m.tools.recurring_schedule_update!.params.properties)).toContain(
      "issue_mode",
    )
  })

  test("they need the documents scopes, have short descriptions, and every handler and summarizer exists", () => {
    for (const name of TOOLS) {
      const t = m.tools[name]!
      expect(t.requiredScopes, name).toEqual([
        name === "recurring_list" ? "invoicing:documents:read" : "invoicing:documents:write",
      ])
      expect(t.description.length, name).toBeLessThanOrEqual(280)
      expect((handlers as Record<string, unknown>)[String(t.handler)], name).toBeTypeOf("function")
      if (t.preflight)
        expect((handlers as Record<string, unknown>)[String(t.preflight)], name).toBeTypeOf(
          "function",
        )
      if (t.summarizer)
        expect((summarizers as Record<string, unknown>)[String(t.summarizer)], name).toBeTypeOf(
          "function",
        )
    }
  })

  test("the import kind names exported handlers and writes only the schedule table", () => {
    const kind = m.import.kinds["recurring-schedule"]!
    expect((handlers as Record<string, unknown>)[kind.handler]).toBeTypeOf("function")
    expect((handlers as Record<string, unknown>)[kind.check]).toBeTypeOf("function")
    expect(kind.tables).toEqual(["app_invoicing.recurring_schedules"])
  })
})
