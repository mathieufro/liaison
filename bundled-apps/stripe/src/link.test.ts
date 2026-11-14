// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `customer_link` writes Liaison's mirror row only: the fetch it is handed
// counts calls and must stay at zero. It reads the company and the contact as
// the caller first, and a record the caller cannot read refuses the link.
import { describe, expect, it } from "bun:test"
import type { CrossAppEnvelope } from "@liaison/app-sdk"
import { runCustomerMatch } from "./match"
import { MemDb } from "./mem-db.testkit"
import { customerLink } from "./tools/link"

const PERSON = "99999999-9999-4999-8999-999999999999"
const CO_A = "11111111-1111-4111-8111-111111111111"
const CO_B = "22222222-2222-4222-8222-222222222222"
const HIDDEN = "55555555-5555-4555-8555-555555555555"
const ANA = "33333333-3333-4333-8333-333333333333"

function setup() {
  const db = new MemDb()
  db.seed("stripe_customers", [
    {
      stripe_id: "cus_A",
      email: "ana@maison.example",
      name: "Maison Lune",
      company_id: CO_A,
      contact_id: null,
      match_method: "email",
    },
  ])
  const fetches: string[] = []
  const reads: string[] = []
  const ctx = {
    db,
    userId: PERSON,
    fetch: async (url: string) => {
      fetches.push(url)
      return { status: 200, headers: {}, body: "{}" }
    },
    executeTool: async (
      tool: string,
      params: Record<string, unknown>,
    ): Promise<CrossAppEnvelope> => {
      const id = String(params.companyId ?? params.contactId)
      reads.push(`${tool}:${id}`)
      if (id === HIDDEN)
        return { status: "error", error: { code: "not_found", message: "not found" } }
      return { status: "completed", result: {} }
    },
  }
  return { db, ctx, fetches, reads }
}

