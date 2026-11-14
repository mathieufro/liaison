// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A member's data subject export carries the time they entered, their away days and their days
// per week, and nothing of a colleague's: not their rows, not who is next in line, not who set
// a range or changed an entry. Run by someone else, it carries only the time entries that person
// could already read on a project's dated sheet, never the member's private ones.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { awaitTimeFeatureSync } from "~/apps/projects/service/time-feature"
import { awaitTimeRowWrites } from "~/apps/projects/service/time-rows"
import { type UserContext, withRlsContext } from "~/db/rls"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { MEMBER_SECTIONS, readMemberSections } from "~/modules/export/member-data-subject-bundle"
import { setAway } from "~/modules/users/away"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let admin: minimal.Session
let ana: minimal.Session
let leo: minimal.Session

const MEMBER = ["projects:projects:read", "projects:tasks:read", "projects:tasks:write"]

function actorOf(userId: string, scopes: string[]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

async function call<T = Record<string, any>>(
  method: string,
  input: unknown,
  who: { userId: string; scopes: string[] },
): Promise<T> {
  const a = actorOf(who.userId, who.scopes)
  const out = await runContextStore.run({} as never, () =>
    withRlsContext(a, async (tx) => {
      const bridge = createRpcBridge(
        "projects",
        a.userId,
        orgId,
        tx,
        { name: "projects" },
        a.scopes,
        "user",
        undefined,
        { origin: "human-ui" } as never,
      )
      return JSON.parse(await bridge[method](JSON.stringify(input))) as T
    }),
  )
  await awaitTimeRowWrites()
  return out
}

const asLeo = () => ({ userId: leo.userId, scopes: ["*"] })
const asAna = () => ({ userId: ana.userId, scopes: MEMBER })

const SECTIONS = MEMBER_SECTIONS.filter((s) =>
  ["ownTaskTime", "awayRanges", "daysPerWeek"].includes(s.key),
)

async function exportOfAna(by: minimal.Session) {
  return withRlsContext(actorOf(by.userId, ["*"]), (tx) =>
    readMemberSections(tx, { orgId, subjectUserId: ana.userId, callerUserId: by.userId }, SECTIONS),
  )
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  admin = await minimal.adminSession(orgId)
  ana = await minimal.session(orgId, { role: "member" })
  leo = await minimal.session(orgId, { role: "member" })
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
  // A project without dated hours, and Leo's project with them.
  const plain = await call<{ id: string }>(
    "projects_createProject",
    { name: "Maison Delorme" },
    asLeo(),
  )
  await call("projects_updateProject", { projectId: plain.id, timeBudgets: true }, asLeo())
  const dated = await call<{ id: string }>(
    "projects_createProject",
    { name: "Maison Ardent" },
    asLeo(),
  )
  await call("projects_updateProject", { projectId: dated.id, timeBudgets: true }, asLeo())
  await awaitTimeFeatureSync(orgId)
  await call("projects_timePlanSet", { projectId: dated.id, datedHours: true }, asLeo())
  const layouts = await call<{ id: string }>(
    "projects_createTask",
    { projectId: plain.id, title: "Layouts" },
    asLeo(),
  )
  const posters = await call<{ id: string }>(
    "projects_createTask",
    { projectId: dated.id, title: "Posters" },
    asLeo(),
  )
  // Ana's private 2 h 30 and her 2 h on the dated sheet, which Leo, its lead, changes to 3 h.
  await call("projects_taskTimeSet", { taskId: layouts.id, time: "2h30" }, asAna())
  await call(
    "projects_taskTimeSet",
    { taskId: posters.id, time: "2 h", date: "2026-10-05" },
    asAna(),
  )
  const sheet = await call<{ lines: Array<{ entryId: string }> }>(
    "projects_timesheetGet",
    { projectId: dated.id, month: "2026-10" },
    asLeo(),
  )
  expect(sheet.lines).toHaveLength(1)
  const fixed = await call(
    "projects_taskTimeCorrect",
    { entryId: sheet.lines[0]?.entryId, time: "3 h" },
    asLeo(),
  )
  expect(fixed.minutes).toBe(180)
  // Leo's own time, which no export of Ana may carry.
  await call("projects_taskTimeSet", { taskId: layouts.id, time: "16h39" }, asLeo())
  // Ana is away in December (set by the admin, Leo next in line); Leo in February.
  await setAway({
    orgId,
    actorId: admin.userId,
    actorScopes: ["*"],
    userId: ana.userId,
    form: { from: "2026-12-21", to: "2026-12-31" },
    nextInLineId: leo.userId,
  })
  await setAway({
    orgId,
    actorId: leo.userId,
    actorScopes: MEMBER,
    form: { from: "2027-02-01", to: "2027-02-15" },
  })
  const days = await call(
    "projects_timeSettingsSet",
    { userId: ana.userId, daysPerWeek: 4 },
    asLeo(),
  )
  expect(days.error).toBeUndefined()
}, 120_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await releaseTestLock()
})

describe("a member's time in their data subject export", () => {
  it("a person's own export holds all their own time and away ranges and nothing of others", async () => {
    expect(SECTIONS).toHaveLength(3)
    const out = await exportOfAna(ana)
    expect(
      (out.ownTaskTime?.rows ?? []).map((r) => [r.project, r.minutes, r.changed_by_someone_else]),
    ).toEqual(
      expect.arrayContaining([
        ["Maison Delorme", 150, false],
        ["Maison Ardent", 180, true],
      ]),
    )
    expect(out.ownTaskTime?.rows).toHaveLength(2)
    expect(out.awayRanges?.rows).toMatchObject([
      { starts_on: "2026-12-21", ends_on: "2026-12-31", set_by_someone_else: true },
    ])
    expect(out.daysPerWeek?.rows).toMatchObject([{ days_per_week: 4 }])
    const text = JSON.stringify(out)
    expect(text).not.toContain(leo.userId)
    expect(text).not.toContain("999")
    expect(text).not.toContain("2027-02-01")
  })

  it("an admin's export of a member leaves out the member's private time and keeps only what the admin reads", async () => {
    const out = await exportOfAna(admin)
    // The admin holds every scope but leads neither project: no time entry at all.
    expect(out.ownTaskTime?.rows).toEqual([])
    expect(out.ownTaskTime?.note).toContain("dated sheet")
    // Away days and days per week are the member's own facts, and stay.
    expect(out.awayRanges?.rows).toHaveLength(1)
    expect(out.daysPerWeek?.rows).toHaveLength(1)
  })

  it("the dated project's lead exporting the member gets the dated sheet entry only", async () => {
    const out = await exportOfAna(leo)
    expect((out.ownTaskTime?.rows ?? []).map((r) => [r.project, r.minutes])).toEqual([
      ["Maison Ardent", 180],
    ])
    expect(JSON.stringify(out.ownTaskTime)).not.toContain("150")
  })
})
