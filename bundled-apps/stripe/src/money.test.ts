// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Refunds and cancellations against the Stripe mock: what is refused before any
// approval, what the handler checks again after one, what Stripe receives, and
// what happens when two approvals race or an answer is lost.
import { beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  connectedDb,
  moneyCtx,
  seedCharge,
  stripeMockAdvanceHours,
  stripeMockFailNext,
  stripeMockLoseAnswerNext,
  stripeMockObject,
  stripeMockRequests,
  stripeMockReset,
  stripeMockSeed,
} from "./money.testkit"
import { refundsCreate, refundsCreatePreflight } from "./tools/refunds"
import {
  subscriptionCancel,
  subscriptionCancelEffect,
  subscriptionCancelPreflight,
} from "./tools/subscriptions"

type Obj = Record<string, any>
const manifest = () =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"))
const refundPosts = () =>
  stripeMockRequests().filter((r) => r.method === "POST" && r.path === "/v1/refunds")
const codeOf = (r: unknown) => (r as Obj)?.error?.code

beforeEach(() => stripeMockReset())

describe("refunds_create before approval", () => {
  it("each refusal returns a blocked card and parks nothing", async () => {
    const db = connectedDb()
    // The mirror is behind: it says every charge is untouched and undisputed.
    for (const id of ["ch_done", "ch_disputed", "ch_small", "ch_old"]) {
      db.seed("stripe_payments", [
        { stripe_id: id, amount_minor: 10000, refunded_minor: 0, disputed: false, currency: "eur" },
      ])
    }
    seedCharge("ch_done", 10000, 10000)
    seedCharge("ch_disputed", 10000, 0, { disputed: true })
    seedCharge("ch_small", 10000, 9000)
    seedCharge("ch_old", 10000)
    const ctx = moneyCtx(db, null)
    const answers = {
      already_refunded: await refundsCreatePreflight({ chargeId: "ch_done" }, ctx),
      charge_disputed: await refundsCreatePreflight({ chargeId: "ch_disputed" }, ctx),
      amount_over_refundable: await refundsCreatePreflight(
        { chargeId: "ch_small", amountMinor: 1001 },
        ctx,
      ),
    }
    for (const [code, answer] of Object.entries(answers)) {
      expect({ code, got: codeOf(answer), refusal: (answer as Obj).error?.refusal }).toEqual({
        code,
        got: code,
        refusal: true,
      })
    }
    // 1000 left: N-1 and N pass, N+1 (above) was refused.
    expect(
      (await refundsCreatePreflight({ chargeId: "ch_small", amountMinor: 999 }, ctx)) as Obj,
    ).toMatchObject({ ok: true })
    expect(
      (await refundsCreatePreflight({ chargeId: "ch_small", amountMinor: 1000 }, ctx)) as Obj,
    ).toMatchObject({ ok: true })

    // When Liaison issues the invoices, a charge with no Liaison invoice behind it is a person's call.
    expect((await refundsCreatePreflight({ chargeId: "ch_old" }, ctx)) as Obj).toMatchObject({
      ok: true,
    })
    const old = await refundsCreatePreflight(
      { chargeId: "ch_old" },
      moneyCtx(db, null, { cardIssuer: "liaison" }),
    )
    expect(codeOf(old)).toBe("no_invoice_for_refund")
    expect((old as Obj).error.message).toContain("which invoice")
    expect(refundPosts()).toHaveLength(0)
  })

  it("an allowed refund pins the charge and is always decided by a person", async () => {
    seedCharge("ch_ok", 5000)
    const out = (await refundsCreatePreflight(
      { chargeId: "ch_ok", amountMinor: 2000 },
      moneyCtx(connectedDb(), null),
    )) as Obj
    expect(out).toEqual({ ok: true, noAutoApprove: true, pinnedParams: { chargeId: "ch_ok" } })
    const t = manifest().tools.refunds_create
    expect(t).toMatchObject({
      gated: true,
      noAutoApprove: true,
      pinnedParams: ["chargeId"],
      approvalDedupeKeyParam: "chargeId",
      approvalDedupeSameRequester: true,
      approvalExpiryHours: 168,
      editableFields: [{ field: "amountMinor", label: "Amount incl. VAT", widget: "text" }],
      summarizerContext: { tool: "payments_search", params: { id: "chargeId" } },
    })
  })

  it("while the key is refused the refund is refused with the reason and the next step, and Stripe is not called", async () => {
    seedCharge("ch_ok", 5000)
    const db = connectedDb("connected+key_invalid")
    const staged = await refundsCreatePreflight({ chargeId: "ch_ok" }, moneyCtx(db, null))
    expect(codeOf(staged)).toBe("key_invalid")
    expect((staged as Obj).error.message).toContain("Next step")
    const ctx = moneyCtx(db, "apr-held")
    const approved = await refundsCreate({ chargeId: "ch_ok" }, ctx)
    expect(codeOf(approved)).toBe("key_invalid")
    expect(ctx.rec.noEffect.map((e) => e.code)).toEqual(["key_invalid"])
    expect(stripeMockRequests()).toHaveLength(0)
  })
})

