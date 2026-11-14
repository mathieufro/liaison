// SPDX-License-Identifier: FSL-1.1-ALv2
// `invoicing.recurring-schedule`: schedules from another tool arrive as drafts that bill nothing
// until a person starts them, one row per external reference.
import { describe, expect, it } from "bun:test"
import { createMockDb as createSharedMockDb } from "@liaison/test-helpers/mock-db"
import { checkSchedules, importSchedules } from "./import-kind"

const mockDb = () => createSharedMockDb({}, { ids: "uuid", bridgeWhereOperators: true })

const record = (over: Record<string, unknown> = {}) => ({
  externalRef: "sub-1",
  contactId: "contact-1",
  repeats: "month",
  billingDay: "last",
  lines: [
    { description: "Support plan {period}", quantity: 1, unitPriceMinor: 4900, taxRateBp: 2000 },
  ],
  ...over,
})
const batch = (records: Array<Record<string, unknown>>) => ({
  runId: "run-1",
  kind: "invoicing.recurring-schedule",
  sourceLabel: "crm",
  records: records.map((r) => ({ record: r, dedupValue: `crm:${String(r.externalRef)}` })),
})

async function setup() {
  const db = mockDb()
  const issuer = await db.insert("issuer_profiles", {
    legal_name: "Fabrikam",
    country: "FR",
    default_language: "fr",
  })
  return { db, ctx: { db }, issuerId: issuer.id }
}

describe("invoicing.recurring-schedule import", () => {
  it("creates a draft schedule that bills nothing and issues for review, and skips the same reference again", async () => {
    const { db, ctx, issuerId } = await setup()
    const [first] = await importSchedules(batch([record()]), ctx)
    expect(first).toMatchObject({ status: "created" })
    expect(db.__all("recurring_schedules")).toHaveLength(1)
    expect(db.__all("recurring_schedules")[0]).toMatchObject({
      status: "draft",
      issue_mode: "review",
      issuer_profile_id: issuerId,
      external_ref: "crm:sub-1",
      next_issue_on: null,
      version: 1,
    })
    const [again] = await importSchedules(batch([record()]), ctx)
    expect(again).toMatchObject({ status: "skipped" })
    expect(db.__all("recurring_schedules")).toHaveLength(1)
  })

  it("refuses an automatic schedule, a missing customer or line and an unknown issuer, and the preview says the same", async () => {
    const { db, ctx } = await setup()
    const bad = [
      record({ externalRef: "a", issueMode: "auto" }),
      record({ externalRef: "b", contactId: "" }),
      record({ externalRef: "c", lines: [] }),
      record({ externalRef: "d", issuerProfileId: "nope" }),
    ]
    const run = await importSchedules(batch(bad), ctx)
    expect(run.map((r) => r.status)).toEqual(["failed", "failed", "failed", "failed"])
    expect(run[0]?.error).toContain("auto_needs_update")
    expect(run[3]?.error).toContain("issuer_not_found")
    const check = await checkSchedules(batch(bad), ctx)
    expect(check.map((r) => r.status)).toEqual(["failed", "failed", "failed", "failed"])
    expect(db.__all("recurring_schedules")).toHaveLength(0)
  })

  it("the preview writes nothing", async () => {
    const { db, ctx } = await setup()
    expect((await checkSchedules(batch([record()]), ctx))[0]).toMatchObject({ status: "created" })
    expect(db.__all("recurring_schedules")).toHaveLength(0)
  })
})
