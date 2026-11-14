// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { newTally, subscriptionRow } from "./mirror"
import { civil, MemDb, sub } from "./mrr-fixtures.testkit"
import { mrrQuery } from "./tools/mrr-query"

describe("mrr_query", () => {
  it("while importing the query answers partial with no number", async () => {
    const db = new MemDb()
    db.rows("sync_state").push({
      id: "s1",
      resource: "subscriptions",
      status: "running",
      done_count: 40,
    })
    db.rows("stripe_subscriptions").push({
      id: "m1",
      ...subscriptionRow(sub("sub_1", { unit: 4900 }), newTally()),
    })
    const out = (await mrrQuery({}, { db, time: { civil } })) as {
      partial: boolean
      lines: unknown[]
      summary: string
    }
    expect(out.partial).toBe(true)
    expect(out.lines).toEqual([])
    expect(JSON.stringify(out)).not.toContain("4900")
    expect(out.summary).toContain("nothing was changed")
  })
})

describe("a subscription's card", () => {
  it("follows its expanded default payment method, and is kept when the method is not expanded", () => {
    const base = sub("sub_1", { unit: 4900 })
    const withCard = subscriptionRow(
      {
        ...base,
        default_payment_method: {
          id: "pm_1",
          object: "payment_method",
          card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2029 },
        },
      },
      newTally(),
    )
    expect([withCard.card_brand, withCard.card_last4, withCard.card_exp]).toEqual([
      "visa",
      "4242",
      "12/29",
    ])
    const idOnly = subscriptionRow({ ...base, default_payment_method: "pm_1" }, newTally())
    expect("card_last4" in idOnly).toBe(false)
    expect("card_last4" in subscriptionRow(base, newTally())).toBe(false)
  })
})
