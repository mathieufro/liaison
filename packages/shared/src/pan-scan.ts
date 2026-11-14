// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Card numbers and payment processor keys, masked before text is stored.
//
// One function for every place text enters the product (mail and ticket
// messages, staff notes, thread messages, the sealed mailbox's agent context),
// so a rule fixed here is fixed everywhere and no second copy drifts.
//
// A CARD NUMBER is written in one run or in groups split by a space or a dash,
// passes the Luhn check, AND matches a row of the network table below: one of
// the network's issuer prefixes with one of that network's lengths. All three:
// a 16 digit order number that fails Luhn stays, a serial that passes Luhn by
// chance but starts like no card stays, and so does a number of the wrong
// length for its prefix (a 14 digit SIRET starting with 4 is no Visa, a 15
// digit IMEI starting with 35 is no JCB). It becomes bullets plus its last four
// digits. A security code (CVC, CVV, cryptogramme, security code) written within
// 40 characters of a masked number becomes bullets too.
//
// A KEY is a restricted or secret key (`rk_` or `sk_`, then `live_` or
// `test_`) or a webhook signing secret (`whsec_`), followed by 10 or more key
// characters. It keeps its prefix and loses the rest.
//
// What is NOT a card, on purpose: an IBAN (its digits are skipped as a whole),
// a run glued to letters (a tracking number, a reference like `ORD123...`), a
// run longer than 19 digits with no separator (an id, not a card), a number
// written in the SIRET grouping (3, 3, 3 then 5 digits), and a number right
// after an identifier label (SIRET, SIREN, VAT, IBAN, IMEI, serial, order,
// invoice, tracking, reference, EAN), which names what the number is.

const BULLETS = "•••• •••• ••••"
const CODE_BULLETS = "•••"
const KEY_BULLETS = "••••••••"

/** The Luhn check over a string of digits. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

function inRange(digits: string, len: number, lo: number, hi: number): boolean {
  const n = Number(digits.slice(0, len))
  return n >= lo && n <= hi
}

interface Network {
  name: string
  /** Whether `digits` starts with one of the network's issuer prefixes. */
  prefix: (digits: string) => boolean
  /** The lengths the network issues. */
  lengths: readonly number[]
}

const LONG = [16, 17, 18, 19] as const

/** The networks a card number is checked against: prefix ranges and lengths. */
export const CARD_NETWORKS: readonly Network[] = [
  { name: "Visa", prefix: (d) => d.startsWith("4"), lengths: [16, 19] },
  {
    name: "Mastercard",
    prefix: (d) => inRange(d, 2, 51, 55) || inRange(d, 4, 2221, 2720),
    lengths: [16],
  },
  {
    name: "American Express",
    prefix: (d) => d.startsWith("34") || d.startsWith("37"),
    lengths: [15],
  },
  {
    name: "Discover",
    prefix: (d) =>
      d.startsWith("6011") ||
      d.startsWith("65") ||
      inRange(d, 3, 644, 649) ||
      inRange(d, 6, 622126, 622925),
    lengths: LONG,
  },
  { name: "UnionPay", prefix: (d) => d.startsWith("62"), lengths: LONG },
  { name: "JCB", prefix: (d) => inRange(d, 4, 3528, 3589), lengths: LONG },
  {
    name: "Diners Club",
    prefix: (d) =>
      inRange(d, 3, 300, 305) ||
      d.startsWith("3095") ||
      d.startsWith("36") ||
      inRange(d, 2, 38, 39),
    lengths: [14, ...LONG],
  },
]

/** The network whose prefix and length `digits` matches, or null. */
export function cardNetwork(digits: string): string | null {
  for (const n of CARD_NETWORKS)
    if (n.prefix(digits) && n.lengths.includes(digits.length)) return n.name
  return null
}

/** Whether `digits` (separators removed) is a card number. */
export function isCardNumber(digits: string): boolean {
  return /^\d+$/.test(digits) && cardNetwork(digits) !== null && luhnValid(digits)
}

export interface MaskResult {
  text: string
  /** How many values were replaced. */
  masked: number
}

