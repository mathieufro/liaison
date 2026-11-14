// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The context lines for a ticket from a linked contact: plan, status, card
// brand and last 4, and the unpaid invoice, masked and within budget.
import { describe, expect, it } from "bun:test"
import type { CrossAppEnvelope } from "@liaison/app-sdk"
import { MemDb } from "./mem-db.testkit"
import { CONTEXT_MAX_LINES, customerContext } from "./tools/context"

const TICKET = "66666666-6666-4666-8666-666666666666"
const ANA = "33333333-3333-4333-8333-333333333333"
const CO = "11111111-1111-4111-8111-111111111111"
/** About 90 tokens at four characters a token. */
const BUDGET_CHARS = 400

function world() {
  const db = new MemDb()
  db.seed("stripe_customers", [
    {
      stripe_id: "cus_A",
      email: "ana@maison.example",
      name: "Maison Lune",
      contact_id: ANA,
      company_id: CO,
      address: { line1: "12 rue des Lilas" },
    },
  ])
  db.seed("stripe_subscriptions", [
    {
      stripe_id: "sub_1",
      customer_id: "cus_A",
      status: "past_due",
      plan_name: "Studio Pro",
      current_period_end: "2026-12-01T00:00:00.000Z",
      past_due_since: "2026-11-03T00:00:00.000Z",
      card_brand: "visa",
      card_last4: "4242",
      card_exp: "04/27",
      stripe_updated: "2026-11-09T10:00:00.000Z",
    },
  ])
  db.seed("stripe_invoices", [
    {
      stripe_id: "in_1",
      customer_id: "cus_A",
      number: "LUNE-0042",
      status: "open",
      amount_due_minor: 4900,
      currency: "eur",
      next_payment_attempt: "2026-11-12T08:00:00.000Z",
      stripe_updated: "2026-11-09T10:05:00.000Z",
    },
    {
      stripe_id: "in_0",
      customer_id: "cus_A",
      number: "LUNE-0041",
      status: "paid",
      amount_due_minor: 0,
      currency: "eur",
    },
  ])
  const executeTool = async (
    tool: string,
    params: Record<string, unknown>,
  ): Promise<CrossAppEnvelope> =>
    tool === "tickets:get" && params.ticketId === TICKET
      ? { status: "completed", result: { ticket: { id: TICKET, contactId: ANA } } }
      : { status: "error", error: { code: "not_found", message: "no" } }
  return { db, executeTool }
}

describe("the Stripe context lines", () => {
  it("a ticket from a linked contact gives plan, status, card brand, last 4 and the unpaid invoice number within budget, masked", async () => {
    const ctx = world()
    const out = (await customerContext(
      { subject: { app: "tickets", entityType: "ticket", entityId: TICKET } },
      ctx,
    )) as { lines: string[]; customerIds: string[]; source: { label: string; syncedAt: string } }
    // The ticket's card finds its customer by these ids, not by reading the lines.
    expect(out.customerIds.length).toBeGreaterThan(0)
    const text = out.lines.join("\n")
    expect(text).toContain("Studio Pro")
    expect(text).toContain("past_due")
    expect(text).toContain("visa ending 4242")
    expect(text).toContain("LUNE-0042")
    expect(text).toContain("49.00 EUR")
    expect(text).not.toContain("LUNE-0041")
    // Masked: no email, no address, no name, no expiry, no run of more than 4 digits.
    for (const leak of ["ana@maison.example", "rue des Lilas", "04/27"])
      expect(text).not.toContain(leak)
    expect(text).not.toMatch(/\d{5,}/)
    expect(out.lines.length).toBeLessThanOrEqual(CONTEXT_MAX_LINES)
    expect(text.length).toBeLessThanOrEqual(BUDGET_CHARS)
    expect(out.source).toEqual({ label: "Stripe", syncedAt: "2026-11-09T10:05:00.000Z" })
  })

  it("the same lines come for the contact and the company pages, and none for an unlinked record", async () => {
    const ctx = world()
    for (const subject of [
      { app: "kernel", entityType: "contact", entityId: ANA },
      { app: "contacts", entityType: "contact-detail", entityId: ANA },
      { app: "kernel", entityType: "company", entityId: CO },
      { app: "contacts", entityType: "company-detail", entityId: CO },
    ]) {
      const out = (await customerContext({ subject }, ctx)) as { lines: string[] }
      expect(out.lines.join("\n")).toContain("LUNE-0042")
    }
    const other = "77777777-7777-4777-8777-777777777777"
    expect(
      await customerContext(
        { subject: { app: "kernel", entityType: "company", entityId: other } },
        ctx,
      ),
    ).toEqual({
      lines: [],
    })
  })

  it("the manifest offers the provider on every kind the page yields", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { CONTEXT_KINDS } = await import("./tools/context")
    const m = JSON.parse(readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"))
    expect([...m.contextProviders[0].on].sort()).toEqual([...CONTEXT_KINDS].sort())
  })
})
