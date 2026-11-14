// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Monthly recurring revenue of one subscription, in integer minor units of its
// own currency. Pure: no database, no clock of its own, no float in the money.
//
// THE RULE (`MRR_RULES` holds every constant; the query and the page that says
// "how this is computed" both render from it):
//   - Only `active` and `past_due` subscriptions count.
//   - Only licensed items with a recurring price count: metered, one-off and
//     free items add nothing. A price with no flat unit amount (tiered) adds nothing.
//   - Each item is price times quantity, normalised to one month: a year is
//     divided by 12, a quarter by 3, a week is multiplied by 52/12, a day by 365/12.
//   - A price that includes tax is reduced to its net by the item's rate.
//   - Discounts that recur reduce it: percentages first, then amounts off.
//     A discount that applies once, or has ended, does not count.
//   - ROUNDING: the exact rational of one subscription is rounded half up, once,
//     to a whole minor unit. A currency's total is the sum of those rounded
//     values, so it is an integer and never depends on the order of subscriptions.
//   - Each currency is its own line. Nothing is converted.
type Obj = Record<string, unknown>

export const MRR_RULES = {
  countedStatuses: ["active", "past_due"],
  notCounted: ["trialing", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused"],
  /** One month is 1/12 of a year; a week is 52/12 of a month and a day 365/12. */
  monthsPerYear: 12,
  weeksPerYear: 52,
  daysPerYear: 365,
  rounding: "half_up_per_subscription",
  /** Percentages are kept to hundredths of a percent. */
  percentScale: 10000,
} as const

type Frac = { n: bigint; d: bigint }

const FACTOR: Record<string, Frac> = {
  month: { n: 1n, d: 1n },
  year: { n: 1n, d: BigInt(MRR_RULES.monthsPerYear) },
  week: { n: BigInt(MRR_RULES.weeksPerYear), d: BigInt(MRR_RULES.monthsPerYear) },
  day: { n: BigInt(MRR_RULES.daysPerYear), d: BigInt(MRR_RULES.monthsPerYear) },
}

/** The rules as plain lines, from the constants above. */
export function mrrRuleLines(locale: "en" | "fr" = "en"): string[] {
  const r = MRR_RULES
  const counted = r.countedStatuses.join(", ")
  const not = r.notCounted.join(", ")
  if (locale === "fr") {
    return [
      `Comptés : les abonnements ${counted}.`,
      `Non comptés : ${not}, les prix gratuits, à l'usage ou ponctuels.`,
      `Chaque ligne est le prix fois la quantité ramené à un mois : l'année divisée par ${r.monthsPerYear}, le trimestre par 3, la semaine multipliée par ${r.weeksPerYear}/${r.monthsPerYear}, le jour par ${r.daysPerYear}/${r.monthsPerYear}.`,
      "Un prix TTC est ramené au hors taxes par son taux. Les remises récurrentes sont déduites ; une remise ponctuelle ou terminée ne l'est pas.",
      "Arrondi : une fois par abonnement, à l'unité mineure la plus proche (la moitié vers le haut). Chaque devise a sa propre ligne, sans conversion.",
    ]
  }
  return [
    `Counted: ${counted} subscriptions.`,
    `Not counted: ${not}, free, metered or one-off prices.`,
    `Each item is price times quantity in one month: a year divided by ${r.monthsPerYear}, a quarter by 3, a week times ${r.weeksPerYear}/${r.monthsPerYear}, a day times ${r.daysPerYear}/${r.monthsPerYear}.`,
    "A price that includes tax is reduced to its net by its rate. Recurring discounts come off; a one-time or ended discount does not.",
    "Rounding: once per subscription, to the nearest minor unit, halves up. Each currency is its own line, never converted.",
  ]
}

export interface MrrItem {
  unit_amount?: unknown
  quantity?: unknown
  interval?: unknown
  interval_count?: unknown
  usage_type?: unknown
  tax_behavior?: unknown
  /** The tax rate in percent when the price includes tax. */
  tax_percent?: unknown
}

/** A discount that recurs: a percentage or an amount off per billing period. */
export interface MrrDiscount {
  percent?: number
  amountMinor?: number
}

export interface MrrInput {
  status: unknown
  items: MrrItem[]
  discounts?: MrrDiscount[]
}

const big = (v: unknown): bigint => {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? BigInt(Math.round(n)) : 0n
}

const scaled = (percent: number): bigint =>
  BigInt(
    Math.max(
      0,
      Math.min(MRR_RULES.percentScale, Math.round(percent * (MRR_RULES.percentScale / 100))),
    ),
  )

function factorOf(item: MrrItem): Frac | null {
  const f = FACTOR[String(item.interval ?? "")]
  if (!f) return null
  const count = BigInt(Math.max(1, Math.floor(Number(item.interval_count) || 1)))
  return { n: f.n, d: f.d * count }
}

const add = (a: Frac, b: Frac): Frac => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d })

