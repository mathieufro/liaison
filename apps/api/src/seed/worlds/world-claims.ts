// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the door says about each world, claim by claim, and the tests that
// prove each one true of the seeded world. A door string a visitor reads
// (`kernel.demo.world.<world>.*`) that makes a claim has a row here; the meta
// test (`world-claims.test.ts`) fails on a door string with no row and on a
// row with no proof, so a claim cannot reach the door unproven.
import type { DemoWorldId } from "@liaison/shared"

export interface WorldClaim {
  /** The door string, under `kernel.demo.world.<world>.`; `<prefix>.*` covers every string under it. */
  key: string
  /** The claim, in the words of the spec's claims table. */
  claim: string
  /** What must be true of the seeded world. */
  mustBeTrue: string
  /** The test files that prove it, relative to `seed/worlds/` or the api's `src/`. */
  provenBy: readonly string[]
}

/**
 * Door strings that make no claim about the world's rows (the frame around the
 * claims: who the visitor is, that it is an example). Listed so the meta test
 * can tell a deliberate frame from a forgotten claim.
 */
export const DOOR_FRAME_KEYS: Readonly<Partial<Record<DemoWorldId, readonly string[]>>> = {
  saas: ["companyFacts", "companyExample", "companyYou"],
}

/** The software world seeded once and read through the product's tools. */
const READS = "saas/stripe-world-reads.saas.integration.test.ts"
/** The card-payments stand-in: answers, refusals and writes kept at the stand-in. */
const STAND_IN = "modules/demo/worlds/saas/payments/stripe-standin.integration.test.ts"

export const WORLD_CLAIMS: Readonly<Partial<Record<DemoWorldId, readonly WorldClaim[]>>> = {
  saas: [
    {
      key: "teamRole.*",
      claim: "the team the door names, each with a role",
      mustBeTrue: "13 named people and the owner's seat, each a member with that role",
      provenBy: [READS, "saas/plan-invariants.test.ts"],
    },
    {
      key: "companyAbout",
      claim: "169 customers pay by card",
      mustBeTrue: "the MRR query's active count is 169",
      provenBy: [READS, "world-claims.test.ts"],
    },
    {
      key: "companyAbout",
      claim: "a few larger groups pay by bank transfer",
      mustBeTrue: "Verrières and Cantines du Port Group are billed by transfer schedules",
      provenBy: [READS],
    },
    {
      key: "companyAbout",
      claim: "sold by subscription from €149 to €1,450 a month",
      mustBeTrue: "the plans' monthly prices",
      provenBy: ["saas/plan-invariants.test.ts", "world-claims.test.ts"],
    },
    {
      key: "companyOps.payments.title",
      claim: "subscriptions and payments",
      mustBeTrue: "the payments app is on with its mirror",
      provenBy: [READS],
    },
    {
      key: "companyOps.payments.body",
      claim: "the Finance Desk agent watches failed payments and drafts the note; Sara approves it",
      mustBeTrue:
        "the failed payments routine runs under the Finance Desk and Sara holds the approve scope",
      provenBy: [READS],
    },
    {
      key: "companyOps.invoicing.title",
      claim: "invoicing",
      mustBeTrue: "the invoicing app is on with the year's invoices",
      provenBy: [READS],
    },
    {
      key: "companyOps.invoicing.body",
      claim: "Liaison issues every invoice, with no gaps",
      mustBeTrue: "the issuer stream is Liaison's and numbers run with no gap",
      provenBy: [READS],
    },
    {
      key: "companyOps.support.title",
      claim: "support",
      mustBeTrue: "the tickets app is on with its queue",
      provenBy: [READS],
    },
    {
      key: "companyOps.support.body",
      claim: "customer mail lands in Tickets and the Support Desk agent drafts each reply",
      mustBeTrue: "the support inbox and the Support Desk",
      provenBy: [READS],
    },
    {
      key: "companyOps.sales.title",
      claim: "sales",
      mustBeTrue: "the pipeline exists",
      provenBy: [READS],
    },
    {
      key: "companyOps.sales.body",
      claim: "Tom's deals live on a board; a routine drafts the follow-ups",
      mustBeTrue: "the pipeline, and the deal follow-ups routine with its staged drafts",
      provenBy: [READS],
    },
    {
      key: "companyOps.product.title",
      claim: "product and chat",
      mustBeTrue: "a product project and channels",
      provenBy: [READS],
    },
    {
      key: "companyOps.product.body",
      claim: "the team plans product work in Projects and talks in Chat",
      mustBeTrue: "a product project and channels",
      provenBy: [READS],
    },
    {
      key: "companyOps.knowledge.title",
      claim: "company knowledge",
      mustBeTrue: "the knowledge base holds the company's articles",
      provenBy: [READS],
    },
    {
      key: "companyOps.knowledge.body",
      claim: "each agent reads only what its person may open",
      mustBeTrue: "the refund policy is restricted to finance",
      provenBy: [READS],
    },
    {
      key: "limitConnectors",
      claim:
        "the payments account is a stand-in; connecting a real account is refused; refunds and cancellations act on the stand-in only",
      mustBeTrue: "the stand-in answers, a real key is refused, writes stay at the stand-in",
      provenBy: [STAND_IN],
    },
    {
      key: "companySimulated",
      claim: "no mail leaves, and the payments account and its payments are stand-ins",
      mustBeTrue: "the payments stand-in answers and mail is held",
      provenBy: [STAND_IN],
    },
  ],
}