// A digit group, then more groups each after one or two separators.
const TEXT_SEPARATOR = "[ \\u00a0\\t-]{1,2}"
// In HTML a number can also be split by tags or `&nbsp;`.
const HTML_SEPARATOR = "(?:[ \\u00a0\\t-]|&nbsp;|<[^<>]{0,200}>){1,6}"
// An IBAN: two letters, two check digits, then groups of letters and digits.
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g

interface Span {
  start: number
  end: number
}

function ibanSpans(text: string): Span[] {
  const spans: Span[] = []
  for (const m of text.matchAll(IBAN)) {
    spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length })
  }
  return spans
}

function overlaps(spans: Span[], start: number, end: number): boolean {
  return spans.some((s) => start < s.end && end > s.start)
}

// A label that names the number after it as something other than a card,
// followed only by filler (`n°`, `:`, `#`, `de`, `intracom`, markup in HTML)
// up to the number.
const ID_LABEL =
  "(?:siret|siren|n°\\s*tva|tva|vat|iban|imei(?:sv)?|serial|s/n|sn|n° de série|num[ée]ro de s[ée]rie|order|commande|invoice|facture|avoir|credit note|tracking|suivi|colis|parcel|r[ée]f[ée]rence|reference|ref|ean|gtin|isbn|eori)"
const ID_FILLER =
  "(?:[\\s\\u00a0:#°.\\-]|n°|no|nr|num[ée]ro|number|de|du|d'|intra-?com(?:munautaire)?)*"
const LABEL_BEFORE_TEXT = new RegExp(`(?:^|[^\\p{L}\\d])${ID_LABEL}${ID_FILLER}$`, "iu")
const LABEL_BEFORE_HTML = new RegExp(
  `(?:^|[^\\p{L}\\d])${ID_LABEL}(?:${ID_FILLER.slice(3, -2)}|&nbsp;|<[^<>]{0,200}>)*$`,
  "iu",
)

/** Whether an identifier label sits right before `start`. */
function labelledBefore(text: string, start: number, html: boolean): boolean {
  const before = text.slice(Math.max(0, start - (html ? 400 : 60)), start)
  return (html ? LABEL_BEFORE_HTML : LABEL_BEFORE_TEXT).test(before)
}

/** Whether digit groups follow the SIRET grouping: 3, 3, 3, then 5 digits. */
function siretGrouping(lengths: number[]): boolean {
  return lengths.length === 4 && lengths.join(",") === "3,3,3,5"
}

/**
 * The card numbers in `text`, as spans. A run of digit groups is tried group by
 * group: from each starting group, the longest stretch of whole groups that is
 * a card number wins, so a card written after an order number in the same run
 * of digits is still found. A run right after an identifier label is that
 * identifier from its first group on, never a card.
 */
function cardSpans(text: string, separator: string, html: boolean): Span[] {
  const run = new RegExp(`(?<![A-Za-z0-9])\\d+(?:${separator}\\d+)*(?![A-Za-z0-9])`, "g")
  const ibans = ibanSpans(text)
  const out: Span[] = []
  for (const m of text.matchAll(run)) {
    const base = m.index ?? 0
    const labelled = labelledBefore(text, base, html)
    const groups: Array<{ start: number; end: number; digits: string }> = []
    for (const g of m[0].matchAll(/\d+/g)) {
      const start = base + (g.index ?? 0)
      groups.push({ start, end: start + g[0].length, digits: g[0] })
    }
    let i = 0
    while (i < groups.length) {
      let found = -1
      let digits = ""
      const lengths: number[] = []
      for (let j = i; j < groups.length; j++) {
        const g = groups[j] as { digits: string }
        digits += g.digits
        lengths.push(g.digits.length)
        if (digits.length > 19) break
        if (isCardNumber(digits) && !siretGrouping(lengths)) found = j
      }
      if (found >= 0 && !(labelled && i === 0)) {
        const start = (groups[i] as Span).start
        const end = (groups[found] as Span).end
        if (!overlaps(ibans, start, end)) out.push({ start, end })
        i = found + 1
      } else {
        i = found >= 0 ? found + 1 : i + 1
      }
    }
  }
  return out
}

const CODE_LABEL =
  /\b(?:cvc2?|cvv2?|cvn|cryptogramme(?: visuel)?|security code|code de s[ée]curit[ée])\b[^\d\n]{0,15}?(\d{3,4})(?!\d)/gi

