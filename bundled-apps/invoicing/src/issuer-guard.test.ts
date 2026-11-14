// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One customer, one issuer. Each path that makes a Liaison invoice for a named customer asks the
// Stripe app's mirror whether a live subscription already bills them, in its preflight and in its
// handler, through the Stripe app's own read (its mirror in memory here). A mirror that cannot
// answer yet refuses; Stripe never connected asks nothing; Shopify orders, credit notes and quotes
// never ask.
import { describe, expect, test } from "bun:test"
import { MemDb } from "../../stripe/src/mem-db.testkit"
import { billingStatusForCounterparty } from "../../stripe/src/tools/routes"
import type { CivilTime } from "./issue-date"
import { BILLED_BY_STRIPE, checkIssuerGuard, STRIPE_UNREACHABLE } from "./issuer-guard"
import {
  draftsCreatePreflight,
  draftsCreateTool,
  draftsUpdatePreflight,
  draftsUpdateTool,
} from "./mutations/drafts"
import {
  invoiceCreateAndIssue,
  invoiceCreateAndIssuePreflight,
  invoiceIssue,
  invoiceIssuePreflight,
} from "./mutations/invoice-issue"
import { recurringItemIssue } from "./recurring/issue-job"
import { rowIssuerHold, runItemState } from "./recurring/item-state"
import { weekdayOf } from "./recurring/schedule"
import {
  checkScheduleCreate,
  checkScheduleUpdate,
  recurringScheduleCreate,
  recurringScheduleUpdate,
} from "./recurring/tools"
import { stripeDocumentRef } from "./streams"
import { createMockDb } from "./test-db"

type Obj = Record<string, any>
const ISSUER = "11111111-1111-4111-8111-111111111111"
const PAYER = "22222222-2222-4222-8222-222222222222"
const OTHER = "33333333-3333-4333-8333-333333333333"
const DRAFT = "44444444-4444-4444-8444-444444444444"
const SCHEDULE = "55555555-5555-4555-8555-555555555555"
const ITEM = "66666666-6666-4666-8666-666666666666"
const RUN = "77777777-7777-4777-8777-777777777777"

/** The Stripe app's mirror: connected and imported unless told otherwise, one live subscription. */
function stripeMirror(
  opts: {
    state?: string
    customers?: string
    subscriptions?: string
    linked?: boolean
    permissions?: unknown
  } = {},
) {
  const db = new MemDb()
  db.seed("install_metadata", [
    { state: opts.state ?? "connected", permissions: opts.permissions ?? null },
  ])
  db.seed("sync_state", [
    { resource: "customers", status: opts.customers ?? "done" },
    { resource: "subscriptions", status: opts.subscriptions ?? "done" },
  ])
  db.seed("stripe_customers", [
    {
      stripe_id: "cus_payer",
      email: "Billing@Payer.example",
      ...(opts.linked === false ? {} : { contact_id: PAYER }),
    },
  ])
  db.seed("stripe_subscriptions", [
    { stripe_id: "sub_group", customer_id: "cus_payer", status: "active", plan_name: "Group plan" },
  ])
  return db
}

function civilOf(date: string, zone: string, hour = 9): CivilTime {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number]
  return { date, year: y, month: m, day: d, hour, minute: 0, weekday: weekdayOf(date), zone }
}

interface WorldOpts {
  connected?: boolean | "no_row"
  mirror?: MemDb
  agent?: boolean
  approved?: boolean
  stripeOff?: boolean
  contactEmail?: string
}

