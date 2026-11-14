// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The seeded card mirror read back the way the payments app reads it: each row
// turned into the processor's object by the demo stand-in, then rebuilt by the
// app's own row builders, gives back the row that was seeded. So the app's
// reconcile and probe over a stand-in install rewrite nothing.
import { describe, expect, it } from "bun:test"
import {
  chargeObject,
  customerObject,
  disputeObject,
  invoiceObject,
  subscriptionObject,
} from "~/modules/demo/worlds/saas/payments/objects"
import { seedContext } from "~/seed/context"
import { saasPaymentsMirrorSpec } from "~/seed/worlds/saas/layer"
import { saasMoneyPlan, saasPlan } from "~/seed/worlds/saas/plan"
import {
  customerRow,
  disputeRow,
  invoiceRow,
  newTally,
  paymentRow,
  subscriptionRow,
} from "../../../../../../bundled-apps/stripe/src/mirror"
import { paymentsMirrorRows } from "./mirror"

type Obj = Record<string, unknown>

const ORG = "6f1c2a7e-0b3d-4c5e-9f80-1a2b3c4d5e6f"

function rowsAt(anchor: Date) {
  const ctx = seedContext({ orgId: ORG, now: anchor })
  const spec = saasPaymentsMirrorSpec(saasMoneyPlan(anchor), saasPlan(anchor), {
    companyIds: {},
    contactIds: {},
    documentId: (key) => ctx.id("document", key),
    nextAttempt: new Date(Math.floor(anchor.getTime() / 1000) * 1000 + 86_400_000),
  })
  const r = paymentsMirrorRows(ctx, spec)
  const plain = (rows: readonly Obj[]) =>
    rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cell(v)])))
  return {
    customers: plain(r.customers),
    subscriptions: plain(r.subscriptions),
    invoices: plain(r.invoices),
    payments: plain(r.payments),
    disputes: plain(r.disputes),
  }
}

/** A seeded cell as the database hands it back: JSON unwrapped. */
function cell(v: unknown): unknown {
  return v !== null && typeof v === "object" && "__json" in (v as Obj) ? (v as Obj).__json : v
}

function expectRoundTrip(seeded: Obj, rebuilt: Obj): void {
  for (const [key, value] of Object.entries(rebuilt)) {
    expect({ key, value: seeded[key] }).toEqual({ key, value })
  }
}

describe("the seeded card mirror read back through the stand-in", () => {
  for (const anchor of [
    new Date("2026-11-09T08:30:00Z"),
    new Date("2026-11-30T21:45:12.345Z"),
    new Date("2027-03-01T06:05:00Z"),
  ]) {
    const at = anchor.toISOString()
    const rows = rowsAt(anchor)

    it(`every subscription rebuilds to its seeded row, plan name and amount included, at ${at}`, () => {
      expect(rows.subscriptions.length).toBeGreaterThan(169)
      for (const r of rows.subscriptions) {
        expectRoundTrip(r, subscriptionRow(subscriptionObject(r, false), newTally(), anchor))
      }
    })

    it(`every customer, invoice, charge and dispute rebuilds to its seeded row, at ${at}`, () => {
      for (const r of rows.customers)
        expectRoundTrip(r, customerRow(customerObject(r, false), newTally()))
      for (const r of rows.invoices)
        expectRoundTrip(r, invoiceRow(invoiceObject(r, false), newTally()))
      for (const r of rows.payments)
        expectRoundTrip(r, paymentRow(chargeObject(r, false), newTally()))
      for (const r of rows.disputes)
        expectRoundTrip(r, disputeRow(disputeObject(r, false), newTally()))
    })

    it(`no row holds an address off the reserved domain, a card other than the two test cards, or a key, at ${at}`, () => {
      for (const r of rows.customers) expect(String(r.email)).toMatch(/@[a-z0-9.-]+\.example$/)
      for (const r of [...rows.payments, ...rows.subscriptions]) {
        expect(["4242", "5108"]).toContain(String(r.card_last4))
      }
      const text = JSON.stringify(rows)
      expect(text).not.toMatch(/(?<![A-Za-z0-9])(?:rk|sk|pk)_(?:live|test)_|whsec_/)
    })
  }
})
