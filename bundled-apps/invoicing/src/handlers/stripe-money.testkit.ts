// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared fixtures for the card-payments-on-Stripe tests: an issuer in Paris whose card stream is
// issued by Liaison since a fixed connection instant, a Stripe invoice payload, and the ctx.
import { ISSUER_ROW, issuePipelineCtx } from "../__tests__/credit-note-fixtures"
import { createMockDb, type MockDb } from "../test-db"
import type { StripeCtx, StripeInvoicePayload } from "./stripe-invoice-finalized"

export const CONNECTED_AT = new Date(Date.UTC(2026, 10, 1, 9, 0)).toISOString()
export const CONTACT = "00000000-0000-4000-8000-00000000c001"

export function stripeDb(
  issuer: "liaison" | "stripe" | "undecided" = "liaison",
  over: Record<string, unknown> = {},
): MockDb {
  return createMockDb({
    bridgeWhereOperators: true,
    seed: {
      issuer_profiles: [{ ...ISSUER_ROW, timezone: "Europe/Paris", ...over }],
      stripe_streams: [
        {
          id: "st-1",
          issuer_profile_id: ISSUER_ROW.id,
          issuer,
          stripe_connected: true,
          created_at: CONNECTED_AT,
        },
      ],
    },
  })
}

export interface Emitted {
  entity: string
  action: string
  entityId?: string
  data?: unknown
}

export function stripeCtx(
  db: MockDb,
  extra: Partial<StripeCtx> = {},
): StripeCtx & { emitted: Emitted[]; calls: Array<{ tool: string; params: unknown }> } {
  const emitted: Emitted[] = []
  const calls: Array<{ tool: string; params: unknown }> = []
  const base = issuePipelineCtx(db)
  return {
    ...base,
    db: db as unknown as StripeCtx["db"],
    approval: null,
    decideApproval: async () => ({ status: "ok" }),
    emit: async (e: Emitted) => {
      emitted.push(e)
    },
    executeTool: (async (tool: string, params: unknown) => {
      calls.push({ tool, params })
      return { status: "error", error: { code: "tool_not_found", message: "absent" } }
    }) as StripeCtx["executeTool"],
    resolveContact: async () => ({ id: CONTACT }),
    emitted,
    calls,
    ...extra,
  } as StripeCtx & { emitted: Emitted[]; calls: Array<{ tool: string; params: unknown }> }
}

/** A finalized Stripe invoice: one line of 100.00 before 20% VAT, so 120.00 in all. */
export function finalized(over: Partial<StripeInvoicePayload> = {}): StripeInvoicePayload {
  return {
    stripe_invoice_id: "in_1",
    customer_id: "cus_1",
    subscription_id: "sub_1",
    number: "ST-0001",
    status: "open",
    total_minor: "12000",
    tax_minor: "2000",
    currency: "eur",
    period_start: "2026-11-01",
    period_end: "2026-11-30",
    finalized_at: new Date(Date.UTC(2026, 10, 15, 10, 0)).toISOString(),
    billing_reason: "subscription_cycle",
    customer: {
      name: "Lumen Studio",
      email: "billing@lumen.example",
      country: "FR",
      address: "3 rue Neuve, 69001 Lyon",
    },
    lines: [
      {
        description: "Pro plan",
        quantity: 1,
        unit_amount_excl_minor: "10000",
        tax_rate_bp: 2000,
        tax_minor: "2000",
        period_start: "2026-11-01",
        period_end: "2026-11-30",
      },
    ],
    ...over,
  }
}

export const invoices = (db: MockDb) => db.__all("documents").filter((d) => d.type === "invoice")
export const creditNotes = (db: MockDb) =>
  db.__all("documents").filter((d) => d.type === "credit_note")
export const parks = (db: MockDb) => db.__all("deferred_events")
