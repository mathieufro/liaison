// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `invoicing.monthEndClient` for /api/_test/seed: one subscription customer of
// an issuer, as the invoicing app leaves it after a first paid month: the paid
// invoice with its one line, and the active monthly schedule that continues
// from it. Through the seed engine's app-table writer and its recurring
// schedule rows, so a browser test never writes the tables itself.
import { withSystemDb } from "~/db/privileged"
import type { SeedContext } from "~/seed/context"
import { jsonCell, upsertAppRow } from "~/seed/factories/app-tables"
import { recurringScheduleRows } from "~/seed/factories/commerce/invoicing"
import { contact, contactAddress } from "~/seed/tiers/minimal"

export interface MonthEndClientInput {
  issuerId: string
  previousDocumentId: string
  scheduleKey: string
  name: string
  /** The billing address, field by field (a French address: country FR). */
  street: string
  postalCode: string
  city: string
  email: string
  priceMinor: number
  taxRateBp: number
  nextIssueOn: string
  nextDraftOn: string
  createdBy: string
}

export async function seedMonthEndClient(
  ctx: SeedContext,
  a: MonthEndClientInput,
): Promise<{ contactId: string; documentId: string; scheduleId: string }> {
  const contactId = await contact(ctx.orgId, a.email, { name: a.name })
  await contactAddress(ctx.orgId, contactId, {
    role: "billing",
    street1: a.street,
    postalCode: a.postalCode,
    city: a.city,
    countryIso2: "FR",
  })
  const tax = Math.round((a.priceMinor * a.taxRateBp) / 10000)
  const [schedule] = recurringScheduleRows(ctx, a.issuerId, [
    {
      key: a.scheduleKey,
      contactId,
      repeats: "month",
      billingDay: "last",
      status: "active",
      lines: [
        {
          description: "Team plan",
          qty: 1,
          unitPriceMinor: a.priceMinor,
          vatBp: a.taxRateBp,
        },
      ],
      nextIssueOn: a.nextIssueOn,
      nextDraftOn: a.nextDraftOn,
    },
  ])
  if (!schedule) throw new Error("month-end client: no schedule row")
  await withSystemDb("seed-month-end-client", async (tx) => {
    await upsertAppRow(tx, "invoicing", "documents", {
      id: a.previousDocumentId,
      org_id: ctx.orgId,
      type: "invoice",
      status: "issued",
      issuer_profile_id: a.issuerId,
      counterparty_contact_id: contactId,
      counterparty_name: a.name,
      counterparty_address: `${a.street}, ${a.postalCode} ${a.city}`,
      counterparty_country: "FR",
      customer_kind: "individual",
      counterparty_email: a.email,
      currency: "EUR",
      payment_status: "paid",
      external_refs: jsonCell({}),
      lifecycle_log: jsonCell([]),
    })
    await upsertAppRow(tx, "invoicing", "document_lines", {
      id: ctx.id("month_end_line", a.previousDocumentId),
      org_id: ctx.orgId,
      document_id: a.previousDocumentId,
      position: 1,
      description: "Team plan",
      quantity: 1,
      unit_price_minor: a.priceMinor,
      discount_minor: 0,
      line_kind: "service",
      tax_rate_bp: a.taxRateBp,
      subtotal_minor: a.priceMinor,
      tax_minor: tax,
      total_minor: a.priceMinor + tax,
    })
    await upsertAppRow(tx, "invoicing", "recurring_schedules", {
      ...schedule,
      last_document_id: a.previousDocumentId,
      created_by: a.createdBy,
    })
  })
  return { contactId, documentId: a.previousDocumentId, scheduleId: schedule.id }
}
