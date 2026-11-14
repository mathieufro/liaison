// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The tickets factory: a ticket queue with its whole history, idempotent on
// each ticket's `externalRef`.
//
// Product services wherever one exists: `createTicket` (the service the
// sandbox bridge calls for `tickets__create`; it takes `createdAt`, `status`,
// `closedReason` and `externalRef`, so a weeks-old closed ticket goes in
// through the real path with its real SLA clock), the state machine
// (`validateAndApply`) for a snooze or a reopen, and `mergeTickets` for a
// merge pair.
//
// Privileged: the tickets app's services run on the privileged connection in
// the product too, with a system actor reference naming the org's admin.
// Raw SQL only for HISTORY the product produces over time and has no
// host-callable writer for: the later messages of a thread
// (`insertTicketMessageHistory`) and a customer's answered CSAT survey
// (`insertAnsweredCsat`).
import { sql } from "drizzle-orm"
import type { runAdminOp } from "~/apps/tickets/admin"
import { createTicket } from "~/apps/tickets/create"
import { mergeTickets } from "~/apps/tickets/merge"
import { ticketsRel } from "~/apps/tickets/schema-refs"
import { validateAndApply } from "~/apps/tickets/state-machine"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { HOUR_MS, seedClock } from "~/seed/clock"
import type { SeedContext } from "~/seed/context"
import { rowsOf, type SeedPerson } from "~/seed/factories/people/actors"

export type TicketMessageKind = "inbound" | "outbound" | "note"

export interface TicketFollowup {
  kind: TicketMessageKind
  /** Person key for an outbound reply or a note. Omitted means the customer. */
  author?: string
  /** Hours after the ticket was created. */
  hoursAfter: number
  body: string
}

export interface TicketSpec {
  key: string
  /** The ticket's fixed number (`ticket-<n>`), for a world whose story names its tickets. */
  number?: number
  subject: string
  /** Key of the contact the ticket comes from (the caller's contact map). */
  contactKey: string
  category: string
  team: string
  audience: "b2b" | "b2c"
  priority: "low" | "normal" | "high" | "urgent"
  status: "open" | "awaiting_customer" | "awaiting_followup" | "closed"
  closedReason?: "resolved" | "merged" | "spam" | "duplicate" | "no_response"
  /** Person key, or omitted for an unassigned ticket. */
  assignee?: string
  language?: string
  channel: "email" | "web_form" | "api" | "manual" | "social"
  createdHoursAgo: number
  body: string
  followups?: TicketFollowup[]
  /** Hours from the base time until the ticket wakes up. Only for awaiting_followup. */
  followupInHours?: number
  followupReason?: string
  csat?: { score: number; comment: string }
  /** Set on a ticket that was reopened after a close. */
  reopened?: boolean
}

export interface SeedTicketsInput {
  /** The admin the services act for (system actor reference). */
  adminUserId: string
  people: Record<string, SeedPerson | undefined>
  /** Who a ticket's contact key names (address and display name). */
  contactOf: (contactKey: string) => { email: string; name: string }
  /** Contact ids by contact key, where the contact exists. */
  contactIds: Record<string, string>
  categoryIds: Record<string, string>
  /** The inbox a ticket arrives in. */
  inboxIdOf: (spec: TicketSpec) => string | null
  /** The address the customers wrote to. */
  supportEmail: string
  specs: readonly TicketSpec[]
  /** A ticket's idempotency key (UNIQUE per org): a re-run adopts the ticket it names. */
  externalRefOf: (key: string) => string
  /** Merge pairs by ticket key: the source is merged into the target with the note. */
  merges?: ReadonlyArray<{ target: string; source: string; note: string }>
}

type ExecTx = { execute: (q: unknown) => Promise<unknown> }

/**
 * HISTORY: a later message of a ticket thread, appended the way `createTicket`
 * appends its own initial message (same columns, same counter and timestamp
 * update). No host-callable "append a message" service exists, and the one
 * tool that appends an outbound reply sends mail through a connected account.
 * The id is deterministic, so a re-run collides and does nothing.
 */
