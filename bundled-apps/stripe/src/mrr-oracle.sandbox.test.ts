// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The MRR rules against a real Stripe sandbox. Each run creates its own test clock with its own
// customers and subscriptions, reads them back as the mirror would (the app's own row mapping,
// then `mrr_query`), compares the figure with the amounts written below, and deletes what it made.
//
// Skipped unless the sandbox keys are in the environment:
//   LIAISON_STRIPE_TEST_SECRET_KEY      sk_test_..., creates and deletes the fixtures
//   LIAISON_STRIPE_TEST_RESTRICTED_KEY  rk_test_..., reads them back as the connector does
// Set LIAISON_STRIPE_ORACLE_REQUIRED=1 for a run that must not skip: with no key it fails, and a
// run that executed no oracle test always fails. The run prints how many oracle tests ran, and
// never a key.
import { afterAll, describe, expect, it } from "bun:test"
import { STRIPE_API_VERSION } from "./http"
import { newTally, subscriptionRow } from "./mirror"
import { civil, MemDb } from "./mrr-fixtures.testkit"
import { mrrQuery } from "./tools/mrr-query"

const SECRET = process.env.LIAISON_STRIPE_TEST_SECRET_KEY ?? ""
const RESTRICTED = process.env.LIAISON_STRIPE_TEST_RESTRICTED_KEY ?? ""
const REQUIRED = process.env.LIAISON_STRIPE_ORACLE_REQUIRED === "1"
const HAVE_KEYS = SECRET.startsWith("sk_test_") && RESTRICTED.startsWith("rk_test_")

type Obj = Record<string, unknown>

/** The sandbox fixtures: name, what the subscription is, and the minor units it must add to MRR. */
const PLAN = {
  monthly: { unit: 4900, interval: "month", count: 1, qty: 1, expected: 4900 },
  yearly: { unit: 60000, interval: "year", count: 1, qty: 1, expected: 5000 },
  quarterly: { unit: 29700, interval: "month", count: 3, qty: 1, expected: 9900 },
  seats: { unit: 1000, interval: "month", count: 1, qty: 3, expected: 2400, percentOff: 20 },
  trial: { unit: 4900, interval: "month", count: 1, qty: 1, expected: 0, trialDays: 14 },
  cancelled: { unit: 4900, interval: "month", count: 1, qty: 1, expected: 0, cancel: true },
} as const
const EXPECTED_TOTAL = 4900 + 5000 + 9900 + 2400

let ran = 0
const made: { clock?: string; product?: string; coupon?: string } = {}

function form(data: Obj, prefix = ""): string[] {
  return Object.entries(data).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}[${k}]` : k
    if (v === undefined || v === null) return []
    if (typeof v === "object") return form(v as Obj, key)
    return [`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`]
  })
}

async function stripe(key: string, method: string, path: string, data: Obj = {}): Promise<Obj> {
  const body = form(data).join("&")
  const get = method === "GET"
  const res = await fetch(`https://api.stripe.com${path}${get && body ? `?${body}` : ""}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Stripe-Version": STRIPE_API_VERSION,
      ...(get ? {} : { "Content-Type": "application/x-www-form-urlencoded" }),
    },
    body: get ? undefined : body,
  })
  const json = (await res.json()) as Obj
  if (!res.ok) {
    // The message names the object, never the key.
    throw new Error(
      `Stripe ${method} ${path} answered ${res.status}: ${String((json.error as Obj | undefined)?.message ?? "no message")}`,
    )
  }
  return json
}

