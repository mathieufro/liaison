// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The month-end draft job against the in-memory store: one unnumbered draft per due schedule, made
// from the schedule alone, keyed so a second run adds nothing, with flags read from the data.

import { describe, expect, test } from "bun:test"
import { CONTACT, harness, previousDoc, schedule } from "../__fixtures__/recurring-draft"
import { recurringDraftJob } from "./draft-job"

describe("the month-end draft job", () => {
  test("the job drafts one unnumbered draft per due schedule from the schedule alone and stores the period", async () => {
    const prev = previousDoc("44444444-4444-4444-8444-444444444441", true)
    const h = harness("2026-11-27", {
      schedules: [schedule("33333333-3333-4333-8333-333333333331", { last_document_id: prev.id })],
      docs: [prev],
    })
    const res = await recurringDraftJob(h.ctx)
    expect(res.drafted).toBe(1)
    expect(h.agentCalls).toBe(0)
    const drafts = h.db.__all("documents").filter((d) => d.status === "draft")
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({
      number: null,
      type: "invoice",
      external_ref: "recurring:33333333-3333-4333-8333-333333333331:2026-11",
      counterparty_name: "Maison Sauvan",
      due_at: "2026-12-30",
    })
    const lines = h.db.__all("document_lines").filter((l) => l.document_id === drafts[0]?.id)
    expect(lines).toEqual([
      expect.objectContaining({
        description: "Retainer November 2026",
        unit_price_minor: "150000",
        tax_rate_bp: 2000,
      }),
    ])
    const [item] = h.db.__all("recurring_run_items")
    expect(item).toMatchObject({
      period_key: "2026-11",
      period_start: "2026-11-01",
      period_end: "2026-11-30",
      document_id: drafts[0]?.id,
      state: "ready",
    })
    const [run] = h.db.__all("recurring_runs")
    expect(run).toMatchObject({
      issue_on: "2026-11-30",
      latest_issue_on: "2026-11-30",
      status: "drafted",
      approval_request_id: "approval-1",
    })
    // The schedule moved to its next period.
    expect(h.db.__all("recurring_schedules")[0]).toMatchObject({ next_issue_on: "2026-12-31" })
  })

  test("the draft is made out to the customer as its records read now, never copied from an earlier invoice", async () => {
    const prevId = "44444444-4444-4444-8444-444444444441"
    const prev = {
      ...previousDoc(prevId, true),
      counterparty_name: "Maison Brume SAS",
      counterparty_address: "Site Lyon, 12 quai Perrache, 69002 Lyon",
      counterparty_vat_id: "FR40123456789",
      counterparty_email: "achats@brume.example",
      customer_kind: "business",
    }
    const h = harness("2026-11-27", {
      schedules: [schedule("33333333-3333-4333-8333-333333333331", { last_document_id: prevId })],
      docs: [prev],
    })
    await recurringDraftJob(h.ctx)
    const [draft] = h.db.__all("documents").filter((d) => d.status === "draft")
    expect(draft).toMatchObject({
      counterparty_name: "Maison Sauvan",
      counterparty_address: "3 rue des Lilas, 69001 Lyon",
      counterparty_vat_id: null,
      counterparty_country: "FR",
      counterparty_email: "compta@sauvan.example",
    })
  })

  test("a contact's billing address added after a draft that needed a fix reaches the next month's draft, which is ready", async () => {
    const addresses: Array<Record<string, unknown>> = []
    const h = harness("2026-11-27", {
      kernel: { "kernel:contacts_addresses_list": () => ({ addresses }) },
    })
    await recurringDraftJob(h.ctx)
    const [first] = h.db.__all("recurring_run_items")
    expect(first).toMatchObject({ period_key: "2026-11", state: "needs_fix" })
    expect(String(first?.note)).toContain("No billing address")
    expect(h.db.__all("documents")[0]).toMatchObject({
      counterparty_address: null,
      status: "draft",
    })

    // The address is added to the contact; the November draft stays as it is, unissued.
    addresses.push({
      role: "billing",
      street1: "3 rue des Lilas",
      postalCode: "69001",
      city: "Lyon",
      countryIso2: "FR",
    })
    const nextDraftOn = String(h.db.__all("recurring_schedules")[0]?.next_draft_on)
    Object.assign(h.ctx, { time: harness(nextDraftOn).ctx.time })
    await recurringDraftJob(h.ctx)
    const december = h.db.__all("recurring_run_items").find((i) => i.period_key === "2026-12")
    expect(december).toMatchObject({ state: "ready" })
    const draft = h.db.__all("documents").find((d) => d.id === december?.document_id)
    expect(draft).toMatchObject({
      counterparty_name: "Maison Sauvan",
      counterparty_address: "3 rue des Lilas, 69001 Lyon",
      counterparty_country: "FR",
    })
    // Field by field too: an e-invoice's Factur-X and its gate read these, not the one-line address.
    expect(draft).toMatchObject({
      billing_line1: "3 rue des Lilas",
      billing_postcode: "69001",
      billing_city: "Lyon",
      billing_country_code: "FR",
    })
  })

  test("a company schedule with no previous invoice bills the company: its name, billing address and VAT number", async () => {
    const company = "66666666-6666-4666-8666-666666666661"
    const h = harness("2026-11-27", {
      schedules: [schedule("33333333-3333-4333-8333-333333333331", { company_id: company })],
      identities: [
        {
          id: "77777777-7777-4777-8777-777777777771",
          contact_id: CONTACT,
          customer_kind: "business",
          vat_id: "FR40123456789",
        },
      ],
      kernel: {
        "kernel:contacts_read": () => ({
          contact: {
            id: CONTACT,
            name: "Lucie Brume",
            email: "lucie@brume.example",
            companyId: company,
          },
        }),
        "kernel:companies_read": () => ({
          company: { id: company, name: "Maison Brume SAS" },
          people: [{ id: CONTACT, isMain: true }],
        }),
        "kernel:contacts_addresses_list": () => ({
          addresses: [
            {
              role: "delivery",
              street1: "1 rue du Dépôt",
              postalCode: "69007",
              city: "Lyon",
              countryIso2: "FR",
            },
            {
              role: "billing",
              street1: "12 quai Perrache",
              postalCode: "69002",
              city: "Lyon",
              countryIso2: "FR",
            },
          ],
        }),
      },
    })
    await recurringDraftJob(h.ctx)
    const [draft] = h.db.__all("documents").filter((d) => d.status === "draft")
    expect(draft).toMatchObject({
      counterparty_name: "Maison Brume SAS",
      counterparty_address: "12 quai Perrache, 69002 Lyon",
      counterparty_country: "FR",
      counterparty_vat_id: "FR40123456789",
      counterparty_email: "lucie@brume.example",
      customer_kind: "business",
    })
  })

  test("a schedule with no person bills its company and never borrows another customer's invoice", async () => {
    const company = "66666666-6666-4666-8666-666666666661"
    const unrelated = {
      ...previousDoc("44444444-4444-4444-8444-444444444449", true),
      counterparty_contact_id: null,
      counterparty_name: "Someone Else",
    }
    const asked: Array<Record<string, unknown>> = []
    const h = harness("2026-11-27", {
      schedules: [
        schedule("33333333-3333-4333-8333-333333333331", { company_id: company, contact_id: null }),
      ],
      docs: [unrelated],
      kernel: {
        "kernel:contacts_read": (p) => {
          asked.push(p)
          return { contact: {} }
        },
        "kernel:contacts_addresses_list": (p) => {
          asked.push(p)
          return { addresses: [] }
        },
        "kernel:companies_read": () => ({
          company: { id: company, name: "Maison Brume SAS" },
          people: [],
        }),
      },
    })
    await recurringDraftJob(h.ctx)
    const [draft] = h.db.__all("documents").filter((d) => d.status === "draft")
    expect(draft).toMatchObject({
      counterparty_name: "Maison Brume SAS",
      counterparty_contact_id: null,
      customer_kind: "business",
    })
    expect(asked).toEqual([])
  })

  test("a schedule with neither a person nor a company never borrows its last invoice's buyer and needs a fix", async () => {
    const prev = previousDoc("44444444-4444-4444-8444-444444444441", true)
    const h = harness("2026-11-27", {
      schedules: [
        schedule("33333333-3333-4333-8333-333333333331", {
          contact_id: null,
          last_document_id: prev.id,
        }),
      ],
      docs: [prev],
    })
    await recurringDraftJob(h.ctx)
    const [draft] = h.db.__all("documents").filter((d) => d.status === "draft")
    expect(draft).toMatchObject({ counterparty_name: null, counterparty_address: null })
    expect(h.db.__all("recurring_run_items")[0]).toMatchObject({ state: "needs_fix" })
  })

  test("a schedule whose draft day has not come drafts nothing", async () => {
    const h = harness("2026-11-26")
    expect((await recurringDraftJob(h.ctx)).drafted).toBe(0)
    expect(h.db.__all("documents")).toHaveLength(0)
  })

  test("running the job twice makes one run, one item per schedule, one draft each and one approval", async () => {
    const prev = previousDoc("44444444-4444-4444-8444-444444444441", true)
    const h = harness("2026-11-27", {
      schedules: [
        schedule("33333333-3333-4333-8333-333333333331", { last_document_id: prev.id }),
        schedule("33333333-3333-4333-8333-333333333332", { last_document_id: prev.id }),
      ],
      docs: [prev],
    })
    await recurringDraftJob(h.ctx)
    await recurringDraftJob(h.ctx)
    expect(h.db.__all("recurring_runs")).toHaveLength(1)
    expect(h.db.__all("recurring_run_items")).toHaveLength(2)
    expect(h.db.__all("documents").filter((d) => d.status === "draft")).toHaveLength(2)
    expect(h.approvals).toHaveLength(1)
    expect((h.approvals[0]!.current_payload as { items: unknown[] }).items).toHaveLength(2)
  })

  test("the flags come from the data with no model call", async () => {
    const same = previousDoc("44444444-4444-4444-8444-444444444441", false)
    const changed = previousDoc("44444444-4444-4444-8444-444444444442", true)
    const line = (doc: string, price: string) => ({
      id: `l-${doc}`,
      document_id: doc,
      position: 1,
      description: "Retainer November 2026",
      quantity: "1",
      unit_price_minor: price,
      tax_rate_bp: 2000,
      subtotal_minor: price,
    })
    const h = harness("2026-11-27", {
      schedules: [
        schedule("33333333-3333-4333-8333-333333333331", { last_document_id: same.id }),
        schedule("33333333-3333-4333-8333-333333333332", { last_document_id: changed.id }),
        schedule("33333333-3333-4333-8333-333333333333"),
      ],
      docs: [same, changed],
      lines: [line(String(same.id), "150000"), line(String(changed.id), "120000")],
      items: [
        {
          id: "i-prev-1",
          run_id: "r-old",
          schedule_id: "x1",
          period_key: "2026-10",
          period_start: "2026-10-01",
          period_end: "2026-10-31",
          document_id: same.id,
          position: 1,
          state: "issued",
        },
        {
          id: "i-prev-2",
          run_id: "r-old",
          schedule_id: "x2",
          period_key: "2026-10",
          period_start: "2026-10-01",
          period_end: "2026-10-31",
          document_id: changed.id,
          position: 2,
          state: "issued",
        },
      ],
    })
    await recurringDraftJob(h.ctx)
    expect(h.agentCalls).toBe(0)
    const notes = Object.fromEntries(
      h.db
        .__all("recurring_run_items")
        .filter((i) => i.period_key === "2026-11")
        .map((i) => [String(i.schedule_id).slice(-1), i.note]),
    )
    expect(notes["1"]).toBe("Same as October · October is still unpaid")
    expect(notes["2"]).toBe("Changed since October")
    expect(String(notes["3"])).toContain("First invoice")
  })
  test("the draft and its lines are written by one call of the atomic draft tool", async () => {
    const h = harness("2026-11-27")
    await recurringDraftJob(h.ctx)
    expect(h.draftWrites).toBe(1)
    expect(h.db.__all("document_lines")).toHaveLength(1)
  })

  test("a reused draft whose lines differ from its schedule needs a fix and is never ready", async () => {
    const id = "33333333-3333-4333-8333-333333333331"
    const ref = `recurring:${id}:2026-11`
    const partial: Record<string, unknown> = {
      ...previousDoc("55555555-5555-4555-8555-555555555551", false),
      status: "draft",
      number: null,
      external_ref: ref,
      external_refs: {},
    }
    const twoLines = [
      {
        description: "Retainer {period}",
        qty: 1,
        unit_price_minor: 150000,
        vat_bp: 2000,
        line_kind: "service",
      },
      {
        description: "Hosting {period}",
        qty: 2,
        unit_price_minor: 5000,
        vat_bp: 2000,
        line_kind: "service",
      },
    ]
    const h = harness("2026-11-27", {
      schedules: [schedule(id, { lines: twoLines, issue_mode: "auto" })],
      docs: [partial],
      // Only the first line was written before the job stopped.
      lines: [
        {
          id: "l-1",
          document_id: partial.id,
          position: 1,
          description: "Retainer November 2026",
          quantity: "1",
          unit_price_minor: "150000",
          tax_rate_bp: 2000,
          line_kind: "service",
          subtotal_minor: "150000",
        },
      ],
    })
    await recurringDraftJob(h.ctx)
    const [item] = h.db.__all("recurring_run_items")
    expect(item).toMatchObject({ document_id: partial.id, state: "needs_fix" })
    expect(String(item?.note)).toContain("Lines differ from the schedule")
    // Nothing was approved by itself.
    expect(h.db.__all("recurring_runs")[0]).toMatchObject({ status: "drafted" })
  })

  test("a reused draft whose lines match its schedule is ready", async () => {
    const id = "33333333-3333-4333-8333-333333333331"
    const ref = `recurring:${id}:2026-11`
    const whole: Record<string, unknown> = {
      ...previousDoc("55555555-5555-4555-8555-555555555552", false),
      status: "draft",
      number: null,
      external_ref: ref,
      external_refs: {},
    }
    const h = harness("2026-11-27", {
      docs: [whole],
      lines: [
        {
          id: "l-1",
          document_id: whole.id,
          position: 1,
          description: "Retainer November 2026",
          quantity: "1.000",
          unit_price_minor: "150000",
          tax_rate_bp: 2000,
          line_kind: "service",
          subtotal_minor: "150000",
        },
      ],
    })
    await recurringDraftJob(h.ctx)
    expect(h.db.__all("recurring_run_items")[0]).toMatchObject({
      document_id: whole.id,
      state: "ready",
    })
  })
})