export async function insertTicketMessageHistory(
  tx: Parameters<typeof runAdminOp>[0],
  orgId: string,
  ticketId: string,
  messageId: string,
  msg: {
    kind: TicketMessageKind
    fromEmail: string | null
    fromName: string | null
    toEmails: string[]
    subject: string | null
    textBody: string
    /** The HTML part, when the message has one. */
    htmlBody?: string | null
    sentAt: Date
    createdBy: string | null
  },
): Promise<boolean> {
  const inserted = rowsOf<{ id: string }>(
    await (tx as ExecTx).execute(
      sql`INSERT INTO ${ticketsRel("messages")} (
            id, org_id, ticket_id, kind,
            from_email, from_name, to_emails, cc_emails,
            subject, html_body, text_body, snippet,
            external_message_id, in_reply_to, header_references,
            sent_at, received_at, created_by, created_at, updated_at
          ) VALUES (
            ${messageId}::uuid, ${orgId}::uuid, ${ticketId}::uuid, ${msg.kind},
            ${msg.fromEmail}, ${msg.fromName},
            ${JSON.stringify(msg.toEmails)}::jsonb, '[]'::jsonb,
            ${msg.subject}, ${msg.htmlBody ?? null}, ${msg.textBody}, ${msg.textBody.slice(0, 160)},
            NULL, NULL, '[]'::jsonb,
            ${msg.sentAt.toISOString()}, ${msg.sentAt.toISOString()}, ${msg.createdBy}::uuid,
            ${msg.sentAt.toISOString()}, ${msg.sentAt.toISOString()}
          )
          ON CONFLICT (id) DO NOTHING
          RETURNING id`,
    ),
  )
  if (inserted.length === 0) return false
  const touch =
    msg.kind === "inbound"
      ? sql`, last_inbound_at = GREATEST(coalesce(last_inbound_at, to_timestamp(0)), ${msg.sentAt.toISOString()}::timestamptz)`
      : msg.kind === "outbound"
        ? sql`, last_outbound_at = GREATEST(coalesce(last_outbound_at, to_timestamp(0)), ${msg.sentAt.toISOString()}::timestamptz)`
        : sql``
  await (tx as ExecTx).execute(
    sql`UPDATE ${ticketsRel("tickets")}
        SET message_count = message_count + 1,
            last_message_at = GREATEST(coalesce(last_message_at, to_timestamp(0)), ${msg.sentAt.toISOString()}::timestamptz)${touch}
        WHERE id = ${ticketId}::uuid`,
  )
  return true
}

/**
 * HISTORY: a customer's answered satisfaction survey. The only writer of a
 * RESPONDED csat row is the customer-facing survey webhook (unauthenticated,
 * token-driven), so this mirrors that webhook's own write.
 */
