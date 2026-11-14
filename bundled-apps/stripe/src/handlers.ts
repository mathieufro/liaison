// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Handler barrel: every handler the manifest names, by exact export name.
import type { UpstreamProbeResult, WebhookResult } from "@liaison/app-sdk"
import { handleStripeEvent, type IngestCtx } from "./dispatch"
import { type MatchRunCtx, runCustomerMatch } from "./match"
import { runMrrRebuild } from "./mrr-rebuild"
import { holdWhileImporting, readInstall } from "./states"
import { runBackfill } from "./sync/backfill"
import { Budget, DEFAULT_BUDGET_MS, type SyncCtx } from "./sync/common"
import { onDisconnect, type PurgeCtx, purgeMirror, runCatchup, runPrune } from "./sync/maintenance"
import { runProbe } from "./sync/probe"
import { runReconcile } from "./sync/reconcile"
import {
  type StripeVerifyBridge,
  type StripeVerifyParams,
  type StripeVerifyResult,
  verifyStripeDelivery,
} from "./verify"

export { summarizeRefundsCreate, summarizeSubscriptionCancel } from "./summarizers"
export { homeLoad } from "./sync/home"
export { activityRead } from "./tools/activity"
export { connectionCheck, connectionPrecheck, settingsLoad } from "./tools/connection-check"
export { customerContext } from "./tools/context"
export { customersGet, customersSearch } from "./tools/customers"
export { disputesList } from "./tools/disputes"
export { invoicesSearch } from "./tools/invoices"
export { customerLink } from "./tools/link"
export { cardUpdateLink } from "./tools/links"
export { reconcileCandidates, refundsForCharge } from "./tools/money-reads"
export { mrrQuery } from "./tools/mrr-query"
export { paymentsSearch } from "./tools/payments"
export { refundsCreate, refundsCreatePreflight } from "./tools/refunds"
export {
  approvalRouteRead,
  billingStatusForCounterparty,
  invoiceDocumentLink,
  refundDocumentLink,
} from "./tools/routes"
export { invoiceSendState } from "./tools/send-state"
export {
  subscriptionCancel,
  subscriptionCancelEffect,
  subscriptionCancelPreflight,
  subscriptionsSearch,
} from "./tools/subscriptions"

/** The kernel's verifier entry: the org's own secret, checked host-side (verify.ts). */
export async function stripeWebhookVerifier(
  params: StripeVerifyParams,
  bridge: StripeVerifyBridge,
): Promise<StripeVerifyResult> {
  return verifyStripeDelivery(params, bridge)
}

/** One verified event: ledger, re-fetch, mirror, events (dispatch.ts); its events held while importing (states.ts). */
export async function eventsHandler(payload: unknown, ctx: IngestCtx): Promise<WebhookResult> {
  return holdWhileImporting(payload, ctx, (c) => handleStripeEvent(payload, c))
}

/** Newer events upstream and none received for 2 hours: stalled, and the missed events played (sync/probe.ts). */
export async function probeWebhookUpstreamJob(
  _params: unknown,
  ctx: SyncCtx,
): Promise<UpstreamProbeResult> {
  return runProbe(ctx)
}

/** The first import, resumable per resource (sync/backfill.ts). */
export const backfillJob = (_params: unknown, ctx: SyncCtx) => runBackfill(ctx)

/** The nightly reconcile: by list and by id, never a deletion from absence (sync/reconcile.ts). */
export const reconcileJob = (_params: unknown, ctx: SyncCtx) => runReconcile(ctx)

/** Failed deliveries played again (sync/maintenance.ts). */
export const catchupRetryJob = (_params: unknown, ctx: SyncCtx) => runCatchup(ctx)

/** Ledger rows older than 30 days removed (sync/maintenance.ts). */
export const pruneWebhookDeliveriesJob = (_params: unknown, ctx: SyncCtx) => runPrune(ctx)

/** A removal of the mirror cut short, carried on (sync/maintenance.ts). */
export const purgeMirrorJob = (_params: unknown, ctx: PurgeCtx) => purgeMirror(ctx)

/** The connection was removed: every mirror row goes, invoicing documents stay. */
export async function onConnectionDisconnected(
  event: { data?: { appName?: unknown } | null },
  ctx: PurgeCtx,
) {
  await onDisconnect(event, ctx)
}

/** A customer was created or changed in Stripe: match it to a contact and company (match.ts). */
export async function matchCustomerOnUpdate(
  event: { entityId?: unknown } | null,
  ctx: MatchRunCtx,
) {
  await runCustomerMatch(event?.entityId, ctx)
}

/** The movement log rebuilt from the last 30 days of Stripe events, on demand (mrr-rebuild.ts); the nightly reconcile runs it too. */
export async function mrrRebuildJob(_params: unknown, ctx: SyncCtx) {
  const install = await readInstall(ctx.db)
  if (!install) return { appended: 0, complete: false, gapBefore: null }
  const now = () => new Date()
  return runMrrRebuild(ctx, install, { now, budget: new Budget(now, DEFAULT_BUDGET_MS) })
}
