// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "bun:test"
import { MemDb } from "./mem-db.testkit"
import { mockFetch, stripeMockReset, stripeMockSeed } from "./money.testkit"
import { cardUpdateLink, EFFECT } from "./tools/links"

const PORTAL = "https://billing.stripe.com/p/login/test_Abc123"
const HOSTED = "https://invoice.stripe.com/i/acct_x/live_abc"
const NOW = new Date("2026-11-20T10:00:00Z")

function ctx(db: MemDb, portal: unknown = null) {
  return { db, fetch: mockFetch, config: { get: async () => portal }, now: () => NOW }
}

beforeEach(() => stripeMockReset())

describe("the card update link", () => {
  it("the link is the pasted portal login, else the open invoice's hosted page with its true sentence, else none with the reason, and is never stored", async () => {
    const db = new MemDb()
    db.seed("stripe_invoices", [
      {
        stripe_id: "in_open",
        customer_id: "cus_1",
        status: "open",
        number: "INV-9",
        hosted_invoice_url: HOSTED,
        finalized_at: "2026-11-10T00:00:00Z",
      },
    ])
    const portal = (await cardUpdateLink({ customerId: "cus_1" }, ctx(db, PORTAL))) as Record<
      string,
      unknown
    >
    expect(portal).toMatchObject({ url: PORTAL, kind: "portal_login", effect: EFFECT.portal_login })

    const hosted = (await cardUpdateLink({ customerId: "cus_1" }, ctx(db))) as Record<
      string,
      unknown
    >
    expect(hosted).toMatchObject({ url: HOSTED, kind: "hosted_invoice", invoiceId: "in_open" })
    expect(hosted.effect).toBe(
      "Pays this invoice with a new card. Later renewals may still use the old card.",
    )
    expect(String(hosted.summary)).not.toMatch(/add a (new )?card/i)

    // A portal value that is not Stripe's login link is ignored.
    expect(
      await cardUpdateLink({ customerId: "cus_1" }, ctx(db, "https://evil.example/p/login/x")),
    ).toMatchObject({ kind: "hosted_invoice" })

    const none = (await cardUpdateLink({ customerId: "cus_2" }, ctx(db))) as Record<string, unknown>
    expect(none).toMatchObject({ url: null, kind: null })
    expect(String(none.why)).toContain("portal login link")
    expect(db.writes).toHaveLength(0)
  })

  it("a link over 30 days old is read again from Stripe and dropped when the invoice is no longer open", async () => {
    const db = new MemDb()
    db.seed("stripe_invoices", [
      {
        stripe_id: "in_FIXTURE0001",
        customer_id: "cus_1",
        status: "open",
        hosted_invoice_url: HOSTED,
        finalized_at: "2026-10-01T00:00:00Z",
      },
    ])
    stripeMockSeed("invoices", { id: "in_FIXTURE0001", status: "paid" })
    expect(await cardUpdateLink({ customerId: "cus_1" }, ctx(db))).toMatchObject({
      url: null,
      kind: null,
    })
    stripeMockSeed("invoices", {
      id: "in_FIXTURE0001",
      status: "open",
      hosted_invoice_url: `${HOSTED}_new`,
    })
    expect(await cardUpdateLink({ customerId: "cus_1" }, ctx(db))).toMatchObject({
      url: `${HOSTED}_new`,
    })
    expect(db.writes).toHaveLength(0)
  })
})