/** Invoicing's store with an issuer, a card stream row, and a ctx whose cross-app calls reach the Stripe app's read. */
function world(opts: WorldOpts = {}) {
  const db = createMockDb({
    bridgeWhereOperators: true,
    seed: {
      issuer_profiles: [
        {
          id: ISSUER,
          legal_name: "Maree Logiciel SAS",
          country: "FR",
          vat_id: "FR40902000009",
          default_currency: "EUR",
          timezone: "Europe/Paris",
        },
      ],
      ...(opts.connected === "no_row"
        ? {}
        : {
            stripe_streams: [
              {
                id: "st-1",
                issuer_profile_id: ISSUER,
                issuer: "liaison",
                stripe_connected: opts.connected !== false,
              },
            ],
          }),
    },
  })
  const mirror = opts.mirror ?? stripeMirror()
  const calls: Array<{ tool: string; params: Obj }> = []
  const approvals: Obj[] = []
  const ctx: Obj = {
    db,
    approval: opts.approved
      ? { approvalRequestId: "req-1", approvalDeciderId: "person-1", toolName: "invoicing:x" }
      : null,
    getUserId: async () => "person-1",
    turn: {
      get: async () => ({ agentId: opts.agent ? "agent-1" : null, hasPerson: opts.agent === true }),
    },
    time: { civil: async ({ timezone }: { timezone: string }) => civilOf("2026-11-30", timezone) },
    emit: async () => {},
    requestApproval: async (input: Obj) => {
      approvals.push(input)
      return { approval_id: `appr-${approvals.length}`, auto_approved: false }
    },
    executeTool: async (tool: string, params: Obj) => {
      calls.push({ tool, params })
      if (tool === "kernel:contacts_identity")
        return { status: "completed", result: { contact: { email: opts.contactEmail ?? null } } }
      if (tool === "stripe:billing_status_for_counterparty") {
        if (opts.stripeOff)
          return {
            status: "error",
            error: { code: "tool_not_found", message: "tool not registered" },
          }
        return {
          status: "completed",
          result: await billingStatusForCounterparty(params, { db: mirror as never }),
        }
      }
      return { status: "error", error: { code: "tool_not_found", message: tool } }
    },
  }
  const stripeCalls = () => calls.filter((c) => c.tool.startsWith("stripe:")).length
  return { db, ctx, calls, stripeCalls, approvals, mirror }
}

async function seedDraft(db: Obj, extra: Obj = {}) {
  await db.insert("documents", {
    id: DRAFT,
    type: "invoice",
    status: "draft",
    issuer_profile_id: ISSUER,
    counterparty_contact_id: PAYER,
    counterparty_name: "Jordan Payer",
    counterparty_email: "accounts@payer.example",
    counterparty_country: "DE",
    counterparty_address: "Hauptstrasse 1, 10115 Berlin",
    currency: "EUR",
    external_refs: {},
    lifecycle_log: [],
    ...extra,
  })
}

const counterparty = (contactId: string) => ({
  contact_id: contactId,
  legal_name: "Jordan Payer",
  address: "Hauptstrasse 1, 10115 Berlin",
  country: "DE",
  email: "accounts@payer.example",
})
const items = [
  { description: "Consulting", quantity: "1", unit_price_minor: "50000", tax_rate_bp: 2000 },
]
const code = (r: unknown) => (r as Obj)?.error?.code ?? (r as Obj)?.code
const thrownCode = async (p: Promise<unknown>) => {
  try {
    const r = await p
    return code(r) ?? (r as Obj)?.status
  } catch (err) {
    return String((err as Error).message).split(":")[0]
  }
}

