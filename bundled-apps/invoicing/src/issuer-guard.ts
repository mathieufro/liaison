// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The issuer guard: one customer, one issuer. A customer who pays a live Stripe subscription is
// invoiced from Stripe (by Stripe, or by Liaison from Stripe's own invoices), so a Liaison invoice
// or schedule made by hand for them would bill the same service twice. Every path that makes a
// Liaison invoice for a named customer asks here first, in its preflight AND its handler, so a
// call that skips the preflight is still refused:
//   invoice_issue, invoice_create_and_issue, drafts_create (invoice), drafts_update (buyer change),
//   recurring_schedule_create, recurring_schedule_update, and a month-end row (its state and the
//   issue of the row itself), so a schedule made before Stripe was connected stops at its next run.
// Shopify orders, credit notes and quotes never ask.
//
// The answer comes from the Stripe app's mirror (`stripe:billing_status_for_counterparty`), which
// also matches Stripe customers not yet linked to a contact by the customer's exact email, and
// says "unavailable" until the connection is connected and its customers and subscriptions are
// fully imported. Unavailable refuses: a mirror that is still importing would say "none".
//
// Invoicing's card stream row is not trusted when it is missing: the Stripe app is asked, and its
// answer decides. Stripe not connected, or the app turned off or absent, passes. Connected with no
// row (a lost connection event): the row is made and the customer is checked as usual. Stripe
// cannot be asked: unavailable, and nothing issues for that customer.
//
// A person may say what else the customer is billed for (`billsOtherThanStripe`, at least 5
// characters): then the invoice is not the subscription, and it passes. Only a person says it: an
// approved card, or a person's own click. An agent's statement alone waits for a person.
import type { ErrorEnvelope, MutationsCtx } from "./mutations/shared"
import { ensureCardStreams, type StreamsCtx, stripeConnected } from "./streams"

export const BILLS_OTHER_MIN = 5

export interface GuardCtx {
  db: MutationsCtx["db"]
  executeTool?: MutationsCtx["executeTool"]
  approval?: MutationsCtx["approval"] | null
  turn?: { get(): Promise<unknown> }
}

export interface GuardInput {
  contactId?: string | null
  companyId?: string | null
  emails?: Array<string | null | undefined>
  billsOtherThanStripe?: unknown
  /** `preflight`: the card is about to be staged (a person will read the statement on it). */
  stage: "preflight" | "handler"
}

export type GuardVerdict =
  | { ok: true; calls: number; billsOther: string | null }
  | { ok: false; calls: number; needsPerson?: true; error: ErrorEnvelope; reason: string }

/** The reason a month-end row shows when the guard holds it. */
export const BILLED_BY_STRIPE = "Billed by Stripe"
export const STRIPE_UNREACHABLE = "Stripe could not be checked"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const refusal = (code: string, message: string): ErrorEnvelope => ({
  status: "error",
  error: { code, message },
})

/** The statement, trimmed, when it is long enough to say something; else null. */
export function billsOtherOf(v: unknown): string | null {
  const t = typeof v === "string" ? v.trim() : ""
  return t.length >= BILLS_OTHER_MIN ? t : null
}

async function actingAgent(ctx: GuardCtx): Promise<string | null> {
  try {
    const raw: unknown = ctx.turn ? await ctx.turn.get() : null
    const t = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
      agentId?: string | null
    } | null
    return t?.agentId ?? null
  } catch {
    return "unknown"
  }
}

/** A person said it: an approved card, or a call with no agent acting (a person's own click). */
async function personSaid(ctx: GuardCtx): Promise<boolean> {
  if (ctx.approval) return true
  return (await actingAgent(ctx)) === null
}

/** Card stream rows for every issuer profile, connected. A write that fails (a read-only stage) leaves the verdict unchanged. */
async function healCardStreams(ctx: GuardCtx): Promise<void> {
  try {
    await ensureCardStreams(ctx as unknown as StreamsCtx, true)
  } catch {
    // Made by the next call that may write.
  }
}

interface BillingStatus {
  connected?: boolean
  live?: boolean | null
  unavailable?: boolean
  reason?: string
  subscriptions?: Array<{ id: string; plan?: string }>
}

