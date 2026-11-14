// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  connectedDb,
  mockFetch,
  stripeMockFailNext,
  stripeMockReset,
  stripeMockSeed,
} from "./money.testkit"
import { invoiceSendState } from "./tools/send-state"

const ref = (id: string) => ({ ref: { kind: "stripe:invoice", id } })

beforeEach(() => stripeMockReset())

describe("the payment reminder guard", () => {
  it("a reminder approved after the invoice is paid does not send", async () => {
    const db = connectedDb()
    // The mirror has not heard yet: it still says open.
    db.seed("stripe_invoices", [{ stripe_id: "in_FIXTURE0001", status: "open" }])
    stripeMockSeed("invoices", { id: "in_FIXTURE0001", status: "paid", number: "INV-3" })
    expect(await invoiceSendState(ref("in_FIXTURE0001"), { db, fetch: mockFetch })).toEqual({
      stop: true,
      code: "invoice_paid",
      label: "Stripe invoice INV-3 is paid",
    })
    for (const [status, code] of [
      ["void", "invoice_void"],
      ["uncollectible", "invoice_uncollectible"],
    ]) {
      stripeMockSeed("invoices", { id: "in_FIXTURE0001", status: status as string })
      expect(await invoiceSendState(ref("in_FIXTURE0001"), { db, fetch: mockFetch })).toMatchObject(
        { stop: true, code },
      )
    }
    stripeMockSeed("invoices", { id: "in_FIXTURE0001", status: "open" })
    expect(await invoiceSendState(ref("in_FIXTURE0001"), { db, fetch: mockFetch })).toEqual({
      stop: false,
    })
  })

  it("an unreachable Stripe holds the reminder", async () => {
    stripeMockFailNext("/v1/invoices/in_FIXTURE0001", 401)
    const refused = (await invoiceSendState(ref("in_FIXTURE0001"), {
      db: connectedDb(),
      fetch: mockFetch,
    })) as any
    expect(refused.error).toMatchObject({ code: "send_guard_unavailable", retryable: true })
    const down = async () => {
      throw new TypeError("fetch failed")
    }
    expect(
      ((await invoiceSendState(ref("in_FIXTURE0001"), { db: connectedDb(), fetch: down })) as any)
        .error.code,
    ).toBe("send_guard_unavailable")
    // A refused key held by the connection never asks Stripe.
    let asked = 0
    const counting = async (...a: Parameters<typeof mockFetch>) => {
      asked++
      return mockFetch(...a)
    }
    const held = (await invoiceSendState(ref("in_FIXTURE0001"), {
      db: connectedDb("connected+key_invalid"),
      fetch: counting,
    })) as any
    expect([held.error.code, asked]).toEqual(["send_guard_unavailable", 0])
  })

  it("the guard is declared for Stripe invoices as a service message with its pill", () => {
    const m = JSON.parse(readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"))
    expect(m.sendGuardProviders).toEqual({
      "stripe:invoice": {
        tool: "invoice_send_state",
        serviceMessage: true,
        pill: { label: "Stripe: payment reminder" },
      },
    })
    expect(m.tools.invoice_send_state).toMatchObject({ readOnly: true, agentVisible: false })
    expect(m.routines["failed-payments"]).toMatchObject({
      cron: "0 7 * * *",
      enabledByDefault: false,
      followUp: true,
    })
  })
})
