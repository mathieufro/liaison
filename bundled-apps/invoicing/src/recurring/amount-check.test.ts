// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A month-end row whose amount is far from the last issued invoice of its schedule (a slipped
// decimal, a dropped digit) asks for a look on the card, on the row and in the run's read. A row
// with nothing to compare with is never flagged.
import { describe, expect, test } from "bun:test"
import { harness, previousDoc, schedule } from "../__fixtures__/recurring-draft"
import { recurringDraftJob } from "./draft-job"
import { amountFarFlag } from "./flags"
import { afterRunWrite, type EditCtx } from "./restage"
import { cardItems } from "./run-card"
import { recurringRunGet } from "./run-get"

const SCHED = "33333333-3333-4333-8333-333333333331"
const PREV = "44444444-4444-4444-8444-444444444441"

/** A run drafted on 27 Nov for one schedule billing `price` a month, after October billed `lastPrice`. */
async function drafted(price: number, lastPrice: string | null) {
  const prev = previousDoc(PREV, true)
  const lines = [
    {
      description: "Retainer {period}",
      qty: 1,
      unit_price_minor: price,
      vat_bp: 2000,
      line_kind: "service",
    },
  ]
  const h = harness(
    "2026-11-27",
    lastPrice === null
      ? { schedules: [schedule(SCHED, { lines })] }
      : {
          schedules: [schedule(SCHED, { lines, last_document_id: prev.id })],
          docs: [prev],
          lines: [
            {
              id: "l-prev",
              document_id: PREV,
              position: 1,
              description: "Retainer November 2026",
              quantity: "1",
              unit_price_minor: lastPrice,
              tax_rate_bp: 2000,
              subtotal_minor: lastPrice,
            },
          ],
          items: [
            {
              id: "i-prev",
              run_id: "r-old",
              schedule_id: SCHED,
              period_key: "2026-10",
              period_start: "2026-10-01",
              period_end: "2026-10-31",
              document_id: PREV,
              position: 1,
              state: "issued",
            },
          ],
        },
  )
  await recurringDraftJob(h.ctx)
  const run = h.db.__all("recurring_runs")[0]
  const item = h.db.__all("recurring_run_items").find((i) => i.period_key === "2026-11")
  return { h, runId: String(run?.id), item }
}

describe("the month-end amount check", () => {
  test("a row billing a hundred times last month asks for a look on the row, the card and the run's read", async () => {
    const { h, runId, item } = await drafted(1_490_000, "14900")
    expect(String(item?.note)).toContain("Check the amount: October was 149.00 EUR excl.")
    // The row stays on the card, where the approver reads the flag beside its amount.
    expect(item?.state).toBe("ready")
    const card = await cardItems(h.ctx, runId)
    expect(card.lines[0]).toContain("Check the amount: October was 149.00 EUR excl.")
    const got = await recurringRunGet(h.ctx, { run_id: runId })
    if (got.status !== "completed") throw new Error("run not read")
    expect(got.rows[0]?.flags).toContain("Check the amount: October was 149.00 EUR excl.")
    expect(got.message).toContain(
      "1 row bills far from the last invoice of its schedule (Maison Sauvan)",
    )
  })

  test("a row billing a fifth or less of last month asks for a look too", async () => {
    const { item } = await drafted(1_490, "149000")
    expect(String(item?.note)).toContain("Check the amount: October was 1490.00 EUR excl.")
  })

  test("a normal month, a price rise included, is not flagged", async () => {
    for (const price of [14_900, 18_000, 60_000]) {
      const { h, runId, item } = await drafted(price, "14900")
      expect(String(item?.note)).not.toContain("Check the amount")
      const got = await recurringRunGet(h.ctx, { run_id: runId })
      if (got.status !== "completed") throw new Error("run not read")
      expect(got.message).not.toContain("far from the last invoice")
    }
  })

  test("a first invoice, with nothing to compare with, is not flagged", async () => {
    const { item } = await drafted(1_490_000, null)
    expect(String(item?.note)).toContain("First invoice")
    expect(String(item?.note)).not.toContain("Check the amount")
  })

  test("an edit that types the amount a hundred times too high flags the row, and fixing it clears the flag", async () => {
    const { h, runId, item } = await drafted(14_900, "14900")
    expect(String(item?.note)).toBe("Same as October")
    const line = h.db.__all("document_lines").find((l) => l.document_id === item?.document_id)
    await h.db.update("document_lines", String(line?.id), {
      unit_price_minor: "1490000",
      subtotal_minor: "1490000",
    })
    await afterRunWrite(h.ctx as unknown as EditCtx, String(item?.id))
    const typo = h.db.__all("recurring_run_items").find((i) => i.id === item?.id)
    expect(String(typo?.note)).toBe(
      "Changed since October · Check the amount: October was 149.00 EUR excl.",
    )
    const got = await recurringRunGet(h.ctx, { run_id: runId })
    if (got.status !== "completed") throw new Error("run not read")
    expect(got.message).toContain("bills far from the last invoice")
    await h.db.update("document_lines", String(line?.id), {
      unit_price_minor: "14900",
      subtotal_minor: "14900",
    })
    await afterRunWrite(h.ctx as unknown as EditCtx, String(item?.id))
    const fixed = h.db.__all("recurring_run_items").find((i) => i.id === item?.id)
    expect(String(fixed?.note)).toBe("Same as October")
  })

  test("the threshold is five times up or a fifth down, and zero amounts are never compared", () => {
    const prev = {
      period_key: "2026-10",
      net_minor: 10_000n,
      lines_signature: "",
      payment_status: "paid",
      currency: "EUR",
    }
    expect(amountFarFlag(prev, { net_minor: 49_999n })).toBeNull()
    expect(amountFarFlag(prev, { net_minor: 50_000n })).not.toBeNull()
    expect(amountFarFlag(prev, { net_minor: 2_001n })).toBeNull()
    expect(amountFarFlag(prev, { net_minor: 2_000n })).not.toBeNull()
    expect(amountFarFlag(prev, { net_minor: 0n })).toBeNull()
    expect(amountFarFlag({ ...prev, net_minor: 0n }, { net_minor: 50_000n })).toBeNull()
    expect(amountFarFlag(null, { net_minor: 50_000n })).toBeNull()
  })
})
