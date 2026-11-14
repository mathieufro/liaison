// SPDX-License-Identifier: FSL-1.1-ALv2
// Currencies of the money figures: ISO 4217 codes only, and never a sum across two of them.
import { ProjectsServiceError } from "./statuses"

/** The ISO 4217 codes the runtime knows; a three-letter shape when it lists none. */
const ISO_4217: ReadonlySet<string> | null = (() => {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  if (typeof intl.supportedValuesOf !== "function") return null
  const codes = intl.supportedValuesOf("currency")
  return codes.length > 0 ? new Set(codes) : null
})()

/** Is `code` an ISO 4217 currency code (upper case)? */
export function isIsoCurrency(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false
  return ISO_4217 === null || ISO_4217.has(code)
}

/**
 * A currency a person typed, upper-cased and checked. `undefined` stays undefined (the caller
 * keeps what it had); anything that is not an ISO 4217 code is refused before anything changes.
 */
export function parseCurrency(input: unknown): string | undefined {
  if (input === undefined || input === null || input === "") return undefined
  const code = typeof input === "string" ? input.trim().toUpperCase() : ""
  if (!isIsoCurrency(code)) {
    throw new ProjectsServiceError(
      400,
      "invalid_currency",
      `Nothing changed: "${String(input)}" is not a currency code. Write it as an ISO 4217 code, like EUR or USD.`,
    )
  }
  return code
}

/** The refusal of a figure whose parts are in different currencies: nothing is summed. */
export function mixedCurrencies(currencies: readonly string[], what: string, next?: string) {
  return {
    error: {
      code: "mixed_currencies",
      message: `${what} mixes ${currencies.join(" and ")}, so it does not add up to one amount. Nothing was computed.`,
      ...(next ? { next } : {}),
      retryable: false,
    },
  }
}
