// SPDX-License-Identifier: FSL-1.1-ALv2
//
// project_invoiced_get over the bridge-shaped mock: a project's invoiced amount excluding VAT,
// net of its credit notes, and the paid part.

import { describe, expect, test } from "bun:test"
import { createMockDb } from "@liaison/test-helpers/mock-db"
import manifest from "../../app.manifest.json"
import { day, projectInvoicedGet } from "./project-invoiced-get"

const PROJECT = "7a000000-0000-4000-8000-000000000001"
const OTHER = "7a000000-0000-4000-8000-000000000002"

function doc(id: string, over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `7d000000-0000-4000-8000-${id.padStart(12, "0")}`,
    type: "invoice",
    status: "issued",
    payment_status: "unpaid",
    currency: "EUR",
    subtotal_minor: 0,
    tax_total_minor: 0,
    grand_total_minor: 0,
    billing_project_id: PROJECT,
    issued_at: "2026-06-01",
    ...over,
  }
}

function ctxWith(documents: Array<Record<string, unknown>>) {
  const db = createMockDb({ seed: { documents } }, { bridgeWhereOperators: true })
  return {
    db: {
      findMany: (e: string, o?: Record<string, unknown>) => db.findMany(e, o as never),
      findOne: (e: string, id: string) => db.findOne(e, id),
      count: (e: string, o?: Record<string, unknown>) => db.count(e, o as never),
    },
  }
}

describe("project_invoiced_get", () => {
  const advance = doc("1", {
    number: "F-1",
    subtotal_minor: 1_280_000,
    grand_total_minor: 1_536_000,
    payment_status: "paid",
    status: "paid",
    issued_at: "2026-04-10",
  })
  const discovery = doc("2", { number: "F-2", subtotal_minor: 2_000_000, issued_at: "2026-05-20" })
  const design = doc("3", { number: "F-3", subtotal_minor: 1_400_000, issued_at: "2026-07-02" })
  // A credit note correcting F-3, not itself linked to the project.
  const credit = doc("4", {
    type: "credit_note",
    number: "A-1",
    subtotal_minor: -200_000,
    billing_project_id: null,
    original_document_id: design.id,
    issued_at: "2026-07-10",
  })
  const draft = doc("5", { status: "draft", subtotal_minor: 900_000 })
  const voided = doc("6", { status: "voided", subtotal_minor: 500_000 })
  const elsewhere = doc("7", { subtotal_minor: 700_000, billing_project_id: OTHER })
  const all = [advance, discovery, design, credit, draft, voided, elsewhere]

  test("invoiced is net of credit notes", async () => {
    const out = await projectInvoicedGet(ctxWith(all), { projectId: PROJECT })
    if ("error" in out) throw new Error(out.error.message)
    // 12,800 + 20,000 + 14,000 - 2,000, excluding VAT; drafts, voided and other projects left out.
    expect(out.invoicedExcl).toBe(4_480_000)
    expect(out.paidExcl).toBe(1_280_000)
    expect(out.currency).toBe("EUR")
    expect(out.documents.map((d) => [d.number, d.amountExcl])).toEqual([
      ["F-1", 1_280_000],
      ["F-2", 2_000_000],
      ["F-3", 1_400_000],
      ["A-1", -200_000],
    ])
  })

  test("a date range reads only the documents issued in it", async () => {
    const out = await projectInvoicedGet(ctxWith(all), {
      projectId: PROJECT,
      from: "2026-07-01",
      to: "2026-07-31",
    })
    if ("error" in out) throw new Error(out.error.message)
    expect(out.invoicedExcl).toBe(1_200_000)
  })

  test("a project with nothing issued reads zero and says so", async () => {
    const out = await projectInvoicedGet(ctxWith([draft]), { projectId: PROJECT })
    if ("error" in out) throw new Error(out.error.message)
    expect(out.invoicedExcl).toBe(0)
    expect(out.message).toBe("No issued invoice is linked to this project.")
  })

  test("documents in two currencies are refused, never summed", async () => {
    const out = await projectInvoicedGet(
      ctxWith([discovery, doc("8", { currency: "USD", subtotal_minor: 100 })]),
      { projectId: PROJECT },
    )
    expect("error" in out && out.error.code).toBe("mixed_currencies")
  })

  test("a malformed project id reads nothing", async () => {
    const out = await projectInvoicedGet(ctxWith(all), { projectId: "Atlas portal" })
    expect("error" in out && out.error.code).toBe("invalid_project")
  })

  test("the tool is internal, hidden from agents and a read", () => {
    const tool = (manifest.tools as Record<string, Record<string, unknown>>).project_invoiced_get
    expect(tool?.trustBoundary).toBe("internal")
    expect(tool?.agentVisible).toBe(false)
    expect(tool?.readOnly).toBe(true)
    const fields = (manifest.schema as Record<string, { fields: Record<string, unknown> }>)
      .documents?.fields
    expect(fields?.billing_project_id).toBe("uuid?")
  })
})

describe("project_invoiced_get paging and dates", () => {
  test("documents sharing one issue day across page boundaries are each counted once", async () => {
    const docs = Array.from({ length: 250 }, (_, i) =>
      doc(String(1000 + i), { number: `F-${i}`, subtotal_minor: 100, issued_at: "2026-06-01" }),
    )
    const out = await projectInvoicedGet(ctxWith(docs) as never, { projectId: PROJECT })
    if ("error" in out) throw new Error(out.error.message)
    expect(out.documents).toHaveLength(250)
    expect(new Set(out.documents.map((d) => d.id)).size).toBe(250)
    expect(out.invoicedExcl).toBe(25_000)
  })

  test("drafts are left out by the query, so they never fill the cap", async () => {
    const docs = [
      ...Array.from({ length: 120 }, (_, i) => doc(String(2000 + i), { status: "draft" })),
      doc("2999", { subtotal_minor: 700 }),
    ]
    const out = await projectInvoicedGet(ctxWith(docs) as never, { projectId: PROJECT })
    if ("error" in out) throw new Error(out.error.message)
    expect(out.invoicedExcl).toBe(700)
  })

  test("more documents than one answer reads is a refusal, never a partial sum", async () => {
    const docs = Array.from({ length: 5001 }, (_, i) =>
      doc(String(10_000 + i), { subtotal_minor: 1 }),
    )
    const out = await projectInvoicedGet(ctxWith(docs) as never, { projectId: PROJECT })
    expect("error" in out && out.error.code).toBe("too_many_documents")
  })

  test("an issue date handed back as a Date keeps its calendar day", () => {
    expect(day(new Date(2026, 10, 1))).toBe("2026-11-01")
    expect(day(new Date(Date.UTC(2026, 10, 1)))).toBe("2026-11-01")
    expect(day("2026-11-01 00:00:00+00")).toBe("2026-11-01")
  })
})
