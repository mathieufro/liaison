// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `saas-support-ticket`: the software world's support scenario event. A
// fictional customer's email arrives in the seeded Support inbox as a new
// ticket (the same `createTicket` path the inbound channels take), which fires
// `tickets:ticket:create`: the scenario's routine reads it, leaves an internal
// note and drafts the reply. Fixed content, one ticket per run (its external
// ref, keyed to the run, is the idempotency key).
import { SAAS_SUPPORT_TICKET_INJECTOR } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { createTicket } from "~/apps/tickets/create"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { WorldInjector } from "~/modules/demo/world/registry"
import { worldRunKey } from "~/seed/world/people"

/** The customer: on a reserved domain, so the reply is a fixture delivery. */
export const SAAS_SUPPORT_CUSTOMER = {
  email: "julie@tables-vauban.example",
  name: "Julie Ferran",
} as const

export const SAAS_SUPPORT_SUBJECT = "Shift swap notifications stopped after the update"
export const SAAS_SUPPORT_EXTERNAL_REF = "demo:world:saas-support-ticket"

/** The ticket's external ref in run `run` of the scenario. */
export function saasSupportExternalRef(run: number): string {
  return worldRunKey(SAAS_SUPPORT_EXTERNAL_REF, run)
}

const BODY =
  "Hello,\n\nSince the update on Monday our staff no longer get a notification when a shift " +
  "swap is approved. The swap shows as approved in the app, but nobody is told, and two " +
  "waiters turned up on the wrong day. It worked fine before the update. We are on the Team " +
  "plan, three venues.\n\nCan you help? We plan next week's rota on Thursday.\n\nThanks,\nJulie"

export const saasSupportTicketInjector: WorldInjector = {
  id: SAAS_SUPPORT_TICKET_INJECTOR,
  world: "saas",
  // The support routine drafts a reply: an agent turn on the box key.
  spends: true,
  async injectWorldEvent({ orgId, ownerUserId, run }) {
    const externalRef = saasSupportExternalRef(run)
    await withPrivilegedDb(orgId, "demo-world-saas-support-ticket", async (tx) => {
      const existing = extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`SELECT id FROM app_tickets.tickets
            WHERE org_id = ${orgId} AND external_ref = ${externalRef} LIMIT 1`,
        ),
      )
      if (existing[0]) return
      const inbox = extractRows<{ id: string; reply_from_email: string | null }>(
        await tx.execute(
          drizzleSql`SELECT id, reply_from_email FROM app_tickets.inboxes
            WHERE org_id = ${orgId} AND name = 'Support' AND archived_at IS NULL LIMIT 1`,
        ),
      )[0]
      if (!inbox) throw new Error("demo world: the Support inbox is not seeded")
      const now = new Date().toISOString()
      const created = await createTicket(
        tx,
        orgId,
        {
          subject: SAAS_SUPPORT_SUBJECT,
          channel: "email",
          priority: "normal",
          team: "support",
          audience: "b2b",
          sensitivity: "internal",
          contactEmail: SAAS_SUPPORT_CUSTOMER.email,
          contactName: SAAS_SUPPORT_CUSTOMER.name,
          sourceInboxId: inbox.id,
          externalRef,
          initialMessage: {
            kind: "inbound",
            fromEmail: SAAS_SUPPORT_CUSTOMER.email,
            fromName: SAAS_SUPPORT_CUSTOMER.name,
            toEmails: inbox.reply_from_email ? [inbox.reply_from_email] : [],
            subject: SAAS_SUPPORT_SUBJECT,
            textBody: BODY,
            snippet: BODY.slice(0, 160),
            sentAt: now,
          },
        },
        { actorType: "system", userId: ownerUserId },
        // Its reads run on this transaction, never on a second connection.
        { privilegedTx: tx },
      )
      if ("error" in created)
        throw new Error(`demo world: ticket refused: ${created.error.message}`)
    })
  },
  async entityOf({ orgId, run }) {
    return withPrivilegedDb(orgId, "demo-world-saas-support-ticket-read", async (tx) => {
      const row = extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`SELECT id::text AS id FROM app_tickets.tickets
            WHERE org_id = ${orgId} AND external_ref = ${saasSupportExternalRef(run)} LIMIT 1`,
        ),
      )[0]
      return row?.id ?? null
    })
  },
}
