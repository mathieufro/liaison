// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A Stripe invoice and a Stripe refund's credit note are issued with no person, so their
// e-invoices go out like every other no-person issue: the card stream's standing authorization
// when it is on, else the daily send card. Neither asks for its own send card. An invoice a
// person issued by hand keeps its own send card.
import { describe, expect, test } from "bun:test"
import type { MockDb } from "../test-db"
import { onStripeInvoiceFinalized } from "./stripe-invoice-finalized"
import { creditNotes, finalized, invoices, stripeCtx, stripeDb } from "./stripe-money.testkit"
import { onStripeRefundCreated } from "./stripe-refund-created"

type Row = Record<string, unknown>

/** The document types read back by id as a domestic e-invoice. */
const eTypes = new Set<string>()

/** Sending switched on, and documents of `eTypes` read back by id as domestic e-invoices. */
async function sendingDb(): Promise<MockDb> {
  eTypes.clear()
  eTypes.add("invoice")
  const db = stripeDb()
  await db.insert("einvoicing_settings", {
    provider_app: "pennylane",
    send_enabled: true,
    cutover_date: "2020-01-01",
  })
  const findMany = db.findMany.bind(db)
  db.findMany = (async (entity: string, q?: { where?: Row }) => {
    const rows = (await findMany(entity, q as never)) as Row[]
    return entity === "documents" && q?.where?.id
      ? rows.map((r) => (eTypes.has(String(r.type)) ? { ...r, regime: "e_invoice" } : r))
      : rows
  }) as typeof db.findMany
  return db
}

const sendCards = (asked: Row[]) =>
  asked.filter((a) => String(a.tool_name ?? "").includes("einvoice_send"))

describe("Stripe documents and the e-invoice send path", () => {
  test("an invoice issued from Stripe and its refund's credit note wait for the daily send card", async () => {
    const db = await sendingDb()
    const asked: Row[] = []
    const ctx = stripeCtx(db, {
      requestApproval: (async (input: Row) => {
        asked.push(input)
        return { approval_id: `appr-${asked.length}` }
      }) as never,
    })
    const r = await onStripeInvoiceFinalized(finalized({ charge_id: "ch_1" }), ctx)
    expect(r.status).toBe("ok")
    const inv = invoices(db)[0] as Row
    expect(inv.einvoice_state).toBe("awaiting_send_batch")

    // From here only the credit note reads as an e-invoice: the original's own gate stays as stored.
    eTypes.clear()
    eTypes.add("credit_note")
    await onStripeRefundCreated(
      {
        charge_id: "ch_1",
        invoice_id: "in_1",
        refunds: [{ id: "re_1", amount_minor: "1200", status: "succeeded" }],
      },
      ctx,
    )
    const cn = creditNotes(db)[0] as Row
    expect(cn.einvoice_state).toBe("awaiting_send_batch")
    expect(sendCards(asked)).toHaveLength(0)
  })

  test("an invoice a person issues from a Stripe payment keeps its own send request", async () => {
    const db = await sendingDb()
    const ctx = stripeCtx(db)
    const r = await onStripeInvoiceFinalized(finalized({ charge_id: "ch_1" }), ctx, {
      byPerson: true,
    })
    expect(r.status).toBe("ok")
    expect((invoices(db)[0] as Row).einvoice_state).not.toBe("awaiting_send_batch")
  })
})
