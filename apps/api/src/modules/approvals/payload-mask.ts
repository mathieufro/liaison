// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Card numbers and payment keys masked in an approval's payload, before it is
// stored: when a request is created, when its payload is updated by the agent
// (`approval_update_payload`), by a person's edit, or by an app's restage. An
// agent can write a customer's card number or a pasted key into a staged reply;
// the approval row, its summary and whatever the approved call sends then hold
// bullets instead. The same rules as every message (`@liaison/shared`
// pan-scan): a key keeps its prefix only; a card number keeps its last four.
//
// Keys are masked in every string. Card numbers are masked in every string
// except identity fields, where a long Luhn-valid number is what the field
// says it is, never a card: ids and references (`id`, `…Id`, `…_id`, `…Ref`,
// `gid://…`, URLs), company and tax identifiers (SIRET, SIREN, VAT, tax and
// registration numbers), bank identifiers (IBAN, BIC), device identifiers
// (IMEI, serial), order and invoice numbers, and product codes (EAN, GTIN,
// SKU). The field is read from its key's last word (`vat_number`,
// `invoiceNumber`, `siret`); a key that names a card (`card_number`) is never
// exempt.
import { maskCardNumbers, maskVendorKeys } from "@liaison/shared"

const IDENTITY_WORDS = new Set([
  "id",
  "ids",
  "ref",
  "refs",
  "reference",
  "url",
  "siret",
  "siren",
  "vat",
  "tva",
  "tax",
  "registration",
  "iban",
  "bic",
  "imei",
  "serial",
  "number",
  "numbers",
  "no",
  "ean",
  "gtin",
  "sku",
  "tracking",
])
const CARD_WORDS = new Set(["card", "cards", "pan", "cc", "cvc", "cvv"])

/** The words of a parameter key: `invoiceNumber`, `vat_number`, `SIRET` all split. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
}

/** Whether `key` names an identity field, whose value is never a card. */
export function isIdentityKey(key: string): boolean {
  const words = keyWords(key)
  const last = words[words.length - 1]
  if (last === undefined || words.some((w) => CARD_WORDS.has(w))) return false
  return IDENTITY_WORDS.has(last)
}

function maskString(text: string, key: string | null): string {
  const keys = maskVendorKeys(text).text
  if ((key !== null && isIdentityKey(key)) || /^(gid|https?):\/\//.test(keys)) return keys
  return maskCardNumbers(keys).text
}

function walk(value: unknown, key: string | null): unknown {
  if (typeof value === "string") return maskString(value, key)
  if (Array.isArray(value)) return value.map((v) => walk(v, key))
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, k)
    return out
  }
  return value
}

/** `value` with every card number and payment key in its strings masked; unchanged values keep their shape. */
export function maskApprovalPayload<T>(value: T): T {
  return walk(value, null) as T
}
