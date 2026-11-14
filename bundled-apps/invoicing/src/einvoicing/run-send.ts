// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sends of a month-end run a person approved. The run's card is the person's decision for
// its invoices, sends included: its approved re-entry (`recurring_run_issue`, gated, never
// auto-approved) mints one dispatch grant per approved row, bound to that row (`run_item_ref`,
// the row's id, which every send call of that row carries). The invoice does not exist yet when
// the card is approved (it is issued on the issue day, as a new document), so the row, not the
// document, is what the grant names. On the issue day the row's invoice is issued with no card
// of its own, and its send is prepared under the row's grant. The send refuses
// `run_item_mismatch` when the row no longer names that invoice.
import {
  attemptOf,
  type EinvCtx,
  idempotencyKey,
  latestSendRow,
  mintDispatchGrant,
  readEinvoicingSettings,
  sendFacts,
  TERMINAL_SEND_FAILURES,
} from "./transmit"

type Row = Record<string, unknown>

/** Mint one send grant per approved row; returns how many were minted (0 outside a person's approval). */
export async function mintRunSendGrants(ctx: EinvCtx, itemIds: string[]): Promise<number> {
  const settings = await readEinvoicingSettings(ctx.db)
  if (!settings.provider_app || !settings.send_enabled || !ctx.contracts?.grant) return 0
  let minted = 0
  for (const id of itemIds) {
    const granted = await mintDispatchGrant(ctx, ["submit_einvoice", "advance_einvoice"], {
      run_item_ref: id,
    })
    if (!("ok" in granted)) return minted
    await ctx.db.update("recurring_run_items", id, { send_grant: granted.grant })
    minted += 1
  }
  return minted
}

/**
 * After a row's invoice is issued: prepare its send under the row's grant. `prepared: false` when
 * the row holds no grant or the invoice is not an e-invoice to send (the usual paths then apply).
 */
export async function prepareItemSend(
  ctx: EinvCtx,
  itemId: string,
): Promise<{ prepared: boolean; reason?: string }> {
  const item = (
    (await ctx.db.findMany("recurring_run_items", { where: { id: itemId }, limit: 1 })) as Row[]
  )[0]
  const grant =
    typeof item?.send_grant === "string" && item.send_grant !== "" ? item.send_grant : null
  if (!item || !grant) return { prepared: false, reason: "no_grant" }
  const documentId = String(item.document_id)
  const r = await sendFacts(ctx.db, documentId)
  if (!("ok" in r)) return { prepared: false, reason: r.error.code }
  const settings = await readEinvoicingSettings(ctx.db)
  if (!settings.provider_app || !settings.send_enabled)
    return { prepared: false, reason: "sending_off" }
  const latest = await latestSendRow(ctx.db, documentId)
  if (latest && !TERMINAL_SEND_FAILURES.has(String(latest.state)))
    return { prepared: false, reason: "already_sent" }
  const attempt = latest ? attemptOf(latest) + 1 : 1
  const run = (
    (await ctx.db.findMany("recurring_runs", {
      where: { id: String(item.run_id) },
      limit: 1,
    })) as Row[]
  )[0]
  await ctx.db.insert("einvoice_transmissions", {
    document_id: documentId,
    action: "send_einvoice",
    idempotency_key: idempotencyKey(
      documentId,
      "send_einvoice",
      r.facts.binding.legal_original_sha256,
      attempt,
    ),
    attempt,
    provider_app: settings.provider_app,
    state: "prepared",
    approval_request_id: run?.approval_request_id ?? null,
    approved_by: run?.approved_by ?? null,
    approval_method: "approval",
    approval_snapshot: { ...r.facts.binding },
    dispatch_grant: grant,
    run_item_ref: itemId,
    attempts: 0,
    lifecycle_log: [],
  })
  await ctx.db.update("documents", documentId, {
    einvoice_state: "prepared",
    pa_provider: settings.provider_app,
  })
  return { prepared: true }
}
