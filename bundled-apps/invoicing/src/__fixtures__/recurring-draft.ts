// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Schedules, earlier documents and the in-memory harness shared by the month-end draft job
// tests (recurring/draft-job.test.ts, run-card.test.ts, amount-check.test.ts).
import { recurringDraftWrite } from "../recurring/draft-job"
import type { RunCtx } from "../recurring/run-card"
import { weekdayOf } from "../recurring/schedule"
import { createMockDb, type MockDb } from "../test-db"

export const ISSUER = "11111111-1111-4111-8111-111111111111"
export const CONTACT = "22222222-2222-4222-8222-222222222222"

export function schedule(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    issuer_profile_id: ISSUER,
    contact_id: CONTACT,
    status: "active",
    repeats: "month",
    billing_day: "last",
    issue_mode: "review",
    due_rule: "days_30",
    lines: [
      {
        description: "Retainer {period}",
        qty: 1,
        unit_price_minor: 150000,
        vat_bp: 2000,
        line_kind: "service",
      },
    ],
    next_issue_on: "2026-11-30",
    next_draft_on: "2026-11-27",
    version: 1,
    created_by: "user-am",
    ...over,
  }
}

export function previousDoc(id: string, paid: boolean): Record<string, unknown> {
  return {
    id,
    type: "invoice",
    status: "issued",
    number: "F-2026-0040",
    counterparty_contact_id: CONTACT,
    counterparty_name: "Maison Sauvan",
    counterparty_address: "3 rue des Lilas, 69001 Lyon",
    counterparty_email: "compta@sauvan.example",
    counterparty_country: "FR",
    issuer_profile_id: ISSUER,
    currency: "EUR",
    payment_status: paid ? "paid" : "unpaid",
    external_refs: {},
  }
}

/** The contact's own records, as the kernel reads them: who a draft is made out to. */
const CONTACT_RECORDS: Record<string, (params: Record<string, unknown>) => unknown> = {
  "kernel:contacts_read": () => ({
    contact: { id: CONTACT, name: "Maison Sauvan", email: "compta@sauvan.example" },
  }),
  "kernel:contacts_addresses_list": () => ({
    addresses: [
      {
        role: "billing",
        street1: "3 rue des Lilas",
        postalCode: "69001",
        city: "Lyon",
        countryIso2: "FR",
      },
    ],
  }),
}

export interface Harness {
  ctx: RunCtx
  db: MockDb
  approvals: Array<Record<string, unknown>>
  /** Approvals a person decided: the kernel no longer restages them. */
  decided: Set<string>
  restaged: Array<Record<string, unknown>>
  /** The card text each restage carried (its 4th argument), in order. */
  agentCalls: number
  draftWrites: number
}

export function harness(
  today: string,
  opts: {
    schedules?: Array<Record<string, unknown>>
    docs?: Array<Record<string, unknown>>
    lines?: Array<Record<string, unknown>>
    items?: Array<Record<string, unknown>>
    identities?: Array<Record<string, unknown>>
    threshold?: number | null
    hour?: number
    kernel?: Record<string, (params: Record<string, unknown>) => unknown>
  } = {},
): Harness {
  const db = createMockDb({
    bridgeWhereOperators: true,
    seed: {
      issuer_profiles: [
        {
          id: ISSUER,
          legal_name: "Maison Nord SARL",
          country: "FR",
          default_currency: "EUR",
          timezone: "Europe/Paris",
          invoice_approval_threshold_minor:
            opts.threshold === undefined
              ? null
              : opts.threshold === null
                ? null
                : String(opts.threshold),
        },
      ],
      recurring_schedules: opts.schedules ?? [schedule("33333333-3333-4333-8333-333333333331")],
      ...(opts.docs ? { documents: opts.docs } : {}),
      ...(opts.lines ? { document_lines: opts.lines } : {}),
      ...(opts.items ? { recurring_run_items: opts.items } : {}),
      ...(opts.identities ? { counterparty_identities: opts.identities } : {}),
    },
  })
  const h: Harness = {
    ctx: null as never,
    db,
    approvals: [],
    restaged: [],
    decided: new Set(),
    agentCalls: 0,
    draftWrites: 0,
  }
  let n = 0
  h.ctx = {
    db: db as never,
    getUserId: async () => "user-person",
    approval: null,
    time: {
      async civil({ timezone }: { timezone: string }) {
        const [y, m, d] = today.split("-").map(Number) as [number, number, number]
        return {
          date: today,
          year: y,
          month: m,
          day: d,
          hour: opts.hour ?? 9,
          minute: 0,
          weekday: weekdayOf(today),
          zone: timezone,
        }
      },
    },
    requestApproval: async (input: Record<string, unknown>) => {
      h.approvals.push(input)
      n += 1
      return { approval_id: `approval-${n}` }
    },
    approvals: {
      restagePayload: async (id: string, fields: Record<string, unknown>, _note?: string) => {
        // A decided approval is no longer rewritten: a change after it needs a new card.
        if (h.decided.has(id)) return { ok: false, code: "not_pending", message: "decided" }
        h.restaged.push({ id, ...fields })
        return { ok: true, approval_id: id, payload_hash: "h", changed: true }
      },
    },
    // A stub agent: any model or agent call made while drafting is counted and fails the test.
    executeTool: async (target: string, params: Record<string, unknown>) => {
      if (target.startsWith("kernel:agents") || target.includes("agent")) h.agentCalls += 1
      if (target === "invoicing:recurring_draft_write") {
        h.draftWrites += 1
        return { status: "completed", result: await recurringDraftWrite(h.ctx, params as never) }
      }
      const kernel = opts.kernel?.[target] ?? CONTACT_RECORDS[target]
      if (kernel) return { status: "completed", result: kernel(params) }
      // No Stripe app here: the kernel answers an absent app's tool as not found.
      if (target.startsWith("stripe:"))
        return {
          status: "error",
          error: { code: "tool_not_found", message: `tool ${target} not registered` },
        }
      return { status: "error", error: { code: "unavailable", message: "no tool in this test" } }
    },
    emit: async () => {},
  } as unknown as RunCtx
  return h
}
