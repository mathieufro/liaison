// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `customer_link`: which Liaison company and contact a Stripe customer is.
// It writes Liaison's mirror row only and never calls Stripe. A person links
// only records they can read: the company and the contact are read first
// through the kernel's own reads, as the caller, and a record they cannot see
// refuses the link. Every link keeps the one it replaced (`previous_link`), so
// `undo: true` puts it back.
import { refuseTool } from "@liaison/app-sdk/errors"
import { customerItem, type ReadCtx, UUID } from "./read-common"
import { cardNumberRefusal } from "./refunds"

type Obj = Record<string, unknown>

export interface LinkDb {
  findMany(
    entity: string,
    opts?: { where?: Record<string, unknown>; limit?: number },
  ): Promise<unknown[]>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
}

export interface LinkCtx extends Pick<ReadCtx, "executeTool"> {
  db: LinkDb
  userId: string
}

const LINK_FIELDS = ["company_id", "contact_id", "match_method", "match_by"] as const

/** Whether the caller can read this kernel record, through the kernel's own read. */
async function canRead(
  ctx: LinkCtx,
  tool: "kernel:companies_read" | "kernel:contacts_read",
  params: Obj,
) {
  if (!ctx.executeTool) return false
  try {
    return (await ctx.executeTool(tool, params)).status === "completed"
  } catch {
    return false
  }
}

export async function customerLink(params: Obj | undefined, ctx: LinkCtx) {
  const p = params ?? {}
  for (const [field, value] of Object.entries(p)) {
    const refused = cardNumberRefusal(field, value)
    if (refused) return refused
  }
  const stripeId = typeof p.stripeCustomerId === "string" ? p.stripeCustomerId.trim() : ""
  if (!stripeId) {
    return refuseTool(
      "customer_ref_missing",
      "No Stripe customer was named, so nothing was linked. Next step: pass stripeCustomerId.",
    )
  }
  const row = (
    (await ctx.db.findMany("stripe_customers", {
      where: { stripe_id: stripeId },
      limit: 1,
    })) as Obj[]
  )[0]
  if (!row) {
    return refuseTool(
      "customer_not_found",
      `No Stripe customer ${stripeId} is in the mirror, so nothing was linked. Next step: find it with customers_search.`,
    )
  }
  const before: Obj = Object.fromEntries(LINK_FIELDS.map((k) => [k, row[k] ?? null]))
  let data: Obj
  let what: string
  if (p.undo === true) {
    const prev = row.previous_link as Obj | null | undefined
    if (!prev || typeof prev !== "object") {
      return refuseTool(
        "nothing_to_undo",
        `Stripe customer ${stripeId} has no earlier link to restore, so nothing changed.`,
      )
    }
    data = {
      ...Object.fromEntries(LINK_FIELDS.map((k) => [k, prev[k] ?? null])),
      previous_link: null,
    }
    what = "restored its previous link"
  } else if (p.unlink === true) {
    data = {
      company_id: null,
      contact_id: null,
      match_method: null,
      match_by: null,
      previous_link: before,
    }
    what = "unlinked it"
  } else {
    const companyId = typeof p.companyId === "string" ? p.companyId : null
    const contactId = typeof p.contactId === "string" ? p.contactId : null
    if (!companyId && !contactId) {
      return refuseTool(
        "link_target_missing",
        "No company or contact was named, so nothing was linked. Next step: pass companyId, contactId, or both.",
      )
    }
    for (const [id, tool, label] of [
      [companyId, "kernel:companies_read", "company"],
      [contactId, "kernel:contacts_read", "contact"],
    ] as const) {
      if (id === null) continue
      const ok =
        UUID.test(id) &&
        (await canRead(
          ctx,
          tool,
          tool === "kernel:companies_read" ? { companyId: id } : { contactId: id },
        ))
      if (!ok) {
        return refuseTool(
          "link_target_not_visible",
          `You cannot read that ${label} (${id}), so nothing was linked. Next step: link a ${label} you can open, or ask its owner to share it.`,
        )
      }
    }
    data = {
      company_id: companyId ?? row.company_id ?? null,
      contact_id: contactId ?? row.contact_id ?? null,
      match_method: "person",
      match_by: UUID.test(ctx.userId) ? ctx.userId : null,
      previous_link: before,
    }
    what = `linked it to ${[companyId && `company ${companyId}`, contactId && `contact ${contactId}`].filter(Boolean).join(" and ")}`
  }
  await ctx.db.update("stripe_customers", String(row.id), data)
  const after = { ...row, ...data }
  return {
    customer: customerItem(after),
    previous: { companyId: before.company_id ?? null, contactId: before.contact_id ?? null },
    stripeChanged: false,
    summary: `Stripe customer ${stripeId}: ${what} in Liaison only; nothing changed in Stripe.${p.undo === true ? "" : " To undo, call customer_link with undo: true."}`,
  }
}
