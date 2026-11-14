// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reporting a collection to the e-invoicing platform. Where VAT falls due on receipt (services,
// with no debits option), the payment received is a fact the platform needs: the amounts by VAT
// rate, once per payment, and on a refund the true (negative) figure. An issuer on the debits
// option, a reverse-charge sale and a sale out of French VAT send nothing ("Not needed"). A
// platform that does not take the optional `report_collection` op leaves the collection to enter
// by hand: state `collection_manual`, one Home line. No dispatch grant: it reports a fact, it
// issues nothing.
import { CONTRACT, type EinvCtx, sha256Text } from "./transmit"

type Row = Record<string, unknown>

export type CollectionState = "reported" | "not_needed" | "collection_manual" | "failed"

export const COLLECTION_MANUAL_LABEL = "To report at your platform"

/** What a document's collection shows, from its stored state. */
export function collectionLabel(doc: Row): string | null {
  switch (doc.collection_state) {
    case "reported":
      return "Collected"
    case "not_needed":
      return "Not needed"
    case "collection_manual":
      return COLLECTION_MANUAL_LABEL
    case "failed":
      return "Collection not reported"
    default:
      return null
  }
}

/** French VAT due on receipt: a domestic sale, not on the debits option, not reverse charge. */
function dueOnReceipt(doc: Row): boolean {
  if (doc.vat_on_debits === true) return false
  if (doc.tax_treatment !== "eu_domestic") return false
  if (doc.internal_cancellation === true) return false
  return doc.operation_category !== "goods"
}

function toBig(v: unknown): bigint {
  try {
    return BigInt(String(v ?? "0").split(".")[0] || "0")
  } catch {
    return 0n
  }
}

/** The share `part / whole` of `x`, rounded half away from zero. */
function share(x: bigint, part: bigint, whole: bigint): bigint {
  if (whole === 0n) return 0n
  const num = x * part * 2n
  const q = num / whole
  return q >= 0n ? (q + 1n) / 2n : (q - 1n) / 2n
}

async function providerRef(ctx: EinvCtx, documentId: string): Promise<string | null> {
  const rows = (await ctx.db.findMany("einvoice_transmissions", {
    where: { document_id: documentId },
    limit: 50,
  })) as Row[]
  const withRef = rows.filter((r) => typeof r.provider_ref === "string" && r.provider_ref !== "")
  const send = withRef.find((r) => r.action === "send_einvoice") ?? withRef[0]
  return send ? String(send.provider_ref) : null
}

/**
 * Report one payment (`paid`) or refund (`refund`) of a document. Idempotent per `ref`: the same
 * payment reported twice sends once.
 */
export async function reportCollection(
  ctx: EinvCtx,
  documentId: string,
  event: { kind: "paid" | "refund"; amount_minor: bigint; date: string; ref: string },
): Promise<{ state: CollectionState | "skipped"; message: string }> {
  const doc = (
    (await ctx.db.findMany("documents", { where: { id: documentId }, limit: 1 })) as Row[]
  )[0]
  if (!doc)
    return {
      state: "skipped",
      message: `Document ${documentId} not found; no collection was reported.`,
    }
  const number = String(doc.number ?? documentId)
  if (!dueOnReceipt(doc)) {
    await ctx.db.update("documents", documentId, { collection_state: "not_needed" })
    return {
      state: "not_needed",
      message: `${number}: VAT is not due on receipt, so no collection is reported (Not needed).`,
    }
  }
  const key = sha256Text(
    `${documentId}|collection|${event.kind}|${event.ref}|${event.amount_minor}`,
  )
  const done = (Array.isArray(doc.collection_reports) ? doc.collection_reports : []) as string[]
  if (done.includes(key))
    return {
      state: (doc.collection_state as CollectionState) ?? "reported",
      message: `${number}: this payment was already reported; nothing was sent again.`,
    }
  const ref = await providerRef(ctx, documentId)
  if (!ref || !ctx.contracts)
    return {
      state: "skipped",
      message: `${number} is not at the e-invoicing platform; no collection was reported.`,
    }
  const lines = (await ctx.db.findMany("document_lines", {
    where: { document_id: documentId },
    limit: 500,
  })) as Row[]
  const byRate = new Map<number, { net: bigint; vat: bigint }>()
  for (const l of lines) {
    const rate = Number(l.tax_rate_bp ?? 0)
    const cur = byRate.get(rate) ?? { net: 0n, vat: 0n }
    cur.net += toBig(l.subtotal_minor)
    cur.vat += toBig(l.tax_minor)
    byRate.set(rate, cur)
  }
  const total = toBig(doc.grand_total_minor)
  const sign = event.kind === "refund" ? -1n : 1n
  const amounts = [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, v]) => ({
      rate_bp: rate,
      net_minor: (sign * share(v.net, event.amount_minor, total)).toString(),
      vat_minor: (sign * share(v.vat, event.amount_minor, total)).toString(),
    }))
  const env = await ctx.contracts.call(
    CONTRACT,
    "report_collection",
    { provider_ref: ref, date: event.date, amounts_by_vat_rate: amounts, idempotency_key: key },
    { provider: (doc.pa_provider as string | null) ?? null },
  )
  if (env.status === "completed") {
    await ctx.db.update("documents", documentId, {
      collection_state: "reported",
      collection_reports: [...done, key],
    })
    return {
      state: "reported",
      message: `${number}: the collection of ${event.date} was reported to the e-invoicing platform.`,
    }
  }
  const code = env.status === "error" ? env.error.code : "not_reported"
  if (code === "contract_op_unsupported") {
    const first = doc.collection_state !== "collection_manual"
    await ctx.db.update("documents", documentId, {
      collection_state: "collection_manual",
      collection_reports: [...done, key],
    })
    if (first && ctx.emit) {
      await ctx.emit({
        entity: "einvoicing",
        action: "collection_manual",
        entityId: documentId,
        data: { document_id: documentId, number, date: event.date, resolved: false },
      })
    }
    return {
      state: "collection_manual",
      message: `${number}: the e-invoicing platform does not take collections from Liaison. ${COLLECTION_MANUAL_LABEL}.`,
    }
  }
  await ctx.db.update("documents", documentId, { collection_state: "failed" })
  return {
    state: "failed",
    message: `${number}: the collection was not reported (${code}). It is tried again on the next payment event.`,
  }
}