/** The exact monthly rational of the items, before discounts, and the subscription's cadence. */
function monthly(items: MrrItem[]): { total: Frac; cadence: Frac | null } {
  let total: Frac = { n: 0n, d: 1n }
  let cadence: Frac | null = null
  for (const it of items) {
    const f = factorOf(it)
    if (!f || it.usage_type === "metered") continue
    const unit = big(it.unit_amount)
    const qty = big(it.quantity ?? 1)
    if (unit <= 0n || qty <= 0n) continue
    let gross: Frac = { n: unit * qty, d: 1n }
    const tax = Number(it.tax_percent)
    if (it.tax_behavior === "inclusive" && Number.isFinite(tax) && tax > 0) {
      gross = {
        n: gross.n * BigInt(MRR_RULES.percentScale),
        d: BigInt(MRR_RULES.percentScale) + scaled(tax),
      }
    }
    total = add(total, { n: gross.n * f.n, d: gross.d * f.d })
    cadence ??= f
  }
  return { total, cadence }
}

/** Minor units a month for one subscription, rounded half up once. 0 when it does not count. */
export function computeMrr(input: MrrInput): number {
  if (!(MRR_RULES.countedStatuses as readonly string[]).includes(String(input.status))) return 0
  const { total, cadence } = monthly(input.items)
  if (total.n === 0n || !cadence) return 0
  let { n, d } = total
  const discounts = input.discounts ?? []
  for (const x of discounts) {
    if (typeof x.percent === "number" && x.percent > 0) {
      n *= BigInt(MRR_RULES.percentScale) - scaled(x.percent)
      d *= BigInt(MRR_RULES.percentScale)
    }
  }
  for (const x of discounts) {
    if (typeof x.amountMinor === "number" && x.amountMinor > 0) {
      const off = { n: big(x.amountMinor) * cadence.n, d: cadence.d }
      ;({ n, d } = add({ n, d }, { n: -off.n, d: off.d }))
    }
  }
  if (n <= 0n) return 0
  return Number((2n * n + d) / (2n * d))
}

const asObj = (v: unknown): Obj | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null

/**
 * The recurring discounts of a Stripe subscription object, or null when they
 * are only ids (the object was not expanded), so the caller keeps what it held.
 */
export function discountsOf(obj: Obj, now: Date): MrrDiscount[] | null {
  const raw: unknown[] = Array.isArray(obj.discounts)
    ? obj.discounts
    : obj.discount
      ? [obj.discount]
      : []
  const out: MrrDiscount[] = []
  for (const entry of raw) {
    const d = asObj(entry)
    if (!d) return null
    const coupon = asObj(d.coupon) ?? asObj(asObj(d.source)?.coupon)
    if (!coupon) return null
    const end = typeof d.end === "number" ? d.end * 1000 : null
    if (end !== null && end <= now.getTime()) continue
    if (coupon.duration === "once") continue
    if (typeof coupon.percent_off === "number") out.push({ percent: coupon.percent_off })
    else if (typeof coupon.amount_off === "number") out.push({ amountMinor: coupon.amount_off })
  }
  return out
}

/** The discounts a row kept in its two columns. */
export function discountsOfRow(row: Obj): MrrDiscount[] {
  const out: MrrDiscount[] = []
  const pct = Number(row.discount_percent)
  const amt = Number(row.discount_amount_minor)
  if (Number.isFinite(pct) && pct > 0) out.push({ percent: pct })
  if (Number.isFinite(amt) && amt > 0) out.push({ amountMinor: amt })
  return out
}

/** The two columns a row keeps for its discounts: one combined percentage, one total amount. */
export function discountColumns(discounts: MrrDiscount[]): {
  discount_percent: number | null
  discount_amount_minor: number | null
} {
  let keep = 1
  let any = false
  let amount = 0
  for (const x of discounts) {
    if (typeof x.percent === "number" && x.percent > 0) {
      keep *= 1 - Math.min(100, x.percent) / 100
      any = true
    }
    if (typeof x.amountMinor === "number" && x.amountMinor > 0) amount += x.amountMinor
  }
  return {
    discount_percent: any ? Math.round((1 - keep) * 10000) / 100 : null,
    discount_amount_minor: amount > 0 ? amount : null,
  }
}

/** The tax rate in percent the object states for an item that includes tax, or null. */
export function taxPercentOf(item: Obj, subscription: Obj): number | null {
  const rates = (arr: unknown): number[] =>
    (Array.isArray(arr) ? arr : [])
      .map((r) => Number(asObj(r)?.percentage))
      .filter((p) => Number.isFinite(p) && p > 0)
  const own = rates(item.tax_rates)
  const list = own.length > 0 ? own : rates(subscription.default_tax_rates)
  return list.length > 0 ? list.reduce((s, p) => s + p, 0) : null
}

/** What kind of movement a change of a subscription's counted amount is. */
export function movementKind(
  before: number,
  after: number,
): "new" | "upgrade" | "downgrade" | "cancelled" {
  if (before <= 0) return "new"
  if (after <= 0) return "cancelled"
  return after > before ? "upgrade" : "downgrade"
}
