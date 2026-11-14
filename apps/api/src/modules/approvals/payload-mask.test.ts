// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An approval's identity parameters keep their value: a SIRET, a VAT number, an
// IBAN, an IMEI, an order or invoice number is what the approved call needs,
// and masking it would run the call with bullets. Free text in the same
// payload is still masked.
import { describe, expect, it } from "bun:test"
import { isIdentityKey, maskApprovalPayload } from "./payload-mask"

// Luhn-valid and starting with a card prefix, so only the key can save them.
const VISA_SHAPED = "4731000000000008"
const MC_SHAPED = "5273100000000007"

describe("approval payload masking", () => {
  it("identity fields keep their value while free text is masked", () => {
    const params = {
      siret: VISA_SHAPED,
      siren: MC_SHAPED,
      vat_number: VISA_SHAPED,
      taxId: MC_SHAPED,
      iban: VISA_SHAPED,
      imei: VISA_SHAPED,
      serial: MC_SHAPED,
      order_number: VISA_SHAPED,
      invoiceNumber: MC_SHAPED,
      orderId: VISA_SHAPED,
      counterparty: { company_registration: VISA_SHAPED, ean: MC_SHAPED },
      lines: [{ sku: VISA_SHAPED, description: `card ${VISA_SHAPED}` }],
      body: `Your card ${MC_SHAPED} was refused`,
    }
    const out = maskApprovalPayload(params)
    expect(out).toEqual({
      ...params,
      lines: [{ sku: VISA_SHAPED, description: "card •••• •••• •••• 0008" }],
      body: "Your card •••• •••• •••• 0007 was refused",
    })
  })

  it("a key that names a card is never exempt, even when it ends in number", () => {
    expect(isIdentityKey("card_number")).toBe(false)
    expect(isIdentityKey("cardNumber")).toBe(false)
    expect(isIdentityKey("note")).toBe(false)
    expect(isIdentityKey("vatNumber")).toBe(true)
    expect(maskApprovalPayload({ card_number: VISA_SHAPED })).toEqual({
      card_number: "•••• •••• •••• 0008",
    })
  })

  it("keys are masked in identity fields too", () => {
    const key = `sk_live_${"51HxQzA9bC3dE4fG5hI6jK7lM8nO9pQ"}`
    expect(maskApprovalPayload({ reference: key })).toEqual({ reference: "sk_live_••••••••" })
  })
})
