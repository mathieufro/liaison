// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A skill an app ships for one of its features goes with the feature: an org
// that has the feature off is shown no listing of it and cannot read it, as it
// finds none of the feature's tools. An org that turns the feature on gets it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { skillRegistry } from "~/modules/apps/app-registries"
import { forgetOrgApps, rememberOrgAppStates } from "~/modules/apps/org-apps"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { handleListSkills, handleSkillRead, resolveAllSkills } from "./skills-routines-tools"

const SCOPES = ["kernel:skills:read"]
const USER = "00000000-0000-4000-8000-000000000001"

let orgId: string

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

beforeEach(async () => {
  orgId = (await createTestOrg()).id
  skillRegistry.set([orgId, "projects", "reconcile"], {
    name: "reconcile",
    description: "A playbook of the time feature.",
    body: "Rule one.",
    requiredScopes: [],
    feature: "time_budgets",
  })
  skillRegistry.set([orgId, "projects", "plain"], {
    name: "plain",
    description: "A playbook of the whole app.",
    body: "Rule two.",
    requiredScopes: [],
  })
})

afterEach(() => {
  skillRegistry.deleteByPrefix([orgId])
  forgetOrgApps(orgId)
})

describe("a skill that belongs to an app feature", () => {
  it("is not resolved, listed or readable while the feature is off", async () => {
    rememberOrgAppStates(orgId, [{ app: "projects", status: "active" }], { features: {} })
    const names = (await resolveAllSkills(orgId, USER, SCOPES)).map((s) => s.name)
    expect(names).toContain("plain")
    expect(names).not.toContain("reconcile")
    const listed = await handleListSkills({}, { orgId, userId: USER, scopes: SCOPES })
    expect(listed.skills.map((s) => s.name)).not.toContain("reconcile")
    const read = await handleSkillRead(
      { name: "reconcile" },
      { orgId, userId: USER, scopes: SCOPES },
    )
    expect(JSON.stringify(read)).not.toContain("Rule one.")
  })

  it("is resolved and readable once the org turns the feature on", async () => {
    rememberOrgAppStates(orgId, [{ app: "projects", status: "active" }], {
      features: { projects: ["time_budgets"] },
    })
    const names = (await resolveAllSkills(orgId, USER, SCOPES)).map((s) => s.name).sort()
    expect(names).toContain("plain")
    expect(names).toContain("reconcile")
    const read = await handleSkillRead(
      { name: "reconcile" },
      { orgId, userId: USER, scopes: SCOPES },
    )
    expect(JSON.stringify(read)).toContain("Rule one.")
  })
})
