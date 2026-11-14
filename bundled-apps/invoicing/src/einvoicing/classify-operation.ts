// SPDX-License-Identifier: FSL-1.1-ALv2
// Operation category (goods / services / mixed) and the BT-23 operation type code. Pure.

export type OperationCategory = "goods" | "services" | "mixed"
export type PaymentState = "due" | "paid" | "final_after_deposit"
export type Bt23 = "B1" | "S1" | "M1" | "B2" | "S2" | "M2" | "B4" | "S4" | "M4"

export interface OperationResult {
  category: OperationCategory | null
  source: "lines_authoritative" | "lines_default"
}

/** Shipping counts with goods, a software or service line is a service, a missing kind is the goods default. */
export function operationCategory(
  lines: ReadonlyArray<{ line_kind?: string | null }>,
  opts: { authoritative: boolean },
): OperationResult {
  const source = opts.authoritative ? "lines_authoritative" : "lines_default"
  if (lines.length === 0) return { category: null, source }
  let goods = false
  let services = false
  for (const l of lines) {
    if (l.line_kind === "software" || l.line_kind === "service") services = true
    else goods = true
  }
  return { category: goods && services ? "mixed" : services ? "services" : "goods", source }
}

const LETTER: Record<OperationCategory, "B" | "S" | "M"> = { goods: "B", services: "S", mixed: "M" }
const STATE: Record<PaymentState, "1" | "2" | "4"> = {
  due: "1",
  paid: "2",
  final_after_deposit: "4",
}

export function bt23(category: OperationCategory, paymentState: PaymentState): Bt23 {
  return `${LETTER[category]}${STATE[paymentState]}` as Bt23
}
