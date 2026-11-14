// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The contact, company and ticket panels: declared on the right slots for readers of customers only,
// drawn from a masked read, and hidden when the read is refused.
import { afterEach, describe, expect, it } from "bun:test"
import manifest from "../../app.manifest.json"
import { CompanyStripePanel } from "./CompanyStripePanel"
import { ContactStripePanel } from "./ContactStripePanel"
import * as bundle from "./index"
import { readPanel } from "./panel-view"
import { panelArgs, panelModel } from "./panels-model"
import { TicketStripeCard, ticketCustomerId } from "./TicketStripeCard"

afterEach(() => {
  ;(globalThis as any).__liaisonHost = undefined
  ;(globalThis as any).__LIAISON_TEST_APP_NAME = undefined
})

const m = manifest as any
const customer = {
  id: "cus_a",
  rowId: "row-a",
  name: "Maison Arlon",
  email: "claire@maison-arlon.example",
  currency: "eur",
  delinquent: false,
  deleted: false,
  companyId: "co1",
  contactId: null,
  linkedBy: "person",
}
const sub = {
  id: "sub_a",
  customerId: "cus_a",
  status: "past_due",
  plan: "Group",
  mrrMinor: 145000,
  currency: "eur",
  trialEnd: null,
  pastDueSince: "2026-11-03T00:00:00Z",
  card: { brand: "visa", last4: "4242", exp: "10/26" },
}

describe("panels", () => {
  it("each panel is hidden without the customers read scope", async () => {
    // Declared: the kernel lists each panel only for a viewer holding the scope.
    const panels = [
      m.slots.contact_detail.panels[0],
      m.slots.company_detail.panels[0],
      m.contributions["ticket:detail:panel"],
    ]
    expect(panels.map((p) => p.component)).toEqual([
      "ContactStripePanel",
      "CompanyStripePanel",
      "TicketStripeCard",
    ])
    for (const p of panels) expect(p.visibility_scope).toBe("stripe:customers:read")
    expect(m.slots.company_detail.panels[0].group).toBe("money")
    for (const p of panels)
      expect(typeof (bundle as Record<string, unknown>)[p.component]).toBe("function")
    // And at read time: a refusal of any kind draws nothing, not a prompt to link.
    expect(panelModel("contact", null, "en")).toEqual({ kind: "hidden" })
    expect(panelModel("contact", { error: { code: "forbidden" } }, "en")).toEqual({
      kind: "hidden",
    })
    ;(globalThis as any).__LIAISON_TEST_APP_NAME = "stripe"
    ;(globalThis as any).__liaisonHost = {
      invokeTool: async () => {
        throw new Error("missing scope stripe:customers:read")
      },
    }
    expect(await readPanel({ contactId: "c1" })).toBeNull()
    // An unlinked record is an invitation, not a hidden panel.
    ;(globalThis as any).__liaisonHost = {
      invokeTool: async () => {
        throw Object.assign(new Error("customer_not_found"), { code: "customer_not_found" })
      },
    }
    expect(panelModel("contact", await readPanel({ contactId: "c1" }), "en").kind).toBe("empty")
    expect(typeof ContactStripePanel).toBe("function")
    expect(typeof CompanyStripePanel).toBe("function")
    expect(typeof TicketStripeCard).toBe("function")
  })

  it("the company panel shows a Past due badge from the subscription's past-due date, with a masked card", () => {
    const model = panelModel(
      "company",
      { customer, subscriptions: [sub], openInvoices: [], syncedAt: "2026-11-10T08:00:00Z" },
      "en",
    )
    expect(model.kind).toBe("card")
    if (model.kind !== "card") return
    expect(model.pastDue).toBe(true)
    expect(model.pastDueLabel).toContain("Past due since")
    expect(model.card).toBe("Visa 4242, 10/26")
    expect(model.cardExpired).toBe(true)
    expect(JSON.stringify(model)).not.toMatch(/\d{12,}/)
    const ok = panelModel(
      "company",
      { customer, subscriptions: [{ ...sub, status: "active", pastDueSince: null }] },
      "en",
    )
    expect(ok.kind === "card" && ok.pastDue).toBe(false)
    expect(panelArgs("contact", "c1")).toEqual({ contactId: "c1" })
    expect(panelArgs("company", "k1")).toEqual({ companyId: "k1" })
  })

  it("the ticket card finds its customer through the app's own context read", async () => {
    const calls: any[] = []
    ;(globalThis as any).__LIAISON_TEST_APP_NAME = "stripe"
    ;(globalThis as any).__liaisonHost = {
      invokeTool: async (_a: string, tool: string, args: any) => {
        calls.push({ tool, args })
        return { customerIds: ["cus_a"], lines: [] }
      },
    }
    expect(await ticketCustomerId("t-1")).toBe("cus_a")
    expect(calls[0]).toEqual({
      tool: "customer_context",
      args: { subject: { app: "tickets", entityType: "ticket", entityId: "t-1" } },
    })
  })
})
