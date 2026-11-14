// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { assertPlanningOn, type PlanningProject, planningOffBody, planningOn } from "./planning"
import { ProjectsServiceError } from "./statuses"

const work: PlanningProject = {
  id: "11111111-1111-4111-8111-111111111111",
  key: "HOUSE",
  name: "Studio internal",
  kind: "work",
  timeBudgetsOn: false,
  leadName: "Claire Martin",
}
const pipeline: PlanningProject = {
  ...work,
  key: "SALES",
  name: "Sales pipeline",
  kind: "pipeline",
}

describe("planning on a project", () => {
  it("plans only a work project with the switch on in an org that uses it", () => {
    expect(planningOn({ ...work, timeBudgetsOn: true }, true)).toBe(true)
    expect(planningOn({ ...work, timeBudgetsOn: true }, false)).toBe(false)
    expect(planningOn(work, true)).toBe(false)
    expect(planningOn({ ...pipeline, timeBudgetsOn: true }, true)).toBe(false)
  })

  it("a pipeline project is never offered", () => {
    const body = planningOffBody(pipeline, ["*"])
    expect(body.canTurnOn).toBe(false)
    expect(body.message).toBe("Sales pipeline tracks deals, so it has no planned time or budget.")
    expect(body.next).toBe("Say so. Do not offer to turn it on.")
  })

  it("the refusal has one wording for each asker: can turn on, cannot, pipeline, no project named", () => {
    const can = planningOffBody(work, ["projects:projects:write"])
    expect(can).toEqual({
      project: { id: work.id, key: "HOUSE", name: "Studio internal" },
      message:
        "Studio internal does not use time and budgets, so it has no planned time or budget.",
      canTurnOn: true,
      lead: { name: "Claire Martin" },
      next: "Offer to turn it on. If the person agrees, call update_project with timeBudgets:true, then repeat the request. Never work out a figure another way.",
    })
    const cannot = planningOffBody(work, ["projects:projects:read"])
    expect(cannot.canTurnOn).toBe(false)
    expect(cannot.next).toBe("Say that Claire Martin, its lead, or an admin can turn it on.")
    expect(planningOffBody(pipeline, ["projects:projects:write"]).next).toBe(
      "Say so. Do not offer to turn it on.",
    )
    const none = planningOffBody(null, ["*"])
    expect(none.project).toBeNull()
    expect(none.canTurnOn).toBe(false)
    expect(none.next).toContain("Ask which project")
  })

  it("assertPlanningOn throws planning_off with the body, and passes a project that plans", () => {
    expect(() => assertPlanningOn({ ...work, timeBudgetsOn: true }, true, [])).not.toThrow()
    try {
      assertPlanningOn(work, true, ["projects:projects:write"])
      throw new Error("expected a refusal")
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectsServiceError)
      const e = err as ProjectsServiceError
      expect(e.status).toBe(409)
      expect(e.code).toBe("planning_off")
      expect((e.details as { canTurnOn: boolean }).canTurnOn).toBe(true)
    }
  })
})
