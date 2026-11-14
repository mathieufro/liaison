// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The facts a month-end row shows beside its amounts: whether this period bills what the last one
// billed, whether the last invoice is still unpaid, whether this is the first. Each flag is read
// from stored data with plain comparisons, never from a model.

export interface PreviousInvoice {
  /** The previous period's key, `2026-10`, `2026-Q3` or `2026`. */
  period_key: string | null
  /** What the previous invoice billed, before tax, in minor units. */
  net_minor: bigint
  /** The billed lines' description, quantity, price and rate, in order. */
  lines_signature: string
  payment_status: string | null
  /** The previous invoice's currency, for the amount it names. */
  currency?: string | null
}

export interface CurrentDraft {
  net_minor: bigint
  lines_signature: string
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

/** How a row names a period: `October`, `Q3 2026`, `2026`. */
export function periodName(periodKey: string | null): string {
  if (!periodKey) return "the last period"
  const month = /^(\d{4})-(\d{2})$/.exec(periodKey)
  if (month) return MONTHS[Number(month[2]) - 1] ?? periodKey
  const quarter = /^(\d{4})-Q([1-4])$/.exec(periodKey)
  if (quarter) return `Q${quarter[2]} ${quarter[1]}`
  return periodKey
}

/** How a line's `{period}` reads: `November 2026`, `Q4 2026`, `2026`. */
export function periodLabel(periodKey: string): string {
  const month = /^(\d{4})-(\d{2})$/.exec(periodKey)
  if (month) return `${MONTHS[Number(month[2]) - 1]} ${month[1]}`
  const quarter = /^(\d{4})-Q([1-4])$/.exec(periodKey)
  if (quarter) return `Q${quarter[2]} ${quarter[1]}`
  return periodKey
}

/** One canonical string per line set, so two periods compare by value. */
export function linesSignature(
  lines: Array<{
    description?: unknown
    quantity?: unknown
    unit_price_minor?: unknown
    tax_rate_bp?: unknown
  }>,
): string {
  return JSON.stringify(
    lines.map((l) => [
      String(l.description ?? ""),
      String(l.quantity ?? ""),
      String(l.unit_price_minor ?? ""),
      l.tax_rate_bp ?? null,
    ]),
  )
}

/** How a row's amount check starts, so a reader (the panel, the run result) can find it. */
export const AMOUNT_CHECK = "Check the amount: "

/**
 * How far a row's amount may move from the last issued invoice of its schedule before the row asks
 * for a look: five times as much, or a fifth or less. A price rise or a discount stays well inside;
 * a slipped decimal (x10, x100) or a dropped digit is outside.
 */
export const AMOUNT_FAR_RATIO = 5n

function plainMinor(v: bigint, currency: string): string {
  const neg = v < 0n
  const a = neg ? -v : v
  return `${neg ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")} ${currency}`
}

/**
 * The row's amount check: "Check the amount: October was 149.00 EUR excl." when this period bills
 * far more or far less than the last issued invoice, else null. Nothing to compare (no previous
 * invoice, a previous one of zero, a row of zero or less, which needs its own fix) is never flagged.
 */
export function amountFarFlag(
  previous: PreviousInvoice | null,
  current: Pick<CurrentDraft, "net_minor">,
): string | null {
  if (!previous || previous.net_minor <= 0n || current.net_minor <= 0n) return null
  const far =
    current.net_minor >= previous.net_minor * AMOUNT_FAR_RATIO ||
    current.net_minor * AMOUNT_FAR_RATIO <= previous.net_minor
  if (!far) return null
  return `${AMOUNT_CHECK}${periodName(previous.period_key)} was ${plainMinor(previous.net_minor, previous.currency ?? "EUR")} excl.`
}

/** Whether a row's note entry compares it with the last invoice, so an edit can work it out again. */
export function isComparisonFlag(flag: string): boolean {
  return (
    flag === "First invoice" ||
    flag.startsWith("Same as ") ||
    flag.startsWith("Changed since ") ||
    flag.endsWith(" is still unpaid") ||
    flag.startsWith(AMOUNT_CHECK)
  )
}

/** The flags of one row, in the order a person reads them. */
export function runItemFlags(previous: PreviousInvoice | null, current: CurrentDraft): string[] {
  if (!previous) return ["First invoice"]
  const name = periodName(previous.period_key)
  const flags: string[] = []
  const same =
    previous.lines_signature === current.lines_signature && previous.net_minor === current.net_minor
  flags.push(same ? `Same as ${name}` : `Changed since ${name}`)
  const far = amountFarFlag(previous, current)
  if (far) flags.push(far)
  if (previous.payment_status !== "paid") flags.push(`${name} is still unpaid`)
  return flags
}