describe("refunds_create after approval", () => {
  it("Stripe receives the approval id as the idempotency key", async () => {
    seedCharge("ch_ok", 5000)
    const ctx = moneyCtx(connectedDb(), "apr-1")
    const out = (await refundsCreate({ chargeId: "ch_ok", amountMinor: "1200" }, ctx)) as Obj
    expect(out).toMatchObject({ status: "succeeded", amountMinor: 1200, leftMinor: 3800 })
    const [post] = refundPosts()
    expect(post?.idempotencyKey).toBe("apr-1")
    expect(new URLSearchParams(post?.body ?? "").get("metadata[liaison_approval_id]")).toBe("apr-1")
    expect(ctx.rec.started).toBe(1)
    expect(ctx.rec.succeeded).toHaveLength(1)
  })

  it("after approval the handler re-reads before posting, a lost response is recorded ambiguous, and a refusal leaves no credit note", async () => {
    // Staged with 5000 left; 4000 is then refunded straight in Stripe.
    seedCharge("ch_ok", 5000)
    const db = connectedDb()
    expect(
      (await refundsCreatePreflight(
        { chargeId: "ch_ok", amountMinor: 3000 },
        moneyCtx(db, null),
      )) as Obj,
    ).toMatchObject({ ok: true })
    seedCharge("ch_ok", 5000, 4000)
    const late = moneyCtx(db, "apr-late")
    const refused = await refundsCreate({ chargeId: "ch_ok", amountMinor: 3000 }, late)
    expect(codeOf(refused)).toBe("amount_over_refundable")
    expect(late.rec.noEffect.map((e) => e.code)).toEqual(["amount_over_refundable"])
    expect((refused as Obj).creditNote).toBeUndefined()
    expect(refundPosts()).toHaveLength(0)

    // The answer to the POST is lost: the money moved, the outcome is recorded ambiguous.
    seedCharge("ch_lost", 5000)
    stripeMockLoseAnswerNext("/v1/refunds")
    const lost = moneyCtx(db, "apr-lost")
    const out = await refundsCreate({ chargeId: "ch_lost", amountMinor: 2500 }, lost)
    expect(codeOf(out)).toBe("refund_outcome_unknown")
    expect(lost.rec.ambiguous.map((e) => e.code)).toEqual(["refund_outcome_unknown"])
    expect(lost.rec.succeeded).toHaveLength(0)
    expect(stripeMockObject("charges", "ch_lost")?.amount_refunded).toBe(2500)
  })

  it("an ambiguous refund resolved after 25 hours finds the refund by metadata and posts nothing", async () => {
    seedCharge("ch_lost", 5000)
    const db = connectedDb()
    stripeMockLoseAnswerNext("/v1/refunds")
    await refundsCreate({ chargeId: "ch_lost", amountMinor: 2500 }, moneyCtx(db, "apr-25h"))
    expect(refundPosts()).toHaveLength(1)
    // Stripe forgets the idempotency key after 24 hours; the approval is retried after 25.
    stripeMockAdvanceHours(25)
    const retry = moneyCtx(db, "apr-25h")
    const out = (await refundsCreate({ chargeId: "ch_lost", amountMinor: 2500 }, retry)) as Obj
    expect(out.refundId).toMatch(/^re_/)
    expect(out.summary).toContain("nothing was sent again")
    expect(refundPosts()).toHaveLength(1)
    expect(stripeMockObject("charges", "ch_lost")?.amount_refunded).toBe(2500)
    expect(retry.rec.succeeded).toHaveLength(1)
  })

  it("two approvals racing on one charge never refund more than it holds", async () => {
    seedCharge("ch_race", 10000)
    const db = connectedDb()
    const a = moneyCtx(db, "apr-a")
    const b = moneyCtx(db, "apr-b")
    const [ra, rb] = (await Promise.all([
      refundsCreate({ chargeId: "ch_race", amountMinor: 6000 }, a),
      refundsCreate({ chargeId: "ch_race", amountMinor: 6000 }, b),
    ])) as Obj[]
    const ok = [ra, rb].filter((r) => r?.refundId)
    const refused = [ra, rb].filter((r) => r?.error)
    expect(ok).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect(a.rec.noEffect.length + b.rec.noEffect.length).toBe(1)
    expect(stripeMockObject("charges", "ch_race")?.amount_refunded).toBe(6000)
  })

  it("partial refunds sum to what Stripe holds and the last one above what is left is refused", async () => {
    seedCharge("ch_parts", 10000, 1000)
    const db = connectedDb()
    const first = (await refundsCreate(
      { chargeId: "ch_parts", amountMinor: 3000 },
      moneyCtx(db, "apr-p1"),
    )) as Obj
    const second = (await refundsCreate(
      { chargeId: "ch_parts", amountMinor: 4000 },
      moneyCtx(db, "apr-p2"),
    )) as Obj
    expect([first.leftMinor, second.leftMinor]).toEqual([6000, 2000])
    expect(
      codeOf(
        await refundsCreate({ chargeId: "ch_parts", amountMinor: 2001 }, moneyCtx(db, "apr-p3")),
      ),
    ).toBe("amount_over_refundable")
    const rest = (await refundsCreate({ chargeId: "ch_parts" }, moneyCtx(db, "apr-p4"))) as Obj
    expect(rest).toMatchObject({ amountMinor: 2000, leftMinor: 0 })
    expect(stripeMockObject("charges", "ch_parts")).toMatchObject({
      amount_refunded: 10000,
      refunded: true,
    })
  })

  it("a refund with a ticket adds an internal note and never a reply", async () => {
    seedCharge("ch_t", 5000)
    const ctx = moneyCtx(connectedDb(), "apr-t")
    const out = (await refundsCreate(
      { chargeId: "ch_t", amountMinor: 500, ticketId: "ticket-42" },
      ctx,
    )) as Obj
    expect(ctx.rec.calls.map((c) => c.tool)).toEqual(["tickets:addNote"])
    expect(ctx.rec.calls[0]?.params).toMatchObject({ ticketId: "ticket-42" })
    expect(String(ctx.rec.calls[0]?.params.text)).toContain(out.refundId)
    expect(out.summary).toContain("no reply was sent")
  })

  it("nothing is sent without an approval", async () => {
    seedCharge("ch_ok", 5000)
    expect(codeOf(await refundsCreate({ chargeId: "ch_ok" }, moneyCtx(connectedDb(), null)))).toBe(
      "approval_required",
    )
    expect(stripeMockRequests()).toHaveLength(0)
  })
})

