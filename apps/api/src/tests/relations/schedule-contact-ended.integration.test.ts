// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A person billed by a recurring invoice schedule: the delete is refused while the schedule has
// not ended, and once it has, the delete goes through and the schedule lets go of the person
// (its contact is cleared) instead of keeping the id of someone who no longer exists.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { forgetMoneyOrgs, MoneyCase, moneyOrg } from "./payments-world"
import { inv } from "./recurring-world"

async function scheduleContact(id: string): Promise<string | null | undefined> {
  const [row] = (await sql.unsafe(
    `SELECT contact_id::text AS contact_id FROM ${inv("recurring_schedules")} WHERE id = $1`,
    [id],
  )) as Array<{ contact_id: string | null }>
  return row?.contact_id
}

async function setStatus(id: string, status: string): Promise<void> {
  await sql.unsafe(`UPDATE ${inv("recurring_schedules")} SET status = $2 WHERE id = $1`, [
    id,
    status,
  ])
}

describe("deleting a person a recurring schedule bills", () => {
  beforeAll(async () => {
    await acquireTestLock()
    forgetMoneyOrgs()
  }, 180_000)

  afterAll(async () => {
    // The cells file truncates organizations when it starts: it builds its own money world.
    forgetMoneyOrgs()
    await releaseTestLock()
  })

  it("is refused while the schedule has not ended, and the schedule keeps the person", async () => {
    const w = await new MoneyCase(await moneyOrg(), "scheduleContact").build()
    await w.deleteContact()
    expect(w.refusal).toContain("recurring invoice schedule")
    expect(await w.contactExists()).toBe(true)
    expect(await scheduleContact(w.inv.scheduleId)).toBe(w.contactId)
  }, 120_000)

  it("goes through once the schedule has ended, and clears the schedule's person", async () => {
    const w = await new MoneyCase(await moneyOrg(), "scheduleContact").build()
    await setStatus(w.inv.scheduleId, "ended")
    await w.deleteContact()
    expect(w.refusal).toBeNull()
    expect(await w.contactExists()).toBe(false)
    expect(await scheduleContact(w.inv.scheduleId)).toBeNull()
  }, 120_000)
})