export async function checkIssuerGuard(ctx: GuardCtx, input: GuardInput): Promise<GuardVerdict> {
  const contactId = input.contactId && UUID.test(input.contactId) ? input.contactId : null
  const companyId = input.companyId && UUID.test(input.companyId) ? input.companyId : null
  const given = (input.emails ?? []).filter(
    (e): e is string => typeof e === "string" && e.includes("@"),
  )
  if (!contactId && !companyId && given.length === 0)
    return { ok: true, calls: 0, billsOther: null }
  // A card stream row says Stripe is connected; a missing row proves nothing (the connection event
  // may have been lost), so Stripe is asked either way and its own answer decides.
  const rowSaysConnected = await stripeConnected(ctx)
  const emails = [
    ...new Set(
      [...given, ...(await contactEmails(ctx, contactId))].map((e) => e.trim().toLowerCase()),
    ),
  ]
  if (!ctx.executeTool) {
    if (!rowSaysConnected) return { ok: true, calls: 0, billsOther: null }
    return {
      ok: false,
      calls: 0,
      reason: STRIPE_UNREACHABLE,
      error: refusal(
        "subscription_check_unavailable",
        "Stripe is connected but could not be asked whether this customer pays a subscription, so nothing was issued or saved. Try again in a few minutes.",
      ),
    }
  }
  let status: BillingStatus | null = null
  let failure = ""
  try {
    const env = await ctx.executeTool("stripe:billing_status_for_counterparty", {
      ...(contactId ? { contactId } : {}),
      ...(companyId ? { companyId } : {}),
      ...(emails.length ? { emails: emails.slice(0, 20) } : {}),
    })
    if (env.status === "completed") status = (env.result ?? null) as BillingStatus | null
    // The Stripe app is absent or turned off: nothing bills from it.
    else if (env.status === "error" && env.error.code === "tool_not_found")
      return { ok: true, calls: 1, billsOther: null }
    else failure = env.status === "error" ? env.error.message : "it asked for an approval"
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err)
  }
  if (status && status.connected === false) return { ok: true, calls: 1, billsOther: null }
  // Stripe is connected but invoicing held no card stream: make it now (undecided until a person
  // picks), so the settings and the issuing paths see it from here on. The answer applies either way.
  if (status && !rowSaysConnected) await healCardStreams(ctx)
  if (!status || status.unavailable === true || typeof status.live !== "boolean") {
    const why = status?.reason || failure || "no answer"
    return {
      ok: false,
      calls: 1,
      reason: STRIPE_UNREACHABLE,
      error: refusal(
        "subscription_check_unavailable",
        `${rowSaysConnected || status ? "Stripe is connected but cannot say yet" : "Liaison could not ask Stripe whether it is connected and"} whether this customer pays a subscription (${why}), so nothing was issued or saved. Try again in a few minutes.`,
      ),
    }
  }
  if (!status.live) return { ok: true, calls: 1, billsOther: null }
  const subs = (status.subscriptions ?? [])
    .map((s) => (s.plan ? `${s.id} (${s.plan})` : s.id))
    .join(", ")
  const other = billsOtherOf(input.billsOtherThanStripe)
  if (other) {
    // On the card a person reads the statement before anything happens; at the handler a person
    // must have made it.
    if (input.stage === "preflight" || (await personSaid(ctx)))
      return { ok: true, calls: 1, billsOther: other }
    return {
      ok: false,
      calls: 1,
      needsPerson: true,
      reason: BILLED_BY_STRIPE,
      error: refusal(
        "subscription_stream_conflict",
        `This customer pays the live Stripe subscription ${subs}; that this bills something else ("${other}") is a person's statement, so it waits for a person.`,
      ),
    }
  }
  return {
    ok: false,
    calls: 1,
    reason: BILLED_BY_STRIPE,
    error: refusal(
      "subscription_stream_conflict",
      `This customer pays the live Stripe subscription ${subs}, which already invoices them, so nothing was issued or saved. Open their subscription in Stripe, pick another customer, or, if this bills something else, ask the person what it bills and pass it as billsOtherThanStripe.`,
    ),
  }
}

/** The contact's emails as the kernel knows them, from its identifiers only (the guard also matches unlinked Stripe customers by email): a read that does not mark the turn as having read outside text. */
export async function contactEmails(
  ctx: GuardCtx,
  contactId: string | null | undefined,
): Promise<string[]> {
  if (!contactId || !UUID.test(contactId) || !ctx.executeTool) return []
  try {
    const env = await ctx.executeTool("kernel:contacts_identity", { contactId })
    if (env.status !== "completed") return []
    const e = (env.result as { contact?: { email?: unknown } } | null)?.contact?.email
    return typeof e === "string" && e.includes("@") ? [e] : []
  } catch {
    return []
  }
}
