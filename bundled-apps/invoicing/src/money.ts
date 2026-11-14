// SPDX-License-Identifier: FSL-1.1-ALv2
//
// D5 — Currency arithmetic helpers.
//
// Everything works in integer minor units (`bigint`) with banker's rounding
// (round-half-to-even / IEEE 754 default). Quantity is the only fractional
// input — it arrives as a decimal string from `document_lines.quantity`
// (Postgres NUMERIC(15,3)) and gets multiplied into `unit_price_minor` with
// the rounding applied at the boundary.

/**
 * Multiply `a * b / divisor` in bigints with banker's rounding (round half
 * to even).
 */
function divRoundHalfEven(numerator: bigint, divisor: bigint): bigint {
  if (divisor === 0n) {
    throw new Error("divRoundHalfEven: divisor must be non-zero")
  }
  const negative = numerator < 0n !== divisor < 0n
  const n = numerator < 0n ? -numerator : numerator
  const d = divisor < 0n ? -divisor : divisor
  const quotient = n / d
  const remainder = n - quotient * d
  // Compare 2*remainder vs d (avoids floats).
  const doubled = remainder * 2n
  let rounded: bigint
  if (doubled < d) {
    rounded = quotient
  } else if (doubled > d) {
    rounded = quotient + 1n
  } else {
    // Tie — round to even.
    rounded = quotient % 2n === 0n ? quotient : quotient + 1n
  }
  return negative ? -rounded : rounded
}

/**
 * Parse a decimal-string quantity (e.g. "2.500", "-1.005") into
 * `{ scaled: bigint, scale: bigint }` where `scaled / scale` is the exact
 * value. Returns `{ scaled: 0n, scale: 1n }` for "0".
 */
function parseDecimalQuantity(q: string | number): { scaled: bigint; scale: bigint } {
  // The declared shape is a decimal string, but the wire (an agent tool call, an edited approval
  // payload, or a NUMERIC column read back through the sandbox bridge) can deliver a NUMBER. A
  // number has no `.trim()`/`.split()` → QuickJS's contentless "not a function" aborts the whole
  // gated issuance (422). Coerce defensively; an unparseable value still throws the descriptive
  // "invalid quantity" error below.
  const trimmed = String(q).trim()
  const negative = trimmed.startsWith("-")
  const body = negative ? trimmed.slice(1) : trimmed
  const [intPart, fracPart = ""] = body.split(".")
  const digits = (intPart ?? "0") + fracPart
  if (!/^[0-9]+$/.test(digits)) {
    throw new Error(`parseDecimalQuantity: invalid quantity ${q}`)
  }
  const scaled = BigInt(digits)
  const scale = 10n ** BigInt(fracPart.length)
  return { scaled: negative ? -scaled : scaled, scale }
}

export interface LineSubtotalInput {
  /** Decimal string (NUMERIC(15,3) shape — up to 3 fractional digits). Accepts a number too: the
   *  wire / an edited payload / a NUMERIC read-back may deliver one, and parseDecimalQuantity coerces. */
  quantity: string | number
  /** Unit price in integer minor units. */
  unit_price_minor: bigint
}

export function lineSubtotal({ quantity, unit_price_minor }: LineSubtotalInput): bigint {
  const { scaled, scale } = parseDecimalQuantity(quantity)
  return divRoundHalfEven(scaled * unit_price_minor, scale)
}

export interface NetOfTaxInput {
  /** Tax-INCLUSIVE amount in integer minor units. */
  gross_minor: bigint
  /** Basis points: 2000 = 20%, 0 = no tax (returns gross unchanged). */
  tax_rate_bp: number
}

/**
 * Strip an included tax from a gross amount: net = gross / (1 + rate).
 * Used when the upstream source (e.g. a Shopify shop with tax-inclusive
 * pricing) delivers gross prices but the document model stores net unit
 * prices and re-derives tax from the rate.
 */
export function netOfTax({ gross_minor, tax_rate_bp }: NetOfTaxInput): bigint {
  if (tax_rate_bp === 0) return gross_minor
  return divRoundHalfEven(gross_minor * 10000n, 10000n + BigInt(tax_rate_bp))
}