describe("linking a Stripe customer", () => {
  it("linking writes only Liaison rows and undo restores the previous link", async () => {
    const { db, ctx, fetches, reads } = setup()
    const linked = (await customerLink(
      { stripeCustomerId: "cus_A", companyId: CO_B, contactId: ANA },
      ctx,
    )) as Record<string, unknown>
    expect(linked.stripeChanged).toBe(false)
    expect(linked.previous).toEqual({ companyId: CO_A, contactId: null })
    expect(String(linked.summary)).toContain("nothing changed in Stripe")
    expect(reads).toEqual([`kernel:companies_read:${CO_B}`, `kernel:contacts_read:${ANA}`])
    const row = db.rows("stripe_customers")[0] as Record<string, unknown>
    expect(row).toMatchObject({
      company_id: CO_B,
      contact_id: ANA,
      match_method: "person",
      match_by: PERSON,
    })
    expect(db.writes.map((w) => w.entity)).toEqual(["stripe_customers"])

    const undone = (await customerLink({ stripeCustomerId: "cus_A", undo: true }, ctx)) as Record<
      string,
      unknown
    >
    expect(String(undone.summary)).toContain("restored its previous link")
    expect(db.rows("stripe_customers")[0]).toMatchObject({
      company_id: CO_A,
      contact_id: null,
      match_method: "email",
      match_by: null,
      previous_link: null,
    })
    const again = (await customerLink({ stripeCustomerId: "cus_A", undo: true }, ctx)) as {
      error?: { code?: string }
    }
    expect(again.error?.code).toBe("nothing_to_undo")

    await customerLink({ stripeCustomerId: "cus_A", unlink: true }, ctx)
    expect(db.rows("stripe_customers")[0]).toMatchObject({ company_id: null, contact_id: null })
    await customerLink({ stripeCustomerId: "cus_A", undo: true }, ctx)
    expect(db.rows("stripe_customers")[0]).toMatchObject({
      company_id: CO_A,
      match_method: "email",
    })

    expect(fetches).toEqual([])
  })

  it("a company or contact the person cannot read is never linked", async () => {
    const { db, ctx } = setup()
    for (const params of [
      { companyId: HIDDEN },
      { contactId: HIDDEN },
      { companyId: "not-a-uuid" },
    ]) {
      const out = (await customerLink({ stripeCustomerId: "cus_A", ...params }, ctx)) as {
        error?: { code?: string }
      }
      expect(out.error?.code).toBe("link_target_not_visible")
    }
    expect(db.writes).toEqual([])
    const blind = (await customerLink(
      { stripeCustomerId: "cus_A", companyId: CO_B },
      { ...ctx, executeTool: undefined },
    )) as {
      error?: { code?: string }
    }
    expect(blind.error?.code).toBe("link_target_not_visible")
    expect(db.writes).toEqual([])
  })

  it("an automatic match never replaces a person's link and never unlinks", async () => {
    const db = new MemDb()
    db.seed("stripe_customers", [
      {
        stripe_id: "cus_P",
        email: "p@maison.example",
        company_id: CO_A,
        contact_id: ANA,
        match_method: "person",
      },
      {
        stripe_id: "cus_Q",
        email: "q@maison.example",
        company_id: CO_A,
        contact_id: ANA,
        match_method: "email",
      },
    ])
    const calls: unknown[] = []
    const ctx = {
      db,
      resolveContact: async (p: unknown) => {
        calls.push(p)
        return null
      },
      executeTool: async (): Promise<CrossAppEnvelope> => ({
        status: "completed",
        result: { items: [] },
      }),
    }
    expect(await runCustomerMatch("cus_P", ctx)).toBeNull()
    await runCustomerMatch("cus_Q", ctx)
    expect(db.rows("stripe_customers")[1]).toMatchObject({ company_id: CO_A, contact_id: ANA })
    expect(db.writes).toEqual([])
    expect(calls).toHaveLength(2)
  })

  // A Stripe customer's email is typed by whoever pays: it proves nothing about who they are.
  function emailCase(existing: Array<{ id: string; primaryEmail: string }>) {
    const db = new MemDb()
    db.seed("stripe_customers", [
      {
        stripe_id: "cus_E",
        email: "Ana@Maison.example",
        name: "Payer",
        company_id: null,
        contact_id: null,
        match_method: null,
      },
    ])
    const resolved: unknown[] = []
    const ctx = {
      db,
      resolveContact: async (p: Record<string, unknown>) => {
        resolved.push(p)
        return { id: "66666666-6666-4666-8666-666666666666", companyId: CO_B }
      },
      executeTool: async (
        tool: string,
        params: Record<string, unknown>,
      ): Promise<CrossAppEnvelope> => {
        expect({ tool, query: params.query }).toEqual({
          tool: "kernel:contacts_search",
          query: "ana@maison.example",
        })
        return { status: "completed", result: { items: existing } }
      },
    }
    return { db, ctx, resolved }
  }

  it("a customer whose email names an existing contact is only a suggestion: nothing is linked or written", async () => {
    const { db, ctx, resolved } = emailCase([{ id: ANA, primaryEmail: "ana@maison.example" }])
    const result = await runCustomerMatch("cus_E", ctx)
    expect(result?.contactSuggestion).toEqual({ contactId: ANA, email: "ana@maison.example" })
    expect(result?.contactId).toBeNull()
    expect(resolved).toEqual([])
    expect(db.writes).toEqual([])
    expect(db.rows("stripe_customers")[0]).toMatchObject({ contact_id: null, company_id: null })
  })

  it("a customer whose email names no contact gets a new contact, linked", async () => {
    const { db, ctx, resolved } = emailCase([
      { id: ANA, primaryEmail: "someone-else@maison.example" },
    ])
    const result = await runCustomerMatch("cus_E", ctx)
    expect(resolved).toEqual([{ email: "Ana@Maison.example", name: "Payer", externalId: "cus_E" }])
    expect(result?.contactSuggestion ?? null).toBeNull()
    expect(db.rows("stripe_customers")[0]).toMatchObject({
      contact_id: "66666666-6666-4666-8666-666666666666",
      company_id: CO_B,
      match_method: "contact_company",
    })
  })

  it("when the contacts cannot be searched, nothing is linked or created until the next change", async () => {
    const { db, ctx, resolved } = emailCase([])
    ctx.executeTool = async () => ({ status: "error", error: { code: "forbidden", message: "no" } })
    expect(await runCustomerMatch("cus_E", ctx)).toBeNull()
    expect(resolved).toEqual([])
    expect(db.writes).toEqual([])
  })
})
