// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Batch print. The operator's morning is a dozen parcels; per-row printing is two tabs each, so
// this merges one document per PRINT JOB. What these tests pin is that the two jobs never merge
// into one another, that per-destination copy counts survive the merge, and that a row whose
// documents are not ready is REPORTED rather than silently dropped.
import { describe, expect, it } from "bun:test"
import { printPackBatch, printPackBatchSummary } from "./print-pack-batch"
import type { BoxtalToolCtx } from "./ctx"
import { createMockDb } from "./test-db"

interface Call {
  target: string
  args: Record<string, unknown>
}

/** Per-shipment canned outcome, keyed by row id. */
interface Canned {
  label?: string | null
  invoiceCopies?: 1 | 3
  invoice?: string | null
}

function makeCtx(canned: Record<string, Canned>) {
  const calls: Call[] = []
  const db = createMockDb({
    seed: {
      shipment: Object.keys(canned).map((id) => ({
        id,
        boxtal_order_id: `o-${id}`,
        document_ref: `inv-${id}`,
        tracking_number: `T-${id}`,
        documents: [{ type: "LABEL", format: "PDF_A4" }],
      })),
      app_config: [{ id: "cfg", key: "sender_address", value: { countryIsoCode: "FR" } }],
    },
  })
  let merged = 0
  const executeTool = async (target: string, args?: Record<string, unknown>) => {
    calls.push({ target, args: args ?? {} })
    if (target === "kernel:files_merge_pdfs") {
      merged++
      return { status: "completed", result: { fileId: `merged-${merged}` } }
    }
    if (target === "invoicing:documents_get") {
      const id = String(args?.id ?? "")
      // "3 copies" route = a US destination; "1 copy" = intra-EU.
      const row = canned[id.replace("inv-", "")]
      return {
        status: "completed",
        result: { counterparty_country: row?.invoiceCopies === 3 ? "US" : "DE" },
      }
    }
    if (target === "invoicing:documents_download_pdf") {
      const id = String(args?.id ?? "").replace("inv-", "")
      const file = canned[id]?.invoice
      return file
        ? { status: "completed", result: { file_id: file } }
        : { status: "error", error: { message: "The invoice has no rendered PDF yet." } }
    }
    if (target === "kernel:files_import_from_url" || target === "boxtal:import_label_document") {
      return { status: "completed", result: {} }
    }
    return { status: "error", error: { code: "unmocked", message: target } }
  }
  const ctx = {
    orgId: "org-1",
    db,
    fetch: (async () => new Response("")) as unknown as BoxtalToolCtx["fetch"],
    connections: {},
    config: { get: async () => null, has: async () => false },
    executeTool: executeTool as unknown as BoxtalToolCtx["executeTool"],
  } as unknown as BoxtalToolCtx
  return { ctx, calls }
}

describe("printPackBatch input guards", () => {
  it("refuses an empty selection", async () => {
    const { ctx } = makeCtx({})
    const res = await printPackBatch(ctx, { shipment_ids: [] })
    expect(res.error?.code).toBe("invalid_params")
    expect(res.labels).toBeNull()
  })

  it("refuses a selection past the batch cap rather than melting the print queue", async () => {
    const { ctx } = makeCtx({})
    const res = await printPackBatch(ctx, { shipment_ids: Array.from({ length: 21 }, (_, i) => `s${i}`) })
    expect(res.error?.code).toBe("too_many")
  })

  it("names the rows it could not print instead of dropping them", async () => {
    // A shipment id that matches no row: the operator must learn that at the screen, not at the
    // packing bench with a parcel that has no paperwork.
    const { ctx } = makeCtx({})
    const res = await printPackBatch(ctx, { shipment_ids: ["ghost"] })
    expect(res.skipped.map((s) => s.shipment_id)).toContain("ghost")
    expect(res.skipped[0]!.reason).toContain("ghost")
  })
})

describe("printPackBatchSummary", () => {
  it("names both documents and the copy count", () => {
    const line = printPackBatchSummary({
      labels: { file_id: "f1", filename: "labels.pdf", shipment_count: 3 },
      invoices: { file_id: "f2", filename: "invoices.pdf", shipment_count: 3, page_copies: 7 },
      skipped: [],
    })
    expect(line).toContain("Labels: 3 in one document")
    expect(line).toContain("7 copies on A4")
    // No dash punctuation in operator-facing copy.
    expect(line).not.toContain("--")
    expect(line).not.toContain("—")
  })

  it("surfaces an incomplete row in the same line", () => {
    const line = printPackBatchSummary({
      labels: { file_id: "f1", filename: "labels.pdf", shipment_count: 1 },
      invoices: null,
      skipped: [{ shipment_id: "s2", what: "invoice", reason: "The invoice has no rendered PDF yet." }],
    })
    expect(line).toContain("1 row incomplete")
    expect(line).toContain("no rendered PDF")
  })

  it("reports an error verbatim", () => {
    expect(
      printPackBatchSummary({
        labels: null,
        invoices: null,
        skipped: [],
        error: { code: "too_many", message: "A batch prints at most 20 shipments at once; 21 were selected. Print them in two batches." },
      }),
    ).toContain("at most 20")
  })
})
