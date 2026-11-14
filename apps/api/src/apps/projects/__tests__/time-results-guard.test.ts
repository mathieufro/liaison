// SPDX-License-Identifier: FSL-1.1-ALv2
// Coverage is a project's: no time tool's result or card template may put a coverage count
// next to a person. A static guard cannot read a screen; it reads what the tools return.
import { describe, expect, it } from "bun:test"
import { projectsAppManifest } from "../manifest-descriptor"

const PERSON = /user|person|people|member|assignee|author|owner|who|nobody|chase|nudge|remind/i
const tools = Object.entries((projectsAppManifest as any).tools as Record<string, any>).filter(
  ([, t]) => t.feature === "time_budgets",
)

function paths(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") {
    for (const m of v.matchAll(/(?:result|group|row|item)(?:\.[A-Za-z_][A-Za-z0-9_]*)+/g)) {
      out.push(m[0])
    }
  } else if (Array.isArray(v)) {
    for (const x of v) paths(x, out)
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v)) paths(x, out)
  }
  return out
}

describe("time tool results and cards", () => {
  it("no time tool result or card pairs a coverage count with a person", () => {
    expect(tools.length).toBeGreaterThan(5)
    const offending: string[] = []
    for (const [name, tool] of tools) {
      const keys = Object.keys(tool.returns?.schema ?? {})
      const used = paths(tool.resultCard)
      const mentionsCoverage = keys.includes("coverage") || used.some((p) => p.includes("coverage"))
      if (!mentionsCoverage) continue
      for (const word of [...keys, ...used]) {
        if (PERSON.test(word)) offending.push(`${name}: ${word}`)
      }
    }
    expect(offending).toEqual([])
    // The guard sees the budget read, the one coverage-carrying tool built so far.
    expect(tools.some(([name]) => name === "budget_get")).toBe(true)
    expect(tools.some(([name]) => name === "margin_get")).toBe(true)
  })

  it("no time tool is a chase: none lists who has not entered, nudges or reminds", () => {
    const offending = tools
      .filter(([name]) => /nudge|remind|chase|missing|who_/i.test(name))
      .map(([name]) => name)
    expect(offending).toEqual([])
  })
})