function replaceSpans(text: string, spans: Array<Span & { with: string }>): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  let out = ""
  let at = 0
  for (const s of sorted) {
    if (s.start < at) continue
    out += text.slice(at, s.start) + s.with
    at = s.end
  }
  return out + text.slice(at)
}

function maskCards(text: string, separator: string, html: boolean): MaskResult {
  if (!/\d/.test(text)) return { text, masked: 0 }
  const cards = cardSpans(text, separator, html)
  if (cards.length === 0) return { text, masked: 0 }
  const edits: Array<Span & { with: string }> = cards.map((c) => {
    const digits = text.slice(c.start, c.end).replace(/\D/g, "")
    return { ...c, with: `${BULLETS} ${digits.slice(-4)}` }
  })
  // A security code near a masked number: within 40 characters of it, on
  // either side, measured from the label.
  for (const m of text.matchAll(CODE_LABEL)) {
    const labelStart = m.index ?? 0
    const labelEnd = labelStart + m[0].length
    const near = cards.some((c) => labelStart - c.end <= 40 && c.start - labelEnd <= 40)
    if (!near) continue
    const value = m[1] as string
    const valueStart = labelEnd - value.length
    if (overlaps(cards, valueStart, labelEnd)) continue
    edits.push({ start: valueStart, end: labelEnd, with: CODE_BULLETS })
  }
  return { text: replaceSpans(text, edits), masked: cards.length }
}

/** Card numbers (and a security code near one) in plain text, masked. */
export function maskCardNumbers(text: string): MaskResult {
  return maskCards(text, TEXT_SEPARATOR, false)
}

const VENDOR_KEY = /(?<![A-Za-z0-9])((?:rk|sk)_(?:live|test)_|whsec_)[A-Za-z0-9]{10,}/g

/** Restricted keys, secret keys and webhook signing secrets, masked. */
export function maskVendorKeys(text: string): MaskResult {
  let masked = 0
  const out = text.replace(VENDOR_KEY, (_all, prefix: string) => {
    masked++
    return `${prefix}${KEY_BULLETS}`
  })
  return { text: masked > 0 ? out : text, masked }
}

/** Whether `text` holds a key that `maskVendorKeys` would mask. */
export function hasVendorKey(text: string): boolean {
  return new RegExp(VENDOR_KEY.source).test(text)
}

export interface PaymentMaskResult {
  text: string
  /** Card numbers masked. */
  cards: number
  /** Keys masked. */
  keys: number
}

/** Both masks, on plain text. */
export function maskPaymentSecrets(text: string): PaymentMaskResult {
  const keys = maskVendorKeys(text)
  const cards = maskCardNumbers(keys.text)
  return { text: cards.text, cards: cards.masked, keys: keys.masked }
}

/** Both masks, on HTML: a number split by tags or `&nbsp;` is still found. */
export function maskPaymentSecretsHtml(html: string): PaymentMaskResult {
  const keys = maskVendorKeys(html)
  const cards = maskCards(keys.text, HTML_SEPARATOR, true)
  return { text: cards.text, cards: cards.masked, keys: keys.masked }
}

/** The note a masked message carries, or null when nothing was masked. */
export function paymentMaskNote(r: { cards: number; keys: number }): string | null {
  if (r.cards > 0 && r.keys > 0) return "A card number and a key were hidden."
  if (r.cards > 1) return "Card numbers were hidden."
  if (r.cards === 1) return "A card number was hidden."
  if (r.keys > 0) return "A key was hidden."
  return null
}

/**
 * Plain text masked, with its note on a line of its own at the end, so every
 * reader (a person, an agent, an export) sees that something was taken out.
 */
export function maskWithNote(text: string): PaymentMaskResult {
  const r = maskPaymentSecrets(text)
  const note = paymentMaskNote(r)
  return note ? { ...r, text: `${r.text}\n\n[${note}]` } : r
}

/** HTML masked, with its note as a last paragraph. */
export function maskHtmlWithNote(html: string): PaymentMaskResult {
  const r = maskPaymentSecretsHtml(html)
  const note = paymentMaskNote(r)
  return note ? { ...r, text: `${r.text}<p>[${note}]</p>` } : r
}