describe("the issuer guard on every path that invoices a named customer", () => {
  test("a live Stripe customer is refused on each guarded tool unless a person says what else it bills, and bypassing the preflight the handler still refuses", async () => {
    const { db, ctx } = world()
    await seedDraft(db)
    // Preflight (stage time) and handler (the call itself, the preflight never run).
    expect(code(await invoiceIssuePreflight(ctx as never, { draft_id: DRAFT }))).toBe(
      "subscription_stream_conflict",
    )
    expect(code(await invoiceIssue(ctx as never, { draft_id: DRAFT }))).toBe(
      "subscription_stream_conflict",
    )
    const create = { counterparty: counterparty(PAYER), currency: "EUR", items } as never
    expect(code(await invoiceCreateAndIssuePreflight(ctx as never, create))).toBe(
      "subscription_stream_conflict",
    )
    expect(code(await invoiceCreateAndIssue(ctx as never, create))).toBe(
      "subscription_stream_conflict",
    )
    const draft = {
      type: "invoice",
      counterparty_contact_id: PAYER,
      counterparty_name: "Jordan Payer",
      counterparty_email: "accounts@payer.example",
      counterparty_country: "DE",
      items,
    } as never
    expect(code(await draftsCreatePreflight(ctx as never, draft))).toBe(
      "subscription_stream_conflict",
    )
    expect(await thrownCode(draftsCreateTool(ctx as never, draft))).toBe(
      "subscription_stream_conflict",
    )
    // drafts_update only when the buyer changes: the buyer moves to the payer.
    await seedDraft(db, {
      id: "88888888-8888-4888-8888-888888888888",
      counterparty_contact_id: OTHER,
      counterparty_email: "x@other.example",
    })
    const move = {
      draft_id: "88888888-8888-4888-8888-888888888888",
      patch: { counterparty_contact_id: PAYER },
    }
    expect(code(await draftsUpdatePreflight(ctx as never, move as never))).toBe(
      "subscription_stream_conflict",
    )
    expect(await thrownCode(draftsUpdateTool(ctx as never, move as never))).toBe(
      "subscription_stream_conflict",
    )
    const schedule = {
      issuer_profile_id: ISSUER,
      contact_id: PAYER,
      repeats: "month",
      billing_day: "last",
      lines: [{ description: "Retainer", qty: 1, unit_price_minor: 1000, vat_bp: 2000 }],
    } as never
    expect(code(await checkScheduleCreate(ctx as never, schedule))).toBe(
      "subscription_stream_conflict",
    )
    expect(code(await recurringScheduleCreate(ctx as never, schedule))).toBe(
      "subscription_stream_conflict",
    )

    // A person's statement of what else it bills lets the same calls through the guard.
    const said = "Consulting days, not the plan"
    expect(
      code(
        await invoiceIssuePreflight(ctx as never, { draft_id: DRAFT, billsOtherThanStripe: said }),
      ),
    ).not.toBe("subscription_stream_conflict")
    expect(
      code(
        await recurringScheduleCreate(
          ctx as never,
          { ...(schedule as Obj), billsOtherThanStripe: said } as never,
        ),
      ),
    ).toBeUndefined()
    const saved = (await db.findMany("recurring_schedules", { limit: 5 })) as Obj[]
    expect(saved[0]).toMatchObject({ bills_other_than_stripe: said, bills_other_by: "person-1" })
    // An update of that schedule keeps passing on the stored statement; four characters say nothing.
    expect(
      await checkScheduleUpdate(ctx as never, { id: String(saved[0]?.id), notes: "x" } as never),
    ).toBeNull()
    expect(
      code(await invoiceIssue(ctx as never, { draft_id: DRAFT, billsOtherThanStripe: "work" })),
    ).toBe("subscription_stream_conflict")
  })

  test("an agent's statement of what else it bills waits for a person, and an approved card goes on", async () => {
    const agent = world({ agent: true })
    const draft = {
      type: "invoice",
      counterparty_contact_id: PAYER,
      counterparty_name: "Jordan Payer",
      counterparty_email: "a@payer.example",
      counterparty_country: "DE",
      items,
      billsOtherThanStripe: "Consulting days",
    } as never
    const parked = (await draftsCreateTool(agent.ctx as never, draft)) as Obj
    expect(parked.status).toBe("pending_approval")
    expect(agent.approvals[0]?.summary_detail.lines[0]).toContain("Consulting days")
    expect(await agent.db.findMany("documents", { limit: 5 })).toHaveLength(0)
    const approved = world({ agent: true, approved: true })
    const v = await checkIssuerGuard(approved.ctx as never, {
      contactId: PAYER,
      billsOtherThanStripe: "Consulting days",
      stage: "handler",
    })
    expect(v.ok).toBe(true)
  })

  test("Stripe connected but unreachable refuses with a retry line; Stripe disconnected or turned off passes; Shopify, credit notes and quotes never call it", async () => {
    const down = world()
    down.ctx.executeTool = async (tool: string) =>
      tool.startsWith("stripe:")
        ? { status: "error", error: { code: "upstream_timeout", message: "timed out" } }
        : { status: "completed", result: {} }
    await seedDraft(down.db)
    const r = (await invoiceIssue(down.ctx as never, { draft_id: DRAFT })) as Obj
    expect(r.error.code).toBe("subscription_check_unavailable")
    expect(r.error.message).toContain("Try again in a few minutes")

    // Never connected or disconnected, as Stripe itself says: the guard passes and reads no mirror.
    for (const connected of ["no_row", false] as const) {
      const off = world({ connected, mirror: stripeMirror({ state: "not_connected" }) })
      await seedDraft(off.db)
      expect(code(await invoiceIssuePreflight(off.ctx as never, { draft_id: DRAFT }))).not.toBe(
        "subscription_stream_conflict",
      )
      expect(off.stripeCalls()).toBe(1)
    }
    // The Stripe app turned off answers as absent: the guard passes.
    const appOff = world({ stripeOff: true })
    expect(
      (await checkIssuerGuard(appOff.ctx as never, { contactId: PAYER, stage: "handler" })).ok,
    ).toBe(true)

    // A Shopify order's invoice, a credit note and a quote never ask.
    const w = world()
    await seedDraft(w.db, { shopify_order_id: "1001", external_refs: { shopify_order_id: "1001" } })
    await invoiceIssuePreflight(w.ctx as never, { draft_id: DRAFT })
    await invoiceCreateAndIssuePreflight(
      w.ctx as never,
      {
        counterparty: counterparty(PAYER),
        currency: "EUR",
        items,
        shopify_order_id: "1002",
      } as never,
    )
    for (const type of ["credit_note", "quote"]) {
      await draftsCreatePreflight(
        w.ctx as never,
        {
          type,
          counterparty_contact_id: PAYER,
          counterparty_name: "Jordan Payer",
          counterparty_country: "DE",
          items,
        } as never,
      )
    }
    expect(w.stripeCalls()).toBe(0)
  })

  test("with no card stream row while Stripe is connected, a Stripe-billed customer is refused as if the row existed, and the row is made", async () => {
    // The connection event was lost: invoicing holds no card stream row at all.
    const { db, ctx } = world({ connected: "no_row" })
    await seedDraft(db)
    expect(code(await invoiceIssue(ctx as never, { draft_id: DRAFT }))).toBe(
      "subscription_stream_conflict",
    )
    expect(code(await invoiceIssuePreflight(ctx as never, { draft_id: DRAFT }))).toBe(
      "subscription_stream_conflict",
    )
    // The read healed the row: connected, undecided until a person picks.
    expect(
      ((await db.findMany("stripe_streams", { limit: 5 })) as Obj[]).map((r) => [
        r.issuer_profile_id,
        r.stripe_connected,
        r.issuer,
      ]),
    ).toEqual([[ISSUER, true, "undecided"]])
    // Still no row and Stripe cannot say whether it is connected: unavailable, with the next step.
    const blind = world({ connected: "no_row" })
    blind.ctx.executeTool = async (tool: string) =>
      tool.startsWith("stripe:")
        ? { status: "error", error: { code: "upstream_timeout", message: "timed out" } }
        : { status: "completed", result: {} }
    const v = await checkIssuerGuard(blind.ctx as never, { contactId: PAYER, stage: "handler" })
    expect(v.ok ? null : v.error.error.code).toBe("subscription_check_unavailable")
    expect(v.ok ? "" : v.error.error.message).toContain("Try again in a few minutes")
  })

  test("while importing or with subscriptions unreadable the guard refuses as unavailable", async () => {
    const cases = [
      stripeMirror({ state: "importing" }),
      stripeMirror({ subscriptions: "running" }),
      stripeMirror({ state: "connected+key_invalid" }),
      stripeMirror({ state: "connected+stalled" }),
      // A key that cannot read subscriptions: the mirror holds none and would say "free to bill".
      stripeMirror({
        state: "connected+partial",
        permissions: JSON.stringify({
          checks: [
            { resource: "customers", level: "read", state: "ok" },
            { resource: "subscriptions", level: "read", state: "missing" },
          ],
        }),
      }),
    ]
    for (const mirror of cases) {
      // The customer here pays nothing: only an incomplete mirror can make the guard refuse.
      mirror.rows("stripe_subscriptions").length = 0
      const { ctx } = world({ mirror })
      const v = await checkIssuerGuard(ctx as never, { contactId: PAYER, stage: "handler" })
      expect({ ok: v.ok, code: v.ok ? null : v.error.error.code }).toEqual({
        ok: false,
        code: "subscription_check_unavailable",
      })
    }
    // A missing read elsewhere (disputes) leaves the answer intact.
    const disputes = stripeMirror({
      state: "connected+partial",
      permissions: JSON.stringify({
        checks: [
          { resource: "customers", level: "read", state: "ok" },
          { resource: "subscriptions", level: "read", state: "ok" },
          { resource: "disputes", level: "read", state: "missing" },
        ],
      }),
    })
    disputes.rows("stripe_subscriptions").length = 0
    expect(
      (
        await checkIssuerGuard(world({ mirror: disputes }).ctx as never, {
          contactId: PAYER,
          stage: "handler",
        })
      ).ok,
    ).toBe(true)
  })

  test("an unlinked Stripe customer with the same email is refused", async () => {
    // Stripe's customer is not linked to the contact: only its email names them.
    const mirror = stripeMirror({ linked: false })
    const byDraftEmail = world({ mirror })
    const v = await checkIssuerGuard(byDraftEmail.ctx as never, {
      contactId: OTHER,
      emails: ["billing@payer.example"],
      stage: "handler",
    })
    expect(v.ok ? null : v.error.error.code).toBe("subscription_stream_conflict")
    // The contact's own email, read from the kernel, finds them too.
    const byContact = world({ mirror, contactEmail: "BILLING@payer.example" })
    const w = await checkIssuerGuard(byContact.ctx as never, { contactId: OTHER, stage: "handler" })
    expect(w.ok ? null : w.error.error.code).toBe("subscription_stream_conflict")
    // Another email is free to bill.
    expect(
      (
        await checkIssuerGuard(world({ mirror }).ctx as never, {
          contactId: OTHER,
          emails: ["x@else.example"],
          stage: "handler",
        })
      ).ok,
    ).toBe(true)
  })

  test("a schedule created before the connection is held at its next run once its customer has a live subscription", async () => {
    const { db, ctx, stripeCalls } = world()
    await db.insert("recurring_schedules", {
      id: SCHEDULE,
      issuer_profile_id: ISSUER,
      contact_id: PAYER,
      status: "active",
      repeats: "month",
      billing_day: "last",
      lines: [],
      version: 1,
      created_by: "person-1",
    })
    await db.insert("recurring_runs", {
      id: RUN,
      issuer_profile_id: ISSUER,
      issue_on: "2026-11-30",
      latest_issue_on: "2026-11-30",
      status: "issuing",
    })
    await seedDraft(db, { external_ref: `recurring:${SCHEDULE}:2026-11` })
    await db.insert("recurring_run_items", {
      id: ITEM,
      run_id: RUN,
      schedule_id: SCHEDULE,
      document_id: DRAFT,
      period_key: "2026-11",
      state: "approved",
      approved_hash: "h",
    })
    // The row's state shows the hold, before any card is approved.
    const draft = (await db.findOne("documents", DRAFT)) as Obj
    const schedule = (await db.findOne("recurring_schedules", SCHEDULE)) as Obj
    const hold = await rowIssuerHold(ctx as never, draft, schedule)
    expect(hold).toBe(BILLED_BY_STRIPE)
    expect(
      runItemState(draft, [{ quantity: "1", unit_price_minor: "1000", tax_rate_bp: 2000 }], hold),
    ).toEqual({ state: "needs_fix", reason: BILLED_BY_STRIPE })
    // The run's own issue path asks the guard too: the row stays a draft and no number is taken.
    const r = (await recurringItemIssue(ctx as never, { item_id: ITEM })) as Obj
    expect(r.error.code).toBe("subscription_stream_conflict")
    expect((await db.findOne("recurring_run_items", ITEM)) as Obj).toMatchObject({
      state: "needs_fix",
      note: BILLED_BY_STRIPE,
    })
    expect((await db.findOne("documents", DRAFT)) as Obj).toMatchObject({
      status: "draft",
      external_ref: `recurring:${SCHEDULE}:2026-11`,
    })
    expect(stripeCalls()).toBeGreaterThan(0)
    // A mirror that cannot answer holds the row too, with its own reason.
    const importing = world({ mirror: stripeMirror({ state: "importing" }) })
    expect(await rowIssuerHold(importing.ctx as never, draft, schedule)).toBe(STRIPE_UNREACHABLE)
  })

  test("a charge with an invoice is keyed by that invoice, so a payment invoiced by hand and the finalized invoice share one external_ref", () => {
    expect(stripeDocumentRef({ id: "ch_1", invoice: "in_1" })).toBe("stripe:in_1")
    expect(stripeDocumentRef({ id: "ch_1", invoice: null })).toBe("stripe:ch_1")
    // Both paths of one invoiced charge land on the same unique key.
    expect(stripeDocumentRef({ id: "ch_1", invoice: "in_1" })).toBe(`stripe:${"in_1"}`)
  })
})

describe("updates that never meet the guard", () => {
  test("ending a schedule bills nothing more and never asks", async () => {
    const { db, ctx, stripeCalls } = world()
    await db.insert("recurring_schedules", {
      id: SCHEDULE,
      issuer_profile_id: ISSUER,
      contact_id: PAYER,
      status: "active",
      repeats: "month",
      billing_day: "last",
      lines: [{ description: "R", qty: 1, unit_price_minor: 1000, vat_bp: 2000 }],
      version: 1,
      created_by: "p",
    })
    expect(
      code(await recurringScheduleUpdate(ctx as never, { id: SCHEDULE, status: "ended" } as never)),
    ).toBeUndefined()
    expect(stripeCalls()).toBe(0)
  })
})
