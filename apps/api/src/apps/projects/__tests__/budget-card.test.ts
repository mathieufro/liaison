// SPDX-License-Identifier: FSL-1.1-ALv2
// The project budget card, drawn from a budget_get result with no app bundle loaded: the
// template lives in the manifest and reads only paths the tool declares it returns.
import { describe, expect, it } from "bun:test"
import { resolveToolCard } from "~/modules/apps/result-card"
import { resultCardErrors } from "~/modules/apps/result-card-schema"
import { projectsAppManifest } from "../manifest-descriptor"

const template = (projectsAppManifest as any).tools.budget_get.resultCard

function result(milestones: number, extra: Record<string, unknown> = {}) {
  const rows = Array.from({ length: milestones }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    name: `Milestone number ${i + 1} of the long portal programme`,
    state: "started",
    plannedMinutes: 60 * (i + 1),
    realMinutes: 30 * (i + 1),
  }))
  return {
    projectId: "p",
    projectName: "Maison Delorme portal",
    line: "346 h real of 420 h planned, 74 h left. Partial: real time entered on 41 of 46 tasks.",
    real: 20760,
    partial: true,
    coverage: { withEntries: 41, total: 46 },
    milestones: rows,
    notInNumbers: [{ text: "One note." }],
    datedHours: false,
    groups: rows.length > 0 ? [{ label: "Milestones", rows }] : [],
    totals: [
      { k: "Planned", text: "420 h" },
      { k: "Real", text: "346 h" },
      { k: "Left", text: "74 h" },
    ],
    ...extra,
  }
}

describe("the budget card", () => {
  it("every template path is in the tool's returns", () => {
    expect(resultCardErrors(projectsAppManifest as never)).toEqual([])
  })

  it("the budget card resolves with the app bundle not loaded", () => {
    const card = resolveToolCard(template, result(4))
    expect(card?.kind).toBe("groups")
    expect(card?.cover).toBe("Real time entered on 41 of 46 tasks")
    expect(card?.groups?.[0]?.rows).toHaveLength(4)
    expect(card?.notes?.[0]?.text).toBe("One note.")
  })

  it("a project with no milestones still draws its line and totals", () => {
    const card = resolveToolCard(template, result(0))
    expect(card?.groups).toEqual([])
    expect(card?.tot?.map((t) => t.k)).toEqual(["Planned", "Real", "Left"])
  })

  it("a card of 40 milestones stays under its byte bound", () => {
    const card = resolveToolCard(template, result(40))
    expect(card).not.toBeNull()
    expect(new TextEncoder().encode(JSON.stringify(card)).length).toBeLessThan(24_576)
  })

  it("no price total is drawn when the result holds none", () => {
    const card = resolveToolCard(template, result(2))
    expect(card?.tot?.some((t) => t.k === "Price")).toBe(false)
  })
})