/**
 * Strip an included tax rate (basis points) off a gross minor amount, rounded HALF UP.
 *
 * The tax-inclusive boundary helper: the same arithmetic is applied to a Shopify draft order
 * whose shop prices tax inclusive and to a hand-typed line under an issuer profile with
 * `prices_include_tax` on, so one gross price always yields one net price. `null` or a
 * non-positive rate (reverse charge, export, a zero-rated line) returns the amount untouched.
 */
export function netOfIncludedTax(gross: bigint, rateBp: number | null | undefined): bigint {
  if (rateBp == null || rateBp <= 0) return gross
  const denom = BigInt(10_000 + rateBp)
  return (gross * 10_000n + denom / 2n) / denom
}

/**
 * Reconstruct the gross figure an operator would have typed from a stored net amount and the
 * line's tax rate, rounded HALF UP. Used ONLY at a UI read boundary (the Editor loading a
 * persisted draft/document) to undo the ONE division `netLinesForIssuer` applies at the write
 * boundary — a stored unit price is always net, never gross. `null` or a non-positive rate
 * returns the amount untouched, matching `netOfIncludedTax`.
 *
 * NOT an exact inverse of `netOfIncludedTax`: that function is not injective (several gross
 * values round to the same net value at a given rate — e.g. six grosses collapse to five nets at
 * 20%), so grossing a net value back up can drift by 1 minor unit from the ORIGINAL typed gross
 * for roughly one net value in six. That drift is display-only, is the closest reconstructable
 * gross, and self-corrects: applying `netOfIncludedTax` to it again reproduces the stored net
 * exactly (verified for every probed value), which is the only round trip an unedited save
 * actually performs — net -> gross -> net is exact; gross -> net -> gross is not.
 */
export function grossOfExcludedTax(net: bigint, rateBp: number | null | undefined): bigint {
  if (rateBp == null || rateBp <= 0) return net
  const denom = BigInt(10_000 + rateBp)
  return (net * denom + 5_000n) / 10_000n
}

export interface LineTaxInput {
  subtotal_minor: bigint
  /** Basis points: 2000 = 20%, 1 = 0.01%. */
  tax_rate_bp: number
}

export function lineTax({ subtotal_minor, tax_rate_bp }: LineTaxInput): bigint {
  if (tax_rate_bp === 0) return 0n
  return divRoundHalfEven(subtotal_minor * BigInt(tax_rate_bp), 10000n)
}

export interface LineTotalInput {
  subtotal_minor: bigint
  tax_minor: bigint
}

export function lineTotal({ subtotal_minor, tax_minor }: LineTotalInput): bigint {
  return subtotal_minor + tax_minor
}

export interface LineAmountsInput extends LineSubtotalInput {
  /** The TOTAL discount of the line, subtracted once from quantity x unit price. */
  discount_minor?: bigint
}

/**
 * What one line charges at a rate: the one computation behind the stored line, the document total
 * and every approval card, so what a person approves is what issues.
 */
export function lineAmounts(
  { quantity, unit_price_minor, discount_minor }: LineAmountsInput,
  tax_rate_bp: number,
): { subtotal_minor: bigint; tax_minor: bigint; total_minor: bigint } {
  const subtotal_minor = lineSubtotal({ quantity, unit_price_minor }) - (discount_minor ?? 0n)
  const tax_minor = lineTax({ subtotal_minor, tax_rate_bp })
  return { subtotal_minor, tax_minor, total_minor: lineTotal({ subtotal_minor, tax_minor }) }
}

export interface LineRollupInput {
  subtotal_minor: bigint
  /** Basis points: 2000 = 20%, 0 = tax-exempt. */
  tax_rate_bp: number
}

export interface DocumentRollupResult {
  subtotal_minor: bigint
  tax_total_minor: bigint
  grand_total_minor: bigint
}

