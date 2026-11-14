// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo's companies and its sales pipeline, in Resonant Audio Labs' names:
// the dealer network and the studios that buy direct, with the people already
// in the address book linked to them, and a dealer-sales pipeline of deals at
// every stage. Pure literals (no draw, no clock): the seeder writes them
// through the companies and deals factories.

import type { CompanySpec } from "~/seed/factories/people/companies"
import type { PipelineSpec } from "~/seed/factories/projects/deals"
import { DEMO_CUSTOMERS, DEMO_DEALERS } from "~/seed/world/fiction"
import { CUSTOMER_COMPANIES } from "./support-specs"

const dealerCompanies: CompanySpec[] = DEMO_DEALERS.map((d) => ({
  key: `dealer:${d.key}`,
  name: d.name,
  domain: `${d.key}.dealer.example`,
  description: `Resonant dealer for ${d.country}.`,
  tags: d.isVip ? ["dealer", "vip"] : ["dealer"],
  contactKeys: [`dealer:${d.key}`],
}))

const studioCompanies: CompanySpec[] = DEMO_CUSTOMERS.flatMap((c) => {
  const name = CUSTOMER_COMPANIES[c.key]
  if (!name) return []
  return [
    {
      key: `customer:${c.key}`,
      name,
      domain: c.email.split("@")[1] ?? undefined,
      tags: ["studio"],
      contactKeys: [`customer:${c.key}`],
    },
  ]
})

/** Every company the demo world holds. */
export const COMPANY_SPECS: readonly CompanySpec[] = [...dealerCompanies, ...studioCompanies]

/** The deal task's idempotency key. */
export const dealRef = (key: string) => `demo:deal:${key}`

export const SALES_PIPELINE: PipelineSpec = {
  key: "DEALS",
  name: "Dealer sales",
  description: "Dealer and studio orders from first call to signed order.",
  deals: [
    {
      key: "klangwerk-restock",
      title: "Kestrel restock for the DACH shops",
      stage: "Proposal",
      companyKey: "dealer:eu-de",
      contactKey: "dealer:eu-de",
      owner: "giulia",
      amountMinor: 3_840_000,
      currency: "EUR",
      probability: 70,
      nextStep: "Send the revised price list",
    },
    {
      key: "westcoast-spring",
      title: "Westcoast spring order",
      stage: "Demo",
      companyKey: "dealer:us-ca",
      contactKey: "dealer:us-ca",
      owner: "giulia",
      amountMinor: 2_200_000,
      currency: "USD",
      probability: 50,
      nextStep: "Book the demo call",
    },
    {
      key: "northfield-bundle",
      title: "Northfield flagship bundle",
      stage: "Qualified",
      companyKey: "dealer:uk-ldn",
      contactKey: "dealer:uk-ldn",
      owner: "tobias",
      amountMinor: 1_560_000,
      currency: "GBP",
      probability: 30,
    },
    {
      key: "harborlight-first",
      title: "Harborlight first order",
      stage: "Lead",
      companyKey: "dealer:jp-tky",
      contactKey: "dealer:jp-tky",
      owner: "giulia",
      amountMinor: 900_000,
      currency: "USD",
    },
    {
      key: "kanaal-trial",
      title: "Kanaal trial units",
      stage: "Won",
      companyKey: "dealer:nl-ams",
      contactKey: "dealer:nl-ams",
      owner: "giulia",
      amountMinor: 640_000,
      currency: "EUR",
    },
    {
      key: "lyon-preamps",
      title: "Lyon dealer field preamp batch",
      stage: "Won",
      companyKey: "dealer:fr-lyo",
      contactKey: "dealer:fr-lyo",
      owner: "tobias",
      amountMinor: 1_180_000,
      currency: "EUR",
    },
    {
      key: "studio-tone-pair",
      title: "Studio Tone preamp pair",
      stage: "Proposal",
      companyKey: "customer:claudine-moreau",
      contactKey: "customer:claudine-moreau",
      owner: "giulia",
      amountMinor: 420_000,
      currency: "EUR",
      probability: 60,
      nextStep: "Confirm delivery date",
    },
    {
      key: "nordlicht-fitout",
      title: "Nordlicht studio fit-out",
      stage: "Qualified",
      companyKey: "customer:helena-ritter",
      contactKey: "customer:helena-ritter",
      owner: "tobias",
      amountMinor: 1_850_000,
      currency: "EUR",
      probability: 40,
    },
    {
      key: "arclight-kit",
      title: "Arclight location kit",
      stage: "Lost",
      companyKey: "customer:jasper-nilsson",
      contactKey: "customer:jasper-nilsson",
      owner: "giulia",
      amountMinor: 760_000,
      currency: "EUR",
      lostReason: "Went with a cheaper recorder from another maker",
    },
  ],
}
