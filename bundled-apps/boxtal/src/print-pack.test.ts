// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Print pack — two SEPARATE print jobs per ready-to-ship row:
//   label (orientation-normalized via a unary kernel merge) + invoice (A4,
//   1 copy EU/domestic, 3 copies export non-EU). Never one combined PDF.
import { describe, expect, it } from "bun:test"
import { invoiceCopiesFor, printPack } from "./print-pack"
import { createMockDb } from "./test-db"
import type { BoxtalToolCtx } from "./ctx"

/** Shipment row ids are UUIDs: only a UUID-shaped ref is looked up by row id. */
const ROW_1 = "5a1e0000-0000-4000-8000-000000000001"

const CREDS = { v1Key: "k1", v1Secret: "s1", v3Key: "k3", v3Secret: "s3", environment: "sandbox" }

describe("invoiceCopiesFor — route-driven A4 copy count", () => {
  it("1 copy for domestic and intra-EU routes", () => {
    expect(invoiceCopiesFor("FR", "FR")).toEqual({ copies: 1, reason: "eu_or_domestic" })
    expect(invoiceCopiesFor("FR", "DE")).toEqual({ copies: 1, reason: "eu_or_domestic" })
    expect(invoiceCopiesFor("fr", "es")).toEqual({ copies: 1, reason: "eu_or_domestic" })
  })
  it("3 copies for exports outside the EU (and for an unknown destination)", () => {
    expect(invoiceCopiesFor("FR", "US")).toEqual({ copies: 3, reason: "export_non_eu" })
    expect(invoiceCopiesFor("FR", "GB")).toEqual({ copies: 3, reason: "export_non_eu" })
    expect(invoiceCopiesFor("FR", "CH")).toEqual({ copies: 3, reason: "export_non_eu" })
    expect(invoiceCopiesFor("FR", null)).toEqual({ copies: 3, reason: "export_non_eu" })
  })
  it("a non-EU sender shipping domestically still needs only 1 copy", () => {
    expect(invoiceCopiesFor("US", "US")).toEqual({ copies: 1, reason: "eu_or_domestic" })
  })
})

interface MakeOpts {
  destinationCountry?: string
  labelDocs?: Array<{ url?: string; type: string; format: string }>
  mergeFails?: boolean
  invoicePdfFileId?: string | null
  /** The invoicing document's status as documents_get reports it (default issued). */
  docStatus?: string
  /** documents_retry_pdf's answer; default renders "f-rendered". */
  retry?: unknown
  /** The row's carrier order id (default "ord-1"). */
  boxtalOrderId?: string
  /** Make the db refuse a non-UUID `id` filter the way postgres does (22P02). */
  strictUuid?: boolean
}

function makeCtx(opts: MakeOpts = {}) {
  const db = createMockDb({
    seed: {
      shipment: [
        {
          id: ROW_1,
          boxtal_order_id: opts.boxtalOrderId ?? "ord-1",
          document_ref: "doc-1",
          tracking_number: "TRK123",
          order_status: "CONFIRMED",
          kind: "outbound",
        },
      ],
      app_config: [
        { id: "cfg-sender", key: "sender_address", value: { countryIsoCode: "FR" } },
      ],
    },
  })
  if (opts.strictUuid) {
    const findMany = db.findMany.bind(db)
    db.findMany = (async (table: string, q: { where?: Record<string, unknown> }) => {
      const id = q?.where?.id
      if (typeof id === "string" && !/^[0-9a-f-]{36}$/i.test(id)) {
        throw new Error(`findMany failed - pg: invalid input syntax for type uuid: "${id}" (22P02)`)
      }
      return findMany(table, q as never)
    }) as typeof db.findMany
  }
  const crossCalls: Array<{ target: string; args: unknown }> = []
  const importCalls: string[] = []
  const fetch = async (url: string) => {
    if (url.includes("/iam/account-app/token")) {
      return { status: 200, headers: {}, body: JSON.stringify({ accessToken: "tok", expiresIn: 3600 }) }
    }
    if (url.includes("/shipping-document")) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          status: 200,
          timestamp: "t",
          content: opts.labelDocs ?? [{ url: "https://document.boxtal.com/label.pdf", type: "LABEL", format: "PDF_A4" }],
        }),
      }
    }
    return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: {} }) }
  }
  const executeTool = async (target: string, args: unknown) => {
    crossCalls.push({ target, args })
    if (target === "kernel:files_merge_pdfs") {
      return opts.mergeFails
        ? { status: "error", error: { code: "merge_failed", message: "pdf pipeline down" } }
        : { status: "completed", result: { fileId: "f-normalized", pageCount: 1 } }
    }
    if (target === "invoicing:documents_get") {
      return {
        status: "completed",
        result: { id: "doc-1", status: opts.docStatus ?? "issued", counterparty_country: opts.destinationCountry ?? "US" },
      }
    }
    if (target === "invoicing:documents_retry_pdf") {
      return (
        opts.retry ?? {
          status: "completed",
          result: { status: "completed", document_id: "doc-1", pdf_file_id: "f-rendered" },
        }
      )
    }
    if (target === "invoicing:documents_download_pdf") {
      const fid = opts.invoicePdfFileId === undefined ? "f-invoice" : opts.invoicePdfFileId
      return fid
        ? { status: "completed", result: { file_id: fid, url: `/api/files/${fid}/inline` } }
        : { status: "completed", result: { file_id: null, url: null } }
    }
    return { status: "error", error: { code: "unmocked", message: target } }
  }
  const ctx = {
    orgId: "org-1",
    db,
    fetch,
    executeTool,
    files_importFromUrl: async (json: string) => {
      importCalls.push(json)
      return JSON.stringify({ id: "f-label-raw" })
    },
    connections: {
      boxtal: {
        getSettings: async () => ({ values: { environment: CREDS.environment }, missing: [] }),
        getToken: async () => {
          throw new Error("no")
        },
        getAccounts: async () => [],
      },
    },
    config: { get: async () => null, has: async () => false },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as never as BoxtalToolCtx
  return { ctx, crossCalls, importCalls, db }
}