/**
 * Roll up per-line subtotals to document-level totals.
 *
 * Tax is re-derived from each line's subtotal and rate rather than summed
 * from pre-rounded per-line tax amounts. Summing rounded intermediates
 * accumulates rounding error; re-deriving from the authoritative subtotal
 * produces the correct total when a single rounding is applied per line.
 */
export function documentRollup(lines: LineRollupInput[]): DocumentRollupResult {
  let subtotal = 0n
  let tax = 0n
  for (const ln of lines) {
    subtotal += ln.subtotal_minor
    tax += lineTax({ subtotal_minor: ln.subtotal_minor, tax_rate_bp: ln.tax_rate_bp })
  }
  return {
    subtotal_minor: subtotal,
    tax_total_minor: tax,
    grand_total_minor: subtotal + tax,
  }
}

// ── Currency exponents (ISO 4217 minor-unit digits) ──────────────────────
//
// Most currencies have 2 minor digits (EUR/USD: 100 minor = 1 major). The
// ISO 4217 zero-decimal currencies have NO fractional unit, so their minor
// unit IS their major unit (JPY 23900 minor = 23900 yen). Dividing those by
// 100 for display renders amounts 100x too small. This is the single source
// of truth the whole app (display, footers, CSV, creation) shares so the
// major<->minor rule is applied identically everywhere.
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "HUF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
])

/** ISO 4217 currencies with 3 minor digits (dinar family). */
export const THREE_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BHD",
  "IQD",
  "JOD",
  "KWD",
  "LYD",
  "OMR",
  "TND",
])

/** ISO 4217 currencies with 4 minor digits (unit-of-account funds). */
export const FOUR_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(["CLF", "UYW"])

/**
 * Minor-unit digit count for a currency (ISO 4217): 0 for zero-decimal currencies, 3 for the
 * dinar family, 4 for CLF/UYW, else 2. HUF stays in the zero-decimal set on purpose: Shopify
 * sends whole-forint decimal strings and existing HUF documents already store whole forints.
 */
export function currencyExponent(currency: string): number {
  const c = currency.toUpperCase()
  if (ZERO_DECIMAL_CURRENCIES.has(c)) return 0
  if (THREE_DECIMAL_CURRENCIES.has(c)) return 3
  if (FOUR_DECIMAL_CURRENCIES.has(c)) return 4
  return 2
}

/**
 * Convert a major-unit decimal string ("12.50", Shopify style) into integer minor units using the
 * currency's ISO 4217 exponent. Digits beyond the exponent are ROUNDED HALF-EVEN (banker's
 * rounding), never truncated. Non-numeric characters are ignored; empty means 0.
 */
export function majorDecimalToMinor(
  amount: string | number | undefined | null,
  currency: string,
): bigint {
  const exp = currencyExponent(currency)
  const raw = String(amount ?? "0").trim()
  const negative = raw.startsWith("-")
  const [intRaw = "0", fracRaw = ""] = raw.replace(/^[-+]/, "").split(".")
  const intPart = intRaw.replace(/[^0-9]/g, "") || "0"
  const fracDigits = fracRaw.replace(/[^0-9]/g, "")
  const kept = fracDigits.slice(0, exp).padEnd(exp, "0")
  const rest = fracDigits.slice(exp)
  let value = BigInt(`${intPart}${kept}`)
  if (rest.length > 0) {
    const half = `5${"0".repeat(rest.length - 1)}`
    const cmp = rest === half ? 0 : rest > half ? 1 : -1
    if (cmp > 0 || (cmp === 0 && value % 2n === 1n)) value += 1n
  }
  return negative ? -value : value
}

/**
 * Render a minor-unit amount for human-facing text (approval summaries,
 * attention rows): 83880 EUR -> "838.80 EUR", 23900 JPY -> "23900 JPY".
 * Twin of templates/shared.ts formatMoney (the PDF sandbox bundle stays
 * import-independent from src/). Raw minor units must never reach user copy;
 * a 699 EUR quote once surfaced as an "83880 EUR" approval. The currency's
 * ISO 4217 exponent decides how many minor digits split off (0 for JPY etc.),
 * so zero-decimal currencies are not divided by 100.
 */