async function insertAnsweredCsat(
  tx: ExecTx,
  ctx: SeedContext,
  row: {
    key: string
    ticketId: string
    contactId: string | null
    score: number
    comment: string
    sentAt: Date
    respondedAt: Date
    createdBy: string
  },
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO ${sql.raw(schemaRef("app_tickets"))}.ticket_csat (
          id, org_id, ticket_id, contact_id, status, score, comment,
          survey_token, sent_at, responded_at, created_by, created_at
        ) VALUES (
          ${ctx.id("csat", row.key)}::uuid, ${ctx.orgId}::uuid, ${row.ticketId}::uuid,
          ${row.contactId}::uuid, 'responded',
          ${row.score}, ${row.comment},
          ${ctx.id("csat-token", row.key).replace(/-/g, "")},
          ${row.sentAt.toISOString()},
          ${row.respondedAt.toISOString()},
          ${row.createdBy}::uuid,
          ${row.sentAt.toISOString()}
        )
        ON CONFLICT (org_id, ticket_id) DO NOTHING`,
  )
}

/** Seed the queue in one privileged transaction. Ticket ids by spec key. */
export async function seedTickets(
  ctx: SeedContext,
  input: SeedTicketsInput,
): Promise<Record<string, string>> {
  const { orgId } = ctx
  const clock = seedClock(ctx.now)
  const adminRef = { actorType: "system" as const, userId: input.adminUserId }
  const byKey: Record<string, string> = {}

  await withPrivilegedDb(orgId, "seed-tickets:tickets", async (tx) => {
    for (const spec of input.specs) {
      const externalRef = input.externalRefOf(spec.key)
      const existing = rowsOf<{ id: string }>(
        await tx.execute(
          sql`SELECT id FROM ${sql.raw(schemaRef("app_tickets"))}.tickets
              WHERE org_id = ${orgId} AND external_ref = ${externalRef} LIMIT 1`,
        ),
      )
      const contact = input.contactOf(spec.contactKey)
      const createdAt = clock.hoursBefore(spec.createdHoursAgo)
      let ticketId: string

      if (existing[0]) {
        ticketId = existing[0].id
      } else {
        // A reopened ticket is genuinely closed first and then reopened through
        // the state machine, so its history reads the way a real one does.
        const initialStatus =
          spec.reopened || spec.status === "awaiting_followup" ? undefined : spec.status
        const created = await createTicket(
          tx as never,
          orgId,
          {
            subject: spec.subject,
            channel: spec.channel,
            priority: spec.priority,
            ...(spec.reopened
              ? { status: "closed" as const, closedReason: "resolved" as const }
              : initialStatus
                ? {
                    status: initialStatus,
                    ...(spec.closedReason ? { closedReason: spec.closedReason } : {}),
                  }
                : {}),
            createdAt: createdAt.toISOString(),
            team: spec.team,
            audience: spec.audience,
            ...(spec.language ? { language: spec.language } : {}),
            sensitivity: "internal",
            contactId: input.contactIds[spec.contactKey] ?? null,
            contactEmail: contact.email,
            contactName: contact.name,
            categoryId: input.categoryIds[spec.category] ?? null,
            assignedTo: spec.assignee ? (input.people[spec.assignee]?.userId ?? null) : null,
            sourceInboxId: input.inboxIdOf(spec),
            externalRef,
            initialMessage: {
              kind: "inbound",
              fromEmail: contact.email,
              fromName: contact.name,
              toEmails: [input.supportEmail],
              subject: spec.subject,
              textBody: spec.body,
              snippet: spec.body.slice(0, 160),
              sentAt: createdAt.toISOString(),
            },
          },
          adminRef,
          // Every read createTicket makes runs on this transaction. On a second
          // connection it would wait behind policy DDL that waits for this one.
          { privilegedTx: tx, ...(spec.number !== undefined ? { handleNumber: spec.number } : {}) },
        )
        if ("error" in created) {
          throw new Error(`tickets seed: ticket '${spec.key}' refused: ${created.error.message}`)
        }
        ticketId = created.ticketId
      }
      byKey[spec.key] = ticketId

      for (let i = 0; i < (spec.followups?.length ?? 0); i++) {
        const f = (spec.followups as TicketFollowup[])[i] as TicketFollowup
        const author = f.author ? input.people[f.author] : undefined
        await insertTicketMessageHistory(
          tx as never,
          orgId,
          ticketId,
          ctx.id("ticket-message", `${spec.key}:${i}`),
          {
            kind: f.kind,
            fromEmail: f.kind === "inbound" ? contact.email : (author?.email ?? null),
            fromName: f.kind === "inbound" ? contact.name : (author?.name ?? null),
            toEmails: f.kind === "outbound" ? [contact.email] : [],
            subject: f.kind === "note" ? null : `Re: ${spec.subject}`,
            textBody: f.body,
            sentAt: new Date(createdAt.getTime() + f.hoursAfter * HOUR_MS),
            createdBy: author?.userId ?? input.adminUserId,
          },
        )
      }

      // Snooze and reopen go through the real state machine so the followup
      // columns, the SLA clock and the audit trail all move together.
      if (spec.status === "awaiting_followup" && spec.followupInHours !== undefined) {
        const already = rowsOf<{ followup_at: string | null; db_now: string }>(
          await tx.execute(
            sql`SELECT followup_at, now() AS db_now FROM ${sql.raw(schemaRef("app_tickets"))}.tickets WHERE id = ${ticketId}::uuid`,
          ),
        )
        if (!already[0]?.followup_at) {
          // The state machine refuses a followup that is not in the future of
          // the REAL clock, not the seed's base time, so the snooze is placed
          // relative to whichever is later (the database's clock decides), and
          // the result is checked rather than assumed.
          const dbNow = new Date(already[0]?.db_now ?? ctx.now).getTime()
          const snoozeAt = new Date(
            Math.max(
              clock.hoursAfter(spec.followupInHours).getTime(),
              dbNow + spec.followupInHours * HOUR_MS,
            ),
          )
          const applied = await validateAndApply(
            tx as never,
            ticketId,
            {
              kind: "setFollowup",
              at: snoozeAt.toISOString(),
              reason: spec.followupReason ?? "Check back with the customer",
              trigger: "manual",
            },
            { ...adminRef, orgId },
            { privilegedTx: tx },
          )
          if (!applied.ok) {
            throw new Error(
              `tickets seed: snoozing '${spec.key}' refused: ${applied.code} ${applied.message}`,
            )
          }
        }
      }
      if (spec.reopened) {
        const row = rowsOf<{ status: string }>(
          await tx.execute(
            sql`SELECT status FROM ${sql.raw(schemaRef("app_tickets"))}.tickets WHERE id = ${ticketId}::uuid`,
          ),
        )
        if (row[0]?.status === "closed") {
          const reopened = await validateAndApply(
            tx as never,
            ticketId,
            { kind: "reopen" },
            { ...adminRef, orgId },
            { privilegedTx: tx },
          )
          if (!reopened.ok) {
            throw new Error(
              `tickets seed: reopening '${spec.key}' refused: ${reopened.code} ${reopened.message}`,
            )
          }
        }
      }

      if (spec.csat) {
        await insertAnsweredCsat(tx as ExecTx, ctx, {
          key: spec.key,
          ticketId,
          contactId: input.contactIds[spec.contactKey] ?? null,
          score: spec.csat.score,
          comment: spec.csat.comment,
          sentAt: clock.hoursBefore(spec.createdHoursAgo - 2),
          respondedAt: clock.hoursBefore(spec.createdHoursAgo - 20),
          createdBy: input.adminUserId,
        })
      }
    }

    for (const merge of input.merges ?? []) {
      const target = byKey[merge.target]
      const source = byKey[merge.source]
      if (!target || !source) continue
      const sourceRow = rowsOf<{ merged_into_ticket_id: string | null }>(
        await tx.execute(
          sql`SELECT merged_into_ticket_id FROM ${sql.raw(schemaRef("app_tickets"))}.tickets WHERE id = ${source}::uuid`,
        ),
      )
      if (sourceRow[0]?.merged_into_ticket_id) continue
      await mergeTickets(
        tx as never,
        orgId,
        { targetTicketId: target, sourceTicketIds: [source], note: merge.note },
        adminRef,
        { privilegedTx: tx },
      )
    }

    // A seeded message came in when the story says it did, not when the seed
    // ran: the ticket service stamps its first message received now, and a
    // follow-up's send check reads a message received after it was staged as
    // a late-arriving reply.
    const ids = Object.values(byKey)
    if (ids.length > 0) {
      await tx.execute(
        sql`UPDATE ${ticketsRel("messages")} SET received_at = sent_at
            WHERE org_id = ${orgId}::uuid AND ticket_id = ANY(${`{${ids.join(",")}}`}::uuid[])
              AND sent_at IS NOT NULL AND received_at > sent_at`,
      )
    }
  })

  return byKey
}

/** Ticket ids by external reference, for the references that exist in the org. */
export async function ticketIdsByExternalRef(
  ctx: SeedContext,
  refs: readonly string[],
): Promise<Map<string, string>> {
  if (refs.length === 0) return new Map()
  const rows = await withPrivilegedDb(ctx.orgId, "seed-tickets:by-ref", async (tx) =>
    rowsOf<{ id: string; external_ref: string }>(
      await tx.execute(
        sql`SELECT id, external_ref FROM ${sql.raw(schemaRef("app_tickets"))}.tickets WHERE org_id = ${ctx.orgId}::uuid
            AND external_ref IN (${sql.join(
              refs.map((r) => sql`${r}`),
              sql`, `,
            )})`,
      ),
    ),
  )
  return new Map(rows.map((r) => [r.external_ref, r.id]))
}