describe("print_pack — two separate jobs, never merged together", () => {
  it("export route: normalized label + invoice with 3 copies, as two distinct files", async () => {
    const { ctx, crossCalls } = makeCtx({ destinationCountry: "US" })
    const res = await printPack(ctx, { shipment_id: ROW_1 })
    expect(res.error).toBeUndefined()
    // Job 1: the label went through the unary normalization merge — label file ONLY.
    const merge = crossCalls.find((c) => c.target === "kernel:files_merge_pdfs")!
    expect(merge).toBeDefined()
    expect((merge.args as { file_ids: string[] }).file_ids).toEqual(["f-label-raw"])
    expect(res.label).toMatchObject({ file_id: "f-normalized" })
    // Job 2: the invoice is a DIFFERENT file, never folded into the label merge.
    expect(res.invoice.file_id).toBe("f-invoice")
    expect(res.invoice.file_id).not.toBe(res.label!.file_id)
    expect(res.invoice).toMatchObject({ copies: 3, reason: "export_non_eu" })
  })

  it("intra-EU route: invoice copies = 1", async () => {
    const { ctx } = makeCtx({ destinationCountry: "DE" })
    const res = await printPack(ctx, { shipment_id: ROW_1 })
    expect(res.invoice).toMatchObject({ copies: 1, reason: "eu_or_domestic" })
  })

  it("label not served yet: label null with a readable label_error, invoice job still prepared", async () => {
    const { ctx } = makeCtx({ labelDocs: [] })
    const res = await printPack(ctx, { shipment_id: ROW_1 })
    expect(res.label).toBeNull()
    expect(res.label_error).toMatch(/label/i)
    expect(res.invoice.file_id).toBe("f-invoice")
  })

  it("normalization failure degrades to the RAW label (prints, worst case sideways) with a warning", async () => {
    const { ctx } = makeCtx({ mergeFails: true })
    const res = await printPack(ctx, { shipment_id: ROW_1 })
    expect(res.label).toMatchObject({ file_id: "f-label-raw" })
    expect(res.label_error).toMatch(/normaliz/i)
  })

  it("unknown shipment id returns a typed not_found error", async () => {
    const { ctx } = makeCtx()
    const res = await printPack(ctx, { shipment_id: "nope" })
    expect(res.error?.code).toBe("not_found")
  })

  it("a carrier order id (not a UUID) resolves by boxtal_order_id, never reaching the uuid id column", async () => {
    // Prod/demo report: print_pack(shipment_id: "DEMO-F04FFA64") failed on a database error
    // ("invalid input syntax for type uuid") because the id lookup ran first with the raw ref.
    const { ctx } = makeCtx({ boxtalOrderId: "DEMO-F04FFA64", strictUuid: true })
    const res = await printPack(ctx, { shipment_id: "DEMO-F04FFA64" })
    expect(res.error).toBeUndefined()
    expect(res.invoice.file_id).toBe("f-invoice")
  })

  it("an unknown carrier order id is a typed not_found, not a database error", async () => {
    const { ctx } = makeCtx({ strictUuid: true })
    const res = await printPack(ctx, { shipment_id: "DEMO-00000000" })
    expect(res.error?.code).toBe("not_found")
  })
})

describe("print_pack — an issued invoice with no PDF yet", () => {
  it("renders it on demand through invoicing's retry_pdf and serves the rendered file", async () => {
    const { ctx, crossCalls } = makeCtx({ invoicePdfFileId: null })
    const res = await printPack(ctx, { shipment_id: ROW_1 })
    expect(crossCalls.some((c) => c.target === "invoicing:documents_retry_pdf")).toBe(true)
    expect(res.invoice.file_id).toBe("f-rendered")
    expect(res.invoice_error).toBeUndefined()
  })

  it("a render that fails says what to do instead of 'no rendered PDF yet'", async () => {
    const { ctx } = makeCtx({
      invoicePdfFileId: null,
      retry: { status: "completed", result: { status: "error", error: { code: "render_failed", message: "template error" } } },
    })
    const res = await printPack(ctx, { shipment_id: ROW_1 })
    expect(res.invoice.file_id).toBeNull()
    expect(res.invoice_error).toContain("template error")
    expect(res.invoice_error).toContain("Retry PDF")
  })

  it("a render refused by the platform also names the way out", async () => {
    const { ctx } = makeCtx({
      invoicePdfFileId: null,
      retry: { status: "error", error: { code: "forbidden", message: "missing scope" } },
    })
    const res = await printPack(ctx, { shipment_id: ROW_1 })
    expect(res.invoice.file_id).toBeNull()
    expect(res.invoice_error).toContain("Retry PDF")
  })

  it("a draft invoice is never rendered for printing: issue it first", async () => {
    const { ctx, crossCalls } = makeCtx({ invoicePdfFileId: null, docStatus: "draft" })
    const res = await printPack(ctx, { shipment_id: ROW_1 })
    expect(crossCalls.some((c) => c.target === "invoicing:documents_retry_pdf")).toBe(false)
    expect(res.invoice_error).toMatch(/draft/i)
  })

  it("a ready PDF is served as is, with no render", async () => {
    const { ctx, crossCalls } = makeCtx()
    await printPack(ctx, { shipment_id: ROW_1 })
    expect(crossCalls.some((c) => c.target === "invoicing:documents_retry_pdf")).toBe(false)
  })
})