export function formatMoneyMinor(minor: bigint | string | number, currency: string): string {
  const m = typeof minor === "bigint" ? minor : BigInt(minor)
  const negative = m < 0n
  const abs = negative ? -m : m
  const sign = negative ? "-" : ""
  const exp = currencyExponent(currency)
  if (exp === 0) {
    return `${sign}${abs.toString()} ${currency}`
  }
  const scale = 10n ** BigInt(exp)
  const major = abs / scale
  const cents = (abs % scale).toString().padStart(exp, "0")
  return `${sign}${major.toString()}.${cents} ${currency}`
}

/**
 * Parse a hand-typed MAJOR-unit amount (what an operator types into a price
 * field, e.g. "100" meaning 100 EUR) into integer MINOR units for storage.
 *
 * Accepts an optional leading "-", "," or "." as the decimal separator, and
 * thin/regular spaces as group separators (typed or pasted, e.g. "1 000,50").
 * The fractional part may not carry more digits than the currency's exponent
 * (`currencyExponent`) — that would silently lose precision, so it is
 * rejected rather than rounded. Anything else that doesn't parse, including
 * the empty string, returns `null` rather than throwing: the editor uses
 * `null` to mean "leave the stored value alone, the user is mid-keystroke."
 */
export function parseMoneyMajorToMinor(text: string, currency: string): bigint | null {
  const trimmed = text.trim()
  if (trimmed === "") return null
  // Strip group separators: regular space, non-breaking space, thin space.
  const noGroups = trimmed.replace(/[\s\u00A0\u2009]/g, "")
  const match = /^(-?)(\d+)(?:[.,](\d+))?$/.exec(noGroups)
  if (!match) return null
  const [, signPart, intPart, fracPart = ""] = match
  const exp = currencyExponent(currency)
  if (fracPart.length > exp) return null
  const scaledFrac = fracPart.padEnd(exp, "0")
  const digits = intPart + scaledFrac
  const minor = BigInt(digits)
  return signPart === "-" ? -minor : minor
}

/**
 * Inverse of `parseMoneyMajorToMinor` for an `<input>` value: renders a
 * minor-unit amount as the MAJOR-unit text the operator expects to see and
 * edit, with no currency code and no grouping ("10000", "EUR" -> "100.00";
 * "100", "JPY" -> "100"; negative keeps the sign).
 */
export function formatMinorAsMajorInput(minor: bigint | string | number, currency: string): string {
  const m = typeof minor === "bigint" ? minor : BigInt(minor)
  const negative = m < 0n
  const abs = negative ? -m : m
  const sign = negative ? "-" : ""
  const exp = currencyExponent(currency)
  if (exp === 0) {
    return `${sign}${abs.toString()}`
  }
  const scale = 10n ** BigInt(exp)
  const major = abs / scale
  const fraction = (abs % scale).toString().padStart(exp, "0")
  return `${sign}${major.toString()}.${fraction}`
}

/**
 * Minor units (bigint, number or string) as a grouped major-unit string, the one money format of the
 * app: the screens and the approval cards read the same figure. The currency's ISO 4217 exponent
 * decides how many minor digits split off; a zero-decimal currency has no fractional unit.
 */
export function formatMoneyGrouped(
  minor: bigint | number | string | null | undefined,
  currency?: string,
): string {
  if (minor === null || minor === undefined || minor === "") return "-"
  const n = typeof minor === "bigint" ? Number(minor) : Number(minor)
  if (!Number.isFinite(n)) return "-"
  const abs = Math.abs(n)
  const exp = currency ? currencyExponent(currency) : 2
  const sign = n < 0 ? "-" : ""
  if (exp === 0) {
    const grouped = String(Math.round(abs)).replace(/\B(?=(\d{3})+(?!\d))/g, " ")
    return `${sign}${grouped}`
  }
  const scale = 10 ** exp
  const major = Math.floor(abs / scale)
  const cents = abs % scale
  const grouped = String(major).replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  return `${sign}${grouped}.${String(cents).padStart(exp, "0")}`
}
