// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What invoicing reads from a Stripe invoice for a business buyer: each line's own tax
// inclusivity decides the net, and the buyer's VAT registration comes from its tax ids.
import { describe, expect, it } from "bun:test"
import { newTally } from "./mirror"
import { buyerOf, invoiceLine } from "./money-events"

const noHttp = {} as Parameters<typeof invoiceLine>[0]

describe("a Stripe invoice for a business buyer", () => {
  it("a tax-inclusive line is read net of its tax, an exclusive one as stated", async () => {
    const gross = await invoiceLine(
      noHttp,
      {
        amount: 12000,
        quantity: 1,
        description: "Plan",
        taxes: [
          {
            amount: 2000,
            tax_behavior: "inclusive",
            tax_rate_details: { tax_rate: { percentage: 20 } },
          },
        ],
      },
      new Map(),
      newTally(),
    )
    expect(gross).toMatchObject({
      unit_amount_excl_minor: "10000",
      tax_rate_bp: 2000,
      tax_minor: "2000",
    })
    const net = await invoiceLine(
      noHttp,
      {
        amount: 10000,
        quantity: 1,
        description: "Plan",
        taxes: [
          {
            amount: 2000,
            tax_behavior: "exclusive",
            tax_rate_details: { tax_rate: { percentage: 20 } },
          },
        ],
      },
      new Map(),
      newTally(),
    )
    expect(net).toMatchObject({
      unit_amount_excl_minor: "10000",
      tax_rate_bp: 2000,
      tax_minor: "2000",
    })
  })

  it("the buyer carries the company name, its address and its EU VAT id", () => {
    const buyer = buyerOf({
      name: "Maison Brume SAS",
      email: "achats@brume.example",
      address: { line1: "12 quai Perrache", postal_code: "69002", city: "Lyon", country: "FR" },
      tax_ids: [{ type: "eu_vat", value: "FR40123456789" }],
    })
    expect(buyer).toMatchObject({
      name: "Maison Brume SAS",
      country: "FR",
      address: "12 quai Perrache, 69002 Lyon",
      vat_id: "FR40123456789",
    })
  })
})
