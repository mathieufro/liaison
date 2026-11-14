// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reporting a collection (a payment received) to the e-invoicing platform when VAT falls due on
// receipt: the amounts by VAT rate, once per payment, the true figure on a partial refund, and
// nothing for an issuer on the debits option, a reverse-charge or an out-of-scope sale. A platform
// without the op leaves the collection to enter by hand, said once on Home.
import { beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ContractEnvelope } from "@liaison/app-sdk/contracts"
import { createMockDb, type ManifestSchema } from "@liaison/test-helpers/mock-db"
import { COLLECTION_MANUAL_LABEL, collectionLabel, reportCollection } from "./collection"
import { type EinvCtx, refreshStatus } from "./transmit"

const SCHEMA = (
  JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "app.manifest.json"), "utf8")) as {
    schema: ManifestSchema
  }
).schema
type Row = Record<string, unknown>

function world(opts: { implementsOp: boolean }) {
  const db = createMockDb(
    {},
    {
      ids: "uuid",
      stampCreatedAt: true,
      bridgeWhereOperators: true,
      orderByManifestSchema: SCHEMA,
    },
  )
  const calls: Array<{ op: string; params: Row; grant: unknown }> = []
  const events: Array<{ action: string; data: Row }> = []
  const ctx: EinvCtx = {
    db: db as unknown as EinvCtx["db"],
    contracts: {
      call: async (_contract, op, params, o) => {
        if (op !== "report_collection" || !opts.implementsOp) {
          return {
            status: "error",
            error: {
              code: "contract_op_unsupported",
              message: `pennylane does not implement op "${op}"`,
            },
          } as ContractEnvelope<unknown>
        }
        calls.push({ op, params, grant: o?.grant })
        return {
          status: "completed",
          result: { state: "accepted" },
          provider: "fakepa",
        } as ContractEnvelope<unknown>
      },
    },
    emit: async (e) => {
      events.push({ action: e.action, data: e.data as Row })
    },
  }
  async function doc(over: Row = {}): Promise<Row> {
    const d = (await db.insert("documents", {
      type: "invoice",
      status: "issued",
      number: "FA-2026-0007",
      currency: "EUR",
      subtotal_minor: "15000",
      tax_total_minor: "2500",
      grand_total_minor: "17500",
      tax_treatment: "eu_domestic",
      regime: "e_invoice",
      operation_category: "services",
      vat_on_debits: false,
      ...over,
    })) as Row
    // Two rates: 100.00 at 20% and 50.00 at 10%.
    await db.insert("document_lines", {
      document_id: d.id,
      position: 1,
      description: "Conseil",
      quantity: "1",
      unit_price_minor: "10000",
      subtotal_minor: "10000",
      tax_minor: "2000",
      tax_rate_bp: 2000,
    })
    await db.insert("document_lines", {
      document_id: d.id,
      position: 2,
      description: "Formation",
      quantity: "1",
      unit_price_minor: "5000",
      subtotal_minor: "5000",
      tax_minor: "500",
      tax_rate_bp: 1000,
    })
    await db.insert("einvoice_transmissions", {
      document_id: d.id,
      action: "send_einvoice",
      idempotency_key: `k-${String(d.id)}`,
      state: "sent",
      provider_app: "fakepa",
      provider_ref: "pa-77",
      attempts: 1,
    })
    return d
  }
  const one = async (id: unknown) =>
    ((await db.findMany("documents", { where: { id }, limit: 1 })) as Row[])[0]
  return { db, ctx, calls, events, doc, one }
}