describe("subscription_cancel", () => {
  beforeEach(() => {
    stripeMockSeed("subscriptions", { id: "sub_live", status: "active" })
  })

  it("cancel without the write permission is blocked and parks nothing; check again is a card action on the check, never on cancel", async () => {
    stripeMockFailNext("/v1/subscriptions/sub_liaison_probe", 403)
    const out = (await subscriptionCancelPreflight(
      { subscriptionId: "sub_live" },
      moneyCtx(connectedDb(), null),
    )) as Obj
    expect(out.error).toMatchObject({ code: "permission_missing", refusal: true })
    expect(out.error.message).toStartWith("This key cannot cancel subscriptions")
    const actions = out.error.body.actions as Obj[]
    expect(actions.map((a) => a.tool)).toEqual(["connection_check"])
    expect(JSON.stringify(out.error.body)).not.toContain("subscription_cancel")
    expect(stripeMockObject("subscriptions", "sub_live")).toMatchObject({
      status: "active",
      cancel_at_period_end: false,
    })
    // With the permission back, the same call stages.
    const again = (await subscriptionCancelPreflight(
      { subscriptionId: "sub_live" },
      moneyCtx(connectedDb(), null),
    )) as Obj
    expect(again).toEqual({
      ok: true,
      noAutoApprove: true,
      pinnedParams: { subscriptionId: "sub_live" },
    })
    expect(manifest().tools.subscription_cancel).toMatchObject({ gated: true, noAutoApprove: true })
  })

  it("the default cancels at period end", async () => {
    const ctx = moneyCtx(connectedDb(), "apr-c")
    const out = (await subscriptionCancel({ subscriptionId: "sub_live" }, ctx)) as Obj
    const writes = stripeMockRequests().filter(
      (r) => r.method !== "GET" && r.path === "/v1/subscriptions/sub_live",
    )
    expect(writes.map((w) => [w.method, w.body, w.idempotencyKey])).toEqual([
      ["POST", "cancel_at_period_end=true", "apr-c"],
    ])
    expect(stripeMockObject("subscriptions", "sub_live")).toMatchObject({
      status: "active",
      cancel_at_period_end: true,
    })
    expect(out.summary).toContain("stays active until")
    expect(manifest().tools.subscription_cancel.params.properties.atPeriodEnd.default).toBe(true)
  })

  it("the card shows the MRR effect, the invoice effect and the company's open deal", async () => {
    const db = connectedDb()
    db.seed("stripe_subscriptions", [
      {
        stripe_id: "sub_live",
        customer_id: "cus_1",
        plan_name: "Pro",
        mrr_minor: 4900,
        currency: "eur",
        current_period_end: "2026-12-01T00:00:00Z",
      },
    ])
    db.seed("stripe_invoices", [
      { stripe_id: "in_open", subscription_id: "sub_live", status: "open", number: "INV-7" },
    ])
    db.seed("stripe_customers", [
      { stripe_id: "cus_1", company_id: "00000000-0000-4000-8000-0000000000c1" },
    ])
    const out = (await subscriptionCancelEffect(
      { subscriptionId: "sub_live" },
      moneyCtx(db, null),
    )) as Obj
    expect(out.mrrEffect).toBe("MRR falls by 49.00 EUR from 2026-12-01.")
    expect(out.invoiceEffect).toBe("No invoice after 2026-12-01. Open invoice INV-7 stays open.")
    expect(out.dealNote).toBe("Open deal with this company: Renewal 2027.")
  })

  it("no dispute write tool exists", () => {
    const tools = manifest().tools as Record<string, Obj>
    const dispute = Object.entries(tools).filter(([n]) => /dispute/.test(n))
    expect(dispute.length).toBeGreaterThan(0)
    for (const [name, t] of dispute)
      expect({ name, readOnly: t.readOnly }).toEqual({ name, readOnly: true })
    const writes = Object.entries(tools)
      .filter(([, t]) => t.gated)
      .map(([n]) => n)
      .sort()
    expect(writes).toEqual(["refunds_create", "subscription_cancel"])
  })
})
