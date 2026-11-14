// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The timeline's speed at a real customer's size (seed/factories/timeline/activity-scale-world.ts):
// 50 people, 20 000 mails, 500 tickets with 1 500 notes, 40 deals with 600
// subtasks, a weekly meeting over three years and 300 single ones. Each
// source's time and the route's time are recorded cold (the first call) and
// warm (p95 of 20 calls), for the first page and the third. Every source must
// answer inside the 800 ms deadline warm and the route's warm p95 stay under
// 1 000 ms; a cold miss is printed with the source named.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import {
  agentInstructionsRegistry,
  initializedOrgRuntimes,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { ACTIVITY_DEADLINE_MS, readActivity } from "~/modules/contacts/activity"
import { seedContext } from "~/seed/context"
import { insertSql, type RowValue } from "~/seed/factories/org/test-rows"
import { SCALE, seedActivityScaleWorld } from "~/seed/factories/timeline/activity-scale-world"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedCalendarAccount } from "../../../test-support/seed/calendar"
import { ensureMailAccount } from "../../../test-support/seed/mail"

const ORG = crypto.randomUUID()
const ADMIN = crypto.randomUUID()
const tag = ORG.slice(0, 8)
const admin: UserContext = {
  actorType: "user",
  userId: ADMIN,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: { "*": ["*"] },
}
const SOURCES = ["calendar", "mail", "projects", "tickets"] as const

async function insertRow(table: string, cols: Record<string, RowValue>): Promise<void> {
  await sql.unsafe(insertSql(table, cols))
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
}

let companyId = ""

describe("the timeline at a real customer's size", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await insertRow("kernel.organizations", { id: ORG, name: "Scale Org", slug: `scale-${tag}` })
    await insertRow("kernel.users", {
      id: ADMIN,
      org_id: ORG,
      email: `${tag}@team.example`,
      name: "Élodie Vasseur",
      status: "active",
      password_hash: "x",
    })
    await insertRow("kernel.user_scope_grants", { user_id: ADMIN, org_id: ORG, scope: "*" })
    await ensureAppsForOrg(ORG)
    const ctx = seedContext({ orgId: ORG, now: new Date() })
    const mailAccountId = (
      await ensureMailAccount(ctx, {
        ownerType: "org",
        userId: ADMIN,
        email: `sales-${tag}@team.example`,
        provider: "imap",
      })
    ).accountId
    const calendarId = (
      await seedCalendarAccount(ctx, {
        userId: ADMIN,
        ownerType: "org",
        identifier: `cal-${tag}@team.example`,
        populate: false,
      })
    ).calendarId
    const [cal] = await sql<Array<{ calaccess: string }>>`
      SELECT calaccess FROM app_calendar.calendars WHERE id = ${calendarId}`
    companyId = crypto.randomUUID()
    await insertRow("kernel.companies", {
      id: companyId,
      org_id: ORG,
      handle: `@scale-${tag}`,
      name: "Big Dealer",
      created_by: ADMIN,
      org_access: "editor",
    })
    const pipelineId = crypto.randomUUID()
    const stageId = crypto.randomUUID()
    await insertRow("app_projects.projects", {
      id: pipelineId,
      org_id: ORG,
      name: "Sales",
      key: `Q${tag.slice(0, 3).toUpperCase()}`,
      owner_id: ADMIN,
      kind: "pipeline",
    })
    await insertRow("app_projects.project_statuses", {
      id: stageId,
      org_id: ORG,
      project_id: pipelineId,
      label: "Proposal",
      '"order"': 1,
      terminal: false,
    })
    await seedActivityScaleWorld({
      orgId: ORG,
      userId: ADMIN,
      companyId,
      mailAccountId,
      calendarId,
      calaccess: cal?.calaccess ?? "",
      pipelineId,
      stageId,
      tag,
    })
  }, 300_000)

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    skillRegistry.deleteByPrefix([ORG])
    agentInstructionsRegistry.deleteByPrefix([ORG])
    initializedOrgRuntimes.delete(ORG)
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`.catch(() => undefined)
    await releaseTestLock()
  })

  it("every source answers inside the deadline warm and the route's warm p95 is under one second, on the first page and the third", async () => {
    const [counts] = await sql<Array<{ mail: number; notes: number; events: number }>>`
      SELECT (SELECT count(*)::int FROM app_mail.messages WHERE org_id = ${ORG}) AS mail,
             (SELECT count(*)::int FROM app_tickets.messages WHERE org_id = ${ORG}) AS notes,
             (SELECT count(*)::int FROM app_calendar.events WHERE org_id = ${ORG}) AS events`
    expect(counts).toEqual({
      mail: SCALE.mailMessages,
      notes: SCALE.ticketNotes,
      events: SCALE.singleMeetings + 1,
    })
    const target = { companyId }
    const timed = async (source: string | null, before: string | null) => {
      const started = performance.now()
      const page = await readActivity({
        orgId: ORG,
        actor: admin,
        target,
        before,
        source,
        limit: 30,
        // The route's own deadline: the panel's budget, not an agent's read.
        deadlineMs: ACTIVITY_DEADLINE_MS,
      })
      return { ms: performance.now() - started, page }
    }
    // The cursor of the third page, read once.
    const first = await timed(null, null)
    const second = await timed(null, first.page?.nextBefore ?? null)
    const third = second.page?.nextBefore ?? null
    expect(third).not.toBeNull()

    const figures: Record<string, { cold: number; warm95: number }> = {}
    const misses: string[] = []
    for (const [label, before] of [
      ["page 1", null],
      ["page 3", third],
    ] as const) {
      for (const source of [...SOURCES, null]) {
        const name = `${source ?? "route"} ${label}`
        const cold = await timed(source, before)
        const warm: number[] = []
        for (let i = 0; i < 20; i++) {
          const run = await timed(source, before)
          warm.push(run.ms)
          if (run.page && run.page.unavailable.length > 0) {
            misses.push(
              `${name}: ${run.page.unavailable.map((u) => `${u.source} ${u.reason}`).join(", ")}`,
            )
          }
        }
        if (cold.page && cold.page.unavailable.length > 0) {
          console.log(`cold miss ${name}: ${cold.page.unavailable.map((u) => u.source).join(", ")}`)
        }
        figures[name] = { cold: Math.round(cold.ms), warm95: Math.round(p95(warm)) }
      }
    }
    console.log(`timeline at scale (ms): ${JSON.stringify(figures)}`)
    expect(misses).toEqual([])
    for (const [name, f] of Object.entries(figures)) {
      const bar = name.startsWith("route") ? 1000 : ACTIVITY_DEADLINE_MS
      expect({ name, ok: f.warm95 < bar }).toEqual({ name, ok: true })
    }
  }, 600_000)
})
