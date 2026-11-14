// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The projects page says what time and budgets is for (billing clients and
// planning capacity), says it is not for evaluating anyone, and carries the
// notice the first project points to, in English and French, plus fixed
// retention periods that match the product's own constants.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { AWAY_RETENTION_DAYS } from "~/modules/users/away"
import { IDLE_PROPOSAL_DAYS } from "../service/reconcile-sweep"
import { TASK_TIME_PERSON_MONTHS } from "../service/task-time-anonymise"
import { firstOnNotice } from "../service/time-feature"

const PAGE = readFileSync(
  path.resolve(import.meta.dir, "../../../../../../docs/apps/projects.md"),
  "utf8",
)

function section(heading: string): string {
  const start = PAGE.indexOf(`\n## ${heading}\n`)
  expect(start).toBeGreaterThan(-1)
  const next = PAGE.indexOf("\n## ", start + 1)
  return PAGE.slice(start, next === -1 ? undefined : next)
}

describe("the projects page", () => {
  it("the projects page states its purpose and excludes performance evaluation", () => {
    const purpose = section("What time and budgets is for")
    expect(purpose).toContain("billing a project's clients and planning a project's capacity")
    expect(purpose).toContain("It is not for evaluating anyone's work or performance")
    expect(purpose).toContain("Not the legal working-time record")
  })

  it("has the section the first project's notice points to, with the template in both languages", () => {
    expect(firstOnNotice(1)).toContain("telling your team")
    const tell = section("Telling your team")
    expect(tell).toContain("L1222-4")
    expect(tell).toContain("L2312-38")
    expect(tell).toContain("**English**")
    expect(tell).toContain("**Français**")
    expect(tell).toContain("It is not used to evaluate anyone's work or performance.")
    expect(tell).toContain("Il ne sert pas à évaluer le travail ou la performance de quiconque.")
  })

  it("documents fixed retention periods that are the product's own", () => {
    const kept = section("How long time is kept")
    expect(kept).toContain("there is no setting to change them")
    expect(kept).toContain(`for ${TASK_TIME_PERSON_MONTHS} months after the day it was worked`)
    expect(kept).toContain(`nobody touched for ${IDLE_PROPOSAL_DAYS} days is deleted`)
    expect(kept).toContain(`deleted ${AWAY_RETENTION_DAYS} days after its last day`)
    expect(section("Telling your team")).toContain(`for ${TASK_TIME_PERSON_MONTHS} months`)
  })
})
