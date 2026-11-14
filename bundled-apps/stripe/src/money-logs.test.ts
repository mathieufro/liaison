// SPDX-License-Identifier: FSL-1.1-ALv2
//
// No tool takes a card number, and what the money tools log about a payment
// method is its brand, last 4 and expiry.
import { beforeEach, describe, expect, it } from "bun:test"
import { MemDb } from "./mem-db.testkit"
import {
  connectedDb,
  moneyCtx,
  seedCharge,
  stripeMockRequests,
  stripeMockReset,
} from "./money.testkit"
import { customerLink } from "./tools/link"
import { refundsCreate, refundsCreatePreflight } from "./tools/refunds"

const CARD = "4242 4242 4242 4242"

beforeEach(() => stripeMockReset())

describe("card numbers and payment details", () => {
  it("a card number in a refund reason or a link note is refused", async () => {
    seedCharge("ch_ok", 5000)
    for (const reason of [`customer asked, card ${CARD}`, "5555555555554444"]) {
      const out = (await refundsCreatePreflight(
        { chargeId: "ch_ok", reason },
        moneyCtx(connectedDb(), null),
      )) as any
      expect(out.error.code).toBe("card_number_refused")
      expect(out.error.message).not.toContain("4242")
    }
    // The same refusal holds after approval, before anything reaches Stripe.
    const approved = (await refundsCreate(
      { chargeId: "ch_ok", reason: CARD },
      moneyCtx(connectedDb(), "apr-x"),
    )) as any
    expect(approved.error.code).toBe("card_number_refused")
    // A plain order reference passes.
    expect(
      await refundsCreatePreflight(
        { chargeId: "ch_ok", reason: "order 1000234 damaged" },
        moneyCtx(connectedDb(), null),
      ),
    ).toMatchObject({ ok: true })

    const db = new MemDb()
    db.seed("stripe_customers", [{ stripe_id: "cus_1" }])
    const link = (await customerLink({ stripeCustomerId: "cus_1", contactId: CARD }, {
      db,
      userId: "u",
    } as never)) as any
    expect(link.error.code).toBe("card_number_refused")
    expect(db.writes).toHaveLength(0)
    expect(stripeMockRequests().filter((r) => r.method === "POST")).toHaveLength(0)
  })

  it("refund logs hold no payment detail beyond brand, last 4 and expiry", async () => {
    seedCharge("ch_ok", 5000, 0, {
      billing_details: { name: "Client Example", address: { line1: "1 rue de la Paix" } },
      payment_method_details: {
        type: "card",
        card: {
          brand: "visa",
          last4: "4242",
          exp_month: 12,
          exp_year: 2030,
          fingerprint: "Fp1234secret",
          country: "FR",
          funding: "credit",
        },
      },
    })
    const ok = moneyCtx(connectedDb(), "apr-log")
    const out = (await refundsCreate({ chargeId: "ch_ok", amountMinor: 1000 }, ok)) as any
    seedCharge("ch_lost", 5000)
    const ctxs = [ok]
    for (const r of ctxs) {
      expect(r.rec.logs.length).toBeGreaterThan(0)
      for (const line of r.rec.logs) {
        const text = JSON.stringify(line)
        expect(text).not.toMatch(
          /fingerprint|Fp1234|rue de la Paix|Client Example|funding|"country"/,
        )
        const card = (line.data as any).card
        if (card) expect(Object.keys(card).sort()).toEqual(["brand", "exp", "last4"])
      }
    }
    expect(out.card).toEqual({ brand: "visa", last4: "4242", exp: "12/2030" })
    expect(JSON.stringify(out)).not.toContain("Fp1234")
  })
})
