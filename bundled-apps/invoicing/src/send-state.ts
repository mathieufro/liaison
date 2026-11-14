// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `document_send_state`: whether a payment reminder about an invoice issued by Liaison may still
// go out, read from the document at the moment the reminder would leave. Paid, fully credited or
// voided stops it for good. A document that cannot be read holds the reminder
// (`send_guard_unavailable`): it is never sent blind.
import { refuseTool } from "@liaison/app-sdk"
import { isFullyCredited } from "./mutations/credit-coverage"
import type { MutationsDb } from "./mutations/shared"

type Obj = Record<string, unknown>

export interface DocumentSendStateCtx {
  db: Pick<MutationsDb, "findOne">
}

const unavailable = (why: string) =>
  refuseTool(
    "send_guard_unavailable",
    `${why} The reminder was not sent and waits; it is checked again before it can go.`,
    { retryable: true },
  )

function minor(v: unknown): bigint {
  try {
    return BigInt(String(v ?? "0"))
  } catch {
    return 0n
  }
}

export async function documentSendState(params: Obj | undefined, ctx: DocumentSendStateCtx) {
  const ref = ((params ?? {}).ref ?? {}) as { kind?: unknown; id?: unknown }
  const id = typeof ref.id === "string" ? ref.id : ""
  if (!/^[0-9a-f-]{36}$/i.test(id)) return unavailable(`"${id}" is not an invoicing document id.`)
  const doc = (await ctx.db.findOne("documents", id)) as Obj | null
  if (!doc) return unavailable(`Document ${id} could not be read.`)
  const name = `Invoice ${String(doc.number ?? id)}`
  if (doc.status === "voided" || doc.status === "cancelled")
    return { stop: true, code: "invoice_voided", label: `${name} is voided` }
  if (doc.status === "paid" || doc.payment_status === "paid" || doc.status === "refunded") {
    return { stop: true, code: "invoice_paid", label: `${name} is paid` }
  }
  const log = (Array.isArray(doc.lifecycle_log) ? doc.lifecycle_log : []) as Obj[]
  if (
    await isFullyCredited(ctx.db, {
      id,
      lifecycle_log: log,
      grand_total_minor: minor(doc.grand_total_minor),
    })
  ) {
    return { stop: true, code: "invoice_credited", label: `${name} is credited` }
  }
  return { stop: false }
}
