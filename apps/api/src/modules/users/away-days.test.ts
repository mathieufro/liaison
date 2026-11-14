// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The away days capacity reads: dates only, from active ranges, weekday ranges expanded, a range
// ended early stopping that day.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { addCalendarDays } from "@liaison/shared"
import { sql } from "~/db"
import { awayDays, setAway } from "~/modules/users/away"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const addDays = addCalendarDays

/** A Monday three weeks ahead, so every range lies in the future. */
function futureMonday(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + 21)
  const wd = d.getUTCDay() === 0 ? 7 : d.getUTCDay()
  d.setUTCDate(d.getUTCDate() - (wd - 1))
  return d.toISOString().slice(0, 10)
}

const SELF = ["projects:projects:read"]
let orgId = ""

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  await sql`UPDATE kernel.organizations SET timezone = 'UTC' WHERE id = ${orgId}`
}, 60_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("awayDays", () => {
  it("asked and declined ranges never count, a weekday range expands, ended early stops", async () => {
    const monday = futureMonday()
    const asked = await minimal.session(orgId)
    const declined = await minimal.session(orgId)
    const weekly = await minimal.session(orgId)
    const early = await minimal.session(orgId)
    const plain = await minimal.session(orgId)
    for (const p of [asked, declined, early, plain]) {
      await setAway({
        orgId,
        actorId: p.userId,
        actorScopes: SELF,
        form: { from: monday, to: addDays(monday, 4) },
      })
    }
    await setAway({
      orgId,
      actorId: weekly.userId,
      actorScopes: SELF,
      form: { from: monday, everyWeekday: [3] },
    })
    // Asked and declined are the states of a range read from a calendar.
    for (const [p, status] of [
      [asked, "asked"],
      [declined, "declined"],
    ] as const) {
      await sql`UPDATE kernel.away_ranges
        SET status = ${status}, source = 'calendar', source_event_ref = ${`evt-${status}`}
        WHERE user_id = ${p.userId}`
    }
    await sql`UPDATE kernel.away_ranges SET ended_early_on = ${addDays(monday, 2)}::date
      WHERE user_id = ${early.userId}`

    const ids = [asked, declined, weekly, early, plain].map((p) => p.userId)
    const out = await awayDays(orgId, ids, monday, addDays(monday, 13))
    expect(out.has(asked.userId)).toBe(false)
    expect(out.has(declined.userId)).toBe(false)
    expect(out.get(weekly.userId)).toEqual([addDays(monday, 2), addDays(monday, 9)])
    expect(out.get(early.userId)).toEqual([monday, addDays(monday, 1)])
    expect(out.get(plain.userId)).toEqual([0, 1, 2, 3, 4].map((n) => addDays(monday, n)))
    // A window that misses every range reads nobody.
    expect((await awayDays(orgId, ids, addDays(monday, -14), addDays(monday, -8))).size).toBe(0)
  })
})