describe("reporting a collection", () => {
  let w: ReturnType<typeof world>
  beforeEach(() => {
    w = world({ implementsOp: true })
  })

  it("the fake provider gets the amounts by VAT rate once on paid and the true figure on partial and refund; debits, reverse charge and out of scope send nothing", async () => {
    const d = await w.doc()
    const paid = { kind: "paid" as const, amount_minor: 17500n, date: "2026-11-20", ref: "paid" }
    expect(await reportCollection(w.ctx, String(d.id), paid)).toMatchObject({ state: "reported" })
    // The same payment again: nothing is sent twice.
    await reportCollection(w.ctx, String(d.id), paid)
    expect(w.calls).toHaveLength(1)
    expect(w.calls[0]?.params).toMatchObject({
      provider_ref: "pa-77",
      date: "2026-11-20",
      amounts_by_vat_rate: [
        { rate_bp: 1000, net_minor: "5000", vat_minor: "500" },
        { rate_bp: 2000, net_minor: "10000", vat_minor: "2000" },
      ],
    })
    expect(typeof w.calls[0]?.params.idempotency_key).toBe("string")
    // No grant: a collection is a fact, not an issuing act.
    expect(w.calls[0]?.grant ?? null).toBeNull()
    expect(await w.one(d.id)).toMatchObject({ collection_state: "reported" })
    // A partial refund of 35.00 reports minus that share of each rate.
    await reportCollection(w.ctx, String(d.id), {
      kind: "refund",
      amount_minor: 3500n,
      date: "2026-11-25",
      ref: "refund-1",
    })
    expect(w.calls).toHaveLength(2)
    expect(w.calls[1]?.params.amounts_by_vat_rate).toEqual([
      { rate_bp: 1000, net_minor: "-1000", vat_minor: "-100" },
      { rate_bp: 2000, net_minor: "-2000", vat_minor: "-400" },
    ])
    for (const over of [
      { vat_on_debits: true },
      { tax_treatment: "eu_reverse_charge" },
      { tax_treatment: "eu_export_non_eu" },
    ]) {
      const other = await w.doc(over)
      expect(await reportCollection(w.ctx, String(other.id), paid)).toMatchObject({
        state: "not_needed",
      })
      expect(collectionLabel((await w.one(other.id)) as Row)).toBe("Not needed")
    }
    expect(w.calls).toHaveLength(2)
  })

  it("a provider without the op shows To report at your platform", async () => {
    w = world({ implementsOp: false })
    const d = await w.doc()
    expect(
      await reportCollection(w.ctx, String(d.id), {
        kind: "paid",
        amount_minor: 17500n,
        date: "2026-11-20",
        ref: "paid",
      }),
    ).toMatchObject({ state: "collection_manual" })
    const row = (await w.one(d.id)) as Row
    expect(row).toMatchObject({ collection_state: "collection_manual" })
    expect(collectionLabel(row)).toBe(COLLECTION_MANUAL_LABEL)
    expect(COLLECTION_MANUAL_LABEL).toBe("To report at your platform")
    const manual = w.events.filter((e) => e.action === "collection_manual")
    expect(manual).toHaveLength(1)
    expect(manual[0]?.data).toMatchObject({ document_id: d.id, number: "FA-2026-0007" })
  })

  it("a buyer refusal opens a task and creates no document", async () => {
    // A Liaison invoice of a Stripe payment, sent, then refused by the buyer on their platform.
    const d = await w.doc({ external_ref: "stripe:in_FIXTURE07" })
    const ctx: EinvCtx = {
      ...w.ctx,
      contracts: {
        call: async () =>
          ({
            status: "completed",
            result: {
              raw: "refusee",
              mapped: "refused",
              code: 210,
              provider_ts: null,
              reason_text: "Wrong purchase order",
            },
            provider: "fakepa",
          }) as ContractEnvelope<unknown>,
      },
    }
    const before = ((await w.db.findMany("documents", { limit: 100 })) as Row[]).length
    const [tx] = (await w.db.findMany("einvoice_transmissions", {
      where: { document_id: d.id },
      limit: 1,
    })) as Row[]
    await refreshStatus(ctx, tx as Row, "webhook")
    const refused = w.events.filter((e) => e.action === "transmission_refused")
    expect(refused).toHaveLength(1)
    expect(refused[0]?.data).toMatchObject({
      document_id: d.id,
      state: "refused",
      reason: "Wrong purchase order",
    })
    // No invoice and no credit note is made by itself: a person decides.
    expect(((await w.db.findMany("documents", { limit: 100 })) as Row[]).length).toBe(before)
    expect(await w.one(d.id)).toMatchObject({ einvoice_state: "refused" })
  })
})