async function build(run: string): Promise<{ subs: Obj[]; cancelledId: string }> {
  const frozen = Math.floor(Date.now() / 1000)
  const clock = await stripe(SECRET, "POST", "/v1/test_helpers/test_clocks", {
    frozen_time: frozen,
    name: `mrr-oracle-${run}`,
  })
  made.clock = String(clock.id)
  const product = await stripe(SECRET, "POST", "/v1/products", { name: `mrr-oracle-${run}` })
  made.product = String(product.id)
  const coupon = await stripe(SECRET, "POST", "/v1/coupons", {
    percent_off: 20,
    duration: "forever",
    name: `mrr-oracle-${run}`,
  })
  made.coupon = String(coupon.id)

  const subs: Obj[] = []
  let cancelledId = ""
  for (const [name, plan] of Object.entries(PLAN) as Array<
    [
      string,
      (typeof PLAN)[keyof typeof PLAN] & {
        percentOff?: number
        trialDays?: number
        cancel?: boolean
      },
    ]
  >) {
    const customer = await stripe(SECRET, "POST", "/v1/customers", {
      name: `oracle ${name} ${run}`,
      test_clock: clock.id,
    })
    const pm = await stripe(SECRET, "POST", "/v1/payment_methods/pm_card_visa/attach", {
      customer: customer.id,
    })
    await stripe(SECRET, "POST", `/v1/customers/${customer.id}`, {
      invoice_settings: { default_payment_method: pm.id },
    })
    const sub = await stripe(SECRET, "POST", "/v1/subscriptions", {
      customer: customer.id,
      items: {
        "0": {
          quantity: plan.qty,
          price_data: {
            currency: "eur",
            product: product.id,
            unit_amount: plan.unit,
            recurring: { interval: plan.interval, interval_count: plan.count },
          },
        },
      },
      ...(plan.percentOff ? { discounts: { "0": { coupon: coupon.id } } } : {}),
      ...(plan.trialDays ? { trial_period_days: plan.trialDays } : {}),
    })
    if (plan.cancel) {
      await stripe(SECRET, "DELETE", `/v1/subscriptions/${sub.id}`)
      cancelledId = String(sub.id)
    }
    subs.push({ plan: name, id: sub.id })
  }
  return { subs, cancelledId }
}

async function cleanUp(): Promise<void> {
  // Deleting the clock deletes its customers and their subscriptions.
  if (made.clock)
    await stripe(SECRET, "DELETE", `/v1/test_helpers/test_clocks/${made.clock}`).catch(
      () => undefined,
    )
  if (made.coupon)
    await stripe(SECRET, "DELETE", `/v1/coupons/${made.coupon}`).catch(() => undefined)
  if (made.product)
    await stripe(SECRET, "POST", `/v1/products/${made.product}`, { active: false }).catch(
      () => undefined,
    )
}

describe.skipIf(!HAVE_KEYS)("the MRR rules against the Stripe sandbox", () => {
  afterAll(async () => {
    await cleanUp()
    // A run that executed nothing must not read as green.
    console.log(`mrr oracle: ${ran} test${ran === 1 ? "" : "s"} ran`)
    expect(ran).toBeGreaterThan(0)
  })

  it("test-clock subscriptions add up to the amounts written in this file", async () => {
    ran++
    const run = Date.now().toString(36)
    const { subs } = await build(run)

    const db = new MemDb()
    const perPlan: Record<string, number> = {}
    for (const s of subs) {
      const obj = await stripe(RESTRICTED, "GET", `/v1/subscriptions/${s.id}`, {
        expand: { "0": "discounts" },
      })
      const row = subscriptionRow(obj, newTally(), new Date())
      perPlan[String(s.plan)] =
        row.status === "active" || row.status === "past_due" ? Number(row.mrr_minor) : 0
      db.rows("stripe_subscriptions").push({ id: `row_${s.plan}`, ...row })
    }

    expect(perPlan.monthly).toBe(PLAN.monthly.expected)
    expect(perPlan.yearly).toBe(PLAN.yearly.expected)
    expect(perPlan.quarterly).toBe(PLAN.quarterly.expected)
    expect(perPlan.seats).toBe(PLAN.seats.expected)
    expect(perPlan.trial).toBe(PLAN.trial.expected)
    expect(perPlan.cancelled).toBe(PLAN.cancelled.expected)

    const out = (await mrrQuery({ currency: "eur" }, { db, time: { civil } })) as {
      lines: Array<{ currency: string; mrrMinor: number; activeCount: number }>
    }
    expect(out.lines).toHaveLength(1)
    expect(out.lines[0]).toMatchObject({
      currency: "eur",
      mrrMinor: EXPECTED_TOTAL,
      activeCount: 4,
    })
  }, 120_000)
})

describe("the sandbox oracle's gate", () => {
  it("a run that must not skip fails when the sandbox keys are missing, and says how many tests ran", () => {
    if (!REQUIRED) return
    if (!HAVE_KEYS)
      throw new Error(
        `0 oracle tests ran: LIAISON_STRIPE_TEST_SECRET_KEY and LIAISON_STRIPE_TEST_RESTRICTED_KEY must be set (${ran} ran).`,
      )
  })
})
