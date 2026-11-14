// SPDX-License-Identifier: FSL-1.1-ALv2
// No ranking of people: nothing the projects app hands the agent tells it to name the person with
// the most tasks, the most hours or the most load. "Who's overloaded" is answered by capacity_get,
// which shows each person's planned time against their own available time, unsorted.
import { describe, expect, it } from "bun:test"
import { projectsAppManifest } from "../manifest-descriptor"

/** Every text the agent is handed: instructions, tool descriptions and notes, skills. */
function agentTexts(m: any): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = []
  const sections = m.agentInstructions?.sections ?? []
  sections.forEach((s: any, i: number) => {
    out.push({ where: `agentInstructions.sections[${i}]`, text: String(s.text ?? "") })
  })
  if (typeof m.agentInstructions?.text === "string") {
    out.push({ where: "agentInstructions.text", text: m.agentInstructions.text })
  }
  for (const [name, tool] of Object.entries((m.tools ?? {}) as Record<string, any>)) {
    out.push({ where: `tools.${name}.description`, text: String(tool.description ?? "") })
    if (typeof tool.instructions === "string") {
      out.push({ where: `tools.${name}.instructions`, text: tool.instructions })
    }
  }
  for (const [name, skill] of Object.entries((m.skills ?? {}) as Record<string, any>)) {
    out.push({ where: `skills.${name}`, text: JSON.stringify(skill) })
  }
  return out
}

const RANKING = [
  /most[- ]loaded/i,
  /least[- ]loaded/i,
  /busiest/i,
  /(?:person|people|who|assignee)\s+with\s+the\s+(?:most|fewest|least)/i,
  /(?:naming|name)\s+the\s+(?:person|people|one)\s+(?:with|who)/i,
]

describe("the projects app never tells the agent to rank people", () => {
  it("no instruction, tool text or skill names the person with the most", () => {
    const offending = agentTexts(projectsAppManifest).flatMap(({ where, text }) =>
      RANKING.filter((re) => re.test(text)).map((re) => `${where}: ${re}`),
    )
    expect(offending).toEqual([])
  })

  it("who's overloaded points to capacity_get, and planned time is said to need time and budgets", () => {
    const all = agentTexts(projectsAppManifest)
      .map((t) => t.text)
      .join("\n")
    expect(all).toMatch(/who's overloaded', `capacity_get`/)
    expect(all).toContain("planned time exists only on a project using time and budgets")
  })

  it("the guard catches the wording it forbids", () => {
    const old =
      "group the SAME rows by `assigneeName` for a per-PERSON task count, naming the person with the most as the most-loaded"
    expect(RANKING.some((re) => re.test(old))).toBe(true)
  })
})
