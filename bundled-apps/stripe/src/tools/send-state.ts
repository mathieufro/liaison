// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `invoice_send_state`: whether a payment reminder about a Stripe invoice may
// still go out, read from Stripe at the moment it would leave (never from the
// mirror, which can be minutes behind). Paid, void or uncollectible stops it
// for good. When Stripe cannot be asked (key refused, connection held, no
// answer) the answer is `send_guard_unavailable`: the reminder waits, it is
// never sent blind.
import { refuseTool } from "@liaison/app-sdk/errors"
import { type StripeHttpCtx, stripeFetch } from "../http"
import { moneyActionHold, type StateDb } from "../states"

type Obj = Record<string, unknown>

export interface SendStateCtx extends StripeHttpCtx {
  db: StateDb
}

const DONE: Record<string, string> = {
  paid: "invoice_paid",
  void: "invoice_void",
  uncollectible: "invoice_uncollectible",
}

const unavailable = (why: string) =>
  refuseTool(
    "send_guard_unavailable",
    `${why} The reminder was not sent and waits; it is checked again before it can go.`,
    { retryable: true },
  )

export async function invoiceSendState(params: Obj | undefined, ctx: SendStateCtx) {
  const ref = ((params ?? {}).ref ?? {}) as { kind?: unknown; id?: unknown }
  const id = typeof ref.id === "string" ? ref.id : ""
  if (!/^in_[A-Za-z0-9_]+$/.test(id)) return unavailable(`"${id}" is not a Stripe invoice id.`)
  const hold = await moneyActionHold(ctx.db)
  if (hold) return unavailable(`Stripe cannot be asked about invoice ${id} (${hold.error.code}).`)
  let live: Obj
  try {
    live = await stripeFetch<Obj>(ctx, `/v1/invoices/${encodeURIComponent(id)}`, {
      timeoutMs: 1500,
    })
  } catch {
    return unavailable(`Stripe did not answer about invoice ${id}.`)
  }
  const status = String(live.status ?? "")
  const code = DONE[status]
  return code
    ? { stop: true, code, label: `Stripe invoice ${String(live.number ?? id)} is ${status}` }
    : { stop: false }
}
