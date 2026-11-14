// SPDX-License-Identifier: FSL-1.1-ALv2
//
// project_invoiced_get: what a project has been invoiced, excluding VAT and net of credit notes,
// and how much of it is paid. Internal: the projects app reads it for a project's margin and its
// money left to invoice, through its declared cross-app call; no agent sees it.
//
// A document belongs to a project when its `billing_project_id` names it. A credit note counts
// against the project when it names the project itself or corrects one of the project's
// invoices (`original_document_id`). Drafts, documents waiting for approval, voided and
// cancelled documents count for nothing. Amounts are in the currency's minor unit.

import type { ReadsDb } from "../reads"

export interface ProjectInvoicedInput {
  projectId?: string
  /** Inclusive lower bound on the issue date, YYYY-MM-DD. */
  from?: string | null
  /** Inclusive upper bound on the issue date, YYYY-MM-DD. */
  to?: string | null
}

export interface ProjectInvoicedDocument {
  id: string
  number: string | null
  type: "invoice" | "credit_note"
  status: string
  issuedAt: string | null
  currency: string
  /** What the document adds to the project's invoiced amount: negative for a credit note. */
  amountExcl: number
  paid: boolean
}

export type ProjectInvoicedResult =
  | {
      projectId: string
      /** Excluding VAT, net of credit notes, in minor units. */
      invoicedExcl: number
      /** Excluding VAT, of the invoices marked paid, in minor units. */
      paidExcl: number
      currency: string | null
      documents: ProjectInvoicedDocument[]
      message: string
    }
  | { error: { code: string; message: string; next?: string; retryable: false } }

/** Documents that count once issued: a draft or a cancelled one is not invoiced. */
const COUNTED = new Set(["issued", "sent", "fulfilled", "paid", "overdue", "refunded"])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/
const PAGE = 100
const MAX_DOCUMENTS = 5000

type Row = Record<string, unknown>

/** More documents than one answer reads: the caller is refused rather than handed a partial sum. */
class TooManyDocuments extends Error {}

async function all(db: ReadsDb, where: Record<string, unknown>): Promise<Row[]> {
  const out: Row[] = []
  // Ordered on a unique key, so no row moves between pages while they are read.
  for (let offset = 0; ; offset += PAGE) {
    const page = (await db.findMany("documents", {
      where,
      orderBy: { issued_at: "asc", id: "asc" },
      limit: PAGE,
      offset,
    })) as Row[]
    out.push(...page)
    if (page.length < PAGE) return out
    if (out.length >= MAX_DOCUMENTS) throw new TooManyDocuments()
  }
}

/**
 * The civil date of `issued_at`, a DATE column: the date part of what the driver hands back
 * ("2026-11-01 00:00:00+00" or "2026-11-01"), or a Date's own calendar day, never shifted to UTC.
 */
export const day = (v: unknown): string | null => {
  if (v == null) return null
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    const local = v.getHours() === 0 && v.getMinutes() === 0 && v.getSeconds() === 0
    const [y, m, d] = local
      ? [v.getFullYear(), v.getMonth() + 1, v.getDate()]
      : [v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate()]
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
  }
  return String(v).slice(0, 10)
}

const minor = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0)
  return Number.isFinite(n) ? Math.round(n) : 0
}

function refused(code: string, message: string): ProjectInvoicedResult {
  return { error: { code, message, retryable: false } }
}

export async function projectInvoicedGet(
  ctx: { db: ReadsDb },
  input: ProjectInvoicedInput,
): Promise<ProjectInvoicedResult> {
  const projectId = typeof input?.projectId === "string" ? input.projectId.trim() : ""
  if (!UUID.test(projectId)) {
    return refused("invalid_project", "projectId is not a project id. Nothing was read.")
  }
  const from = input.from ?? null
  const to = input.to ?? null
  if ((from !== null && !DAY.test(from)) || (to !== null && !DAY.test(to))) {
    return refused("invalid_date", "from and to are dates written YYYY-MM-DD. Nothing was read.")
  }

  const counted = { in: [...COUNTED] }
  let own: Row[]
  let corrections: Row[]
  try {
    own = await all(ctx.db, {
      billing_project_id: projectId,
      type: { in: ["invoice", "credit_note"] },
      status: counted,
    })
    const invoiceIds = own.filter((r) => r.type === "invoice").map((r) => String(r.id))
    corrections =
      invoiceIds.length > 0
        ? await all(ctx.db, {
            type: "credit_note",
            original_document_id: { in: invoiceIds },
            status: counted,
          })
        : []
  } catch (err) {
    if (!(err instanceof TooManyDocuments)) throw err
    return refused(
      "too_many_documents",
      `This project has more than ${MAX_DOCUMENTS} invoices and credit notes, more than one answer reads. Nothing was summed.`,
    )
  }

  const seen = new Set<string>()
  const documents: ProjectInvoicedDocument[] = []
  for (const r of [...own, ...corrections]) {
    const id = String(r.id)
    if (seen.has(id)) continue
    seen.add(id)
    const status = String(r.status ?? "")
    if (!COUNTED.has(status)) continue
    const issuedAt = day(r.issued_at)
    if (from !== null && (issuedAt === null || issuedAt < from)) continue
    if (to !== null && (issuedAt === null || issuedAt > to)) continue
    const type = r.type === "credit_note" ? "credit_note" : "invoice"
    const net = Math.abs(minor(r.subtotal_minor))
    documents.push({
      id,
      number: typeof r.number === "string" ? r.number : null,
      type,
      status,
      issuedAt,
      currency: String(r.currency ?? ""),
      amountExcl: type === "credit_note" ? -net : net,
      paid: type === "invoice" && (r.payment_status === "paid" || status === "paid"),
    })
  }
  documents.sort((a, b) => (a.issuedAt ?? "").localeCompare(b.issuedAt ?? ""))

  const currencies = [...new Set(documents.map((d) => d.currency))]
  if (currencies.length > 1) {
    return {
      error: {
        code: "mixed_currencies",
        message: `This project's documents are in ${currencies.join(" and ")}, so they do not add up to one amount. Nothing was summed.`,
        next: "Read the documents one by one with documents_search.",
        retryable: false,
      },
    }
  }
  const invoicedExcl = documents.reduce((s, d) => s + d.amountExcl, 0)
  const paidExcl = documents.filter((d) => d.paid).reduce((s, d) => s + d.amountExcl, 0)
  const invoices = documents.filter((d) => d.type === "invoice").length
  const credits = documents.length - invoices
  return {
    projectId,
    invoicedExcl,
    paidExcl,
    currency: currencies[0] ?? null,
    documents,
    message:
      documents.length === 0
        ? "No issued invoice is linked to this project."
        : `${invoices} invoice${invoices === 1 ? "" : "s"} and ${credits} credit note${
            credits === 1 ? "" : "s"
          } linked to this project, excluding VAT.`,
  }
}
