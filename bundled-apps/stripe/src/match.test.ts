// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The matcher against fixtures, one per case: the lookups are counted, so the
// order is proven by which ones ran.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type MatchContact, type MatchDeps, matchCustomer } from "./match"

const CO = "11111111-1111-4111-8111-111111111111"
const OTHER_CO = "22222222-2222-4222-8222-222222222222"
const ANA = "33333333-3333-4333-8333-333333333333"
const BEN = "44444444-4444-4444-8444-444444444444"

function deps(fixture: {
  byEmail?: Record<string, MatchContact>
  byExternal?: Record<string, MatchContact>
  byDomain?: Record<string, { id: string; name: string }>
}) {
  const calls: string[] = []
  const d: MatchDeps = {
    contactByEmail: async (email) => {
      calls.push(`email:${email}`)
      return fixture.byEmail?.[email] ?? null
    },
    contactByExternalId: async (id) => {
      calls.push(`external:${id}`)
      return fixture.byExternal?.[id] ?? null
    },
    companyByDomain: async (domain) => {
      calls.push(`domain:${domain}`)
      return fixture.byDomain?.[domain] ?? null
    },
  }
  return { d, calls }
}

describe("matching a Stripe customer", () => {
  it("matching runs email, then the contact's company, then the external id; a domain only suggests; a free-mail address never matches", async () => {
    // 1. Exact email: the contact, and its company.
    const one = deps({
      byEmail: { "ana@maison.example": { id: ANA, companyId: CO } },
      byExternal: { cus_1: { id: BEN, companyId: OTHER_CO } },
    })
    expect(await matchCustomer({ stripe_id: "cus_1", email: "ana@maison.example" }, one.d)).toEqual(
      {
        contactId: ANA,
        companyId: CO,
        method: "contact_company",
        suggestion: null,
      },
    )
    expect(one.calls).toEqual(["email:ana@maison.example"])

    // 2. Email names a contact without a company: the contact only, the domain suggests.
    const two = deps({
      byEmail: { "ana@maison.example": { id: ANA, companyId: null } },
      byDomain: { "maison.example": { id: CO, name: "Maison" } },
    })
    expect(await matchCustomer({ stripe_id: "cus_2", email: "ana@maison.example" }, two.d)).toEqual(
      {
        contactId: ANA,
        companyId: null,
        method: "email",
        suggestion: { companyId: CO, name: "Maison", domain: "maison.example" },
      },
    )

    // 3. No email match: the contact carrying the customer id.
    const three = deps({ byExternal: { cus_3: { id: BEN, companyId: OTHER_CO } } })
    expect(
      await matchCustomer({ stripe_id: "cus_3", email: "nobody@maison.example" }, three.d),
    ).toEqual({
      contactId: BEN,
      companyId: OTHER_CO,
      method: "external_id",
      suggestion: null,
    })
    expect(three.calls).toEqual(["email:nobody@maison.example", "external:cus_3"])

    // 4. Only the domain: a suggestion, no link.
    const four = deps({ byDomain: { "maison.example": { id: CO, name: "Maison" } } })
    expect(
      await matchCustomer({ stripe_id: "cus_4", email: "new@maison.example" }, four.d),
    ).toEqual({
      contactId: null,
      companyId: null,
      method: null,
      suggestion: { companyId: CO, name: "Maison", domain: "maison.example" },
    })

    // 5. Free mail: no company and no suggestion, even when a company carries the domain.
    for (const email of ["claire@gmail.com", "claire@hotmail.fr", "claire@t-online.de"]) {
      const five = deps({
        byDomain: { [email.split("@")[1] as string]: { id: CO, name: "Wrong" } },
      })
      expect(await matchCustomer({ stripe_id: "cus_5", email }, five.d)).toEqual({
        contactId: null,
        companyId: null,
        method: null,
        suggestion: null,
      })
      expect(five.calls.some((c) => c.startsWith("domain:"))).toBe(false)
    }

    // 6. No email at all: the external id only.
    const six = deps({})
    expect(await matchCustomer({ stripe_id: "cus_6", email: null }, six.d)).toEqual({
      contactId: null,
      companyId: null,
      method: null,
      suggestion: null,
    })
    expect(six.calls).toEqual(["external:cus_6"])
  })

  it("the free-mail list is the product's own, byte for byte", () => {
    const copy = readFileSync(join(import.meta.dir, "consumer-domains.ts"), "utf8")
    const product = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "apps",
        "api",
        "src",
        "modules",
        "apps",
        "connections",
        "api",
        "consumer-domains.ts",
      ),
      "utf8",
    )
    expect(copy).toBe(product)
  })
})
