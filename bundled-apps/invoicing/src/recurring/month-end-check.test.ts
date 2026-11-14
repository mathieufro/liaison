// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The month-end check: a routine template that reads a freshly drafted run and the records around
// it, and says in a sentence or two what a person may want to look at. It holds read scopes only,
// so it cannot change a draft, and the run's card is complete without it.
import { describe, expect, it } from "bun:test"
import manifest from "../../app.manifest.json"

interface RoutineTemplate {
  description: string
  kind: string
  event?: string
  promptTemplate: string
  scopes: string[]
  enabledByDefault: boolean
}

const routines = (manifest as { routines?: Record<string, RoutineTemplate> }).routines ?? {}
const tools = (manifest as { tools: Record<string, { requiredScopes?: string[] }> }).tools
const check = routines["month-end-check"]

describe("the month-end check routine", () => {
  it("runs when a month-end run is drafted, off until someone turns it on", () => {
    expect(check).toMatchObject({
      kind: "event",
      event: "invoicing:recurring_run:drafted",
      enabledByDefault: false,
    })
    expect((manifest as { events: { emits: string[] } }).events.emits).toContain(
      "recurring_run:drafted",
    )
  })

  it("holds read scopes only, so no draft tool is in its reach", () => {
    expect(check?.scopes.length).toBeGreaterThan(0)
    for (const scope of check?.scopes ?? []) expect(scope.endsWith(":read")).toBe(true)
    const writers = ["drafts_update", "drafts_create", "drafts_discard", "recurring_run_issue"]
    for (const name of writers) {
      const needed = tools[name]?.requiredScopes ?? []
      expect(needed.length).toBeGreaterThan(0)
      expect(needed.every((s) => check?.scopes.includes(s))).toBe(false)
    }
    // It can read the run it was woken for.
    expect(
      (tools.recurring_run_get?.requiredScopes ?? []).every((s) => check?.scopes.includes(s)),
    ).toBe(true)
  })

  it("asks for two sentences at most, naming what it read, in a short prompt", () => {
    const prompt = check?.promptTemplate ?? ""
    expect(prompt).toContain("recurring_run_get")
    expect(prompt).toMatch(/two sentences/)
    // About four characters a token: the prompt is paid on every drafted run.
    expect(Math.ceil(prompt.length / 4)).toBeLessThanOrEqual(250)
  })
})
