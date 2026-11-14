// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Mail held for a person who is away is released at the end of the run of days they are away, and
// two ranges set one after the other (a week off, then a second week entered separately) are one
// run. A read of who is away that fails leaves the caller's transaction usable: the notification
// loader and the approvals feed both go on with the rest of their work.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { readRouteNames } from "~/modules/approvals/attention"
import { type RoutedRows, readAwayWorld } from "~/modules/approvals/route-world"
import { readAwayUntil } from "~/modules/notifications/router"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const TODAY = "(now() AT TIME ZONE 'UTC')::date"

let ORG = ""
let AWAY = ""
let lastDay = ""
const asAway = (): UserContext => ({
  actorType: "user",
  userId: AWAY,
  orgId: ORG,
  scopes: [],
  dimensionGrants: {},
})

async function range(userId: string, from: number, to: number): Promise<void> {
  await sql.unsafe(
    insertSql("kernel.away_ranges", {
      org_id: ORG,
      user_id: userId,
      starts_on: { raw: `${TODAY} + ${from}` },
      ends_on: { raw: `${TODAY} + ${to}` },
      source: "said",
    }),
  )
}

describe("the end of a run of away days", () => {
  beforeAll(async () => {
    await acquireTestLock()
    ORG = (await createTestOrg()).id
    AWAY = (await minimal.person(ORG, { name: "Fixture away" })).id
    // A week that started yesterday, then a second week set separately, starting the day after.
    await range(AWAY, -1, 2)
    await range(AWAY, 3, 9)
    const [row] = await sql<{ day: string }[]>`
      SELECT ((now() AT TIME ZONE 'UTC')::date + 9)::text AS day`
    lastDay = (row as { day: string }).day
  }, 60_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("mail held for a person away on back-to-back ranges waits for the end of the last one", async () => {
    const until = await withPrivilegedDb(ORG, "test-away-until", (tx) =>
      readAwayUntil(tx, { orgId: ORG, userId: AWAY }, "UTC", "UTC"),
    )
    expect(until).toBe(lastDay)
  })

  it("Home's away line runs to the end of the last back-to-back range", async () => {
    const world = await withRlsContext(asAway(), (tx) => readAwayWorld(tx, ORG))
    expect(world.away(AWAY)?.until).toBe(lastDay)
  })

  it("a failed away read leaves the notification loader's transaction usable", async () => {
    const after = await withPrivilegedDb(ORG, "test-away-until-fails", async (tx) => {
      const until = await readAwayUntil(tx, { orgId: ORG, userId: "not-a-uuid" }, "UTC", "UTC")
      expect(until).toBeNull()
      return extractRows<{ one: number }>(await tx.execute(drizzleSql`SELECT 1 AS one`))
    })
    expect(after).toEqual([{ one: 1 }])
  })

  it("a failed read of the route names leaves the feed's transaction usable", async () => {
    const routes: RoutedRows = {
      route: () => ({
        to: "person",
        userId: randomUUID(),
        why: "asked",
        awayUntil: null,
        standIn: null,
        blockedStandIn: null,
      }),
      requesterDecides: () => false,
    }
    const after = await withRlsContext(asAway(), async (tx) => {
      const names = await readRouteNames(tx, "not-a-uuid", AWAY, [{ id: randomUUID() }], routes)
      expect(names.size).toBe(0)
      return extractRows<{ one: number }>(await tx.execute(drizzleSql`SELECT 1 AS one`))
    })
    expect(after).toEqual([{ one: 1 }])
  })
})
