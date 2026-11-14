// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `saas-sales-email`: the software world's sales scenario event. A hotel
// group's quote request lands in the company's shared mailbox and
// `mail:message:create` fires the way a sync would emit it, so the scenario's
// routine (an event routine on mail from this sender) runs on it. The sender's
// site is answered by the in-process fixture (`web-fixture.ts`), never the
// network.
//
// The message is written into the mailbox's tables directly (as the demo
// seeder writes its mail), because a demo mailbox is not bound to a real
// provider account the sync's page writer could resolve. Fixed content, one
// message per run of the scenario (stable ids keyed to the run): starting the
// scenario again delivers a new email, so the routine runs again.
import { SAAS_SALES_EMAIL_INJECTOR } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { WorldInjector } from "~/modules/demo/world/registry"
import { worldId, worldRunKey } from "~/seed/world/people"

/** The prospect: on a reserved domain, so a reply is a fixture delivery. */
export const SAAS_SALES_PROSPECT = {
  email: "helene.marchand@residence-olympe.example",
  name: "Hélène Marchand",
} as const

export const SAAS_SALES_SUBJECT = "Group pricing for our 11 hotels"

/** The plan the group asks about (the seeded Group plan). */
export const SAAS_SALES_PLAN = "Group"

const BODY =
  "Hello,\n\nI run operations at Résidence Olympe, a small group of 11 hotels on the " +
  `Atlantic coast. We are looking at moving our rotas to your ${SAAS_SALES_PLAN} plan: could ` +
  "you send us a quote for the 11 sites, with the rollout calendar and what a yearly " +
  "commitment changes?\n\nBest regards,\nHélène Marchand\nRésidence Olympe, 4 quai du " +
  "Port, 17000 La Rochelle, France\nresidence-olympe.example"

export const saasSalesEmailInjector: WorldInjector = {
  id: SAAS_SALES_EMAIL_INJECTOR,
  world: "saas",
  // The routine researches the sender: a routine run on the box key.
  spends: true,
  async injectWorldEvent({ orgId, ownerUserId, run }) {
    const conversationId = worldId(orgId, worldRunKey("saas-sales-email:conversation", run))
    const messageId = worldId(orgId, worldRunKey("saas-sales-email:message", run))
    await withPrivilegedDb(orgId, "demo-world-saas-sales-email", async (tx) => {
      const account = extractRows<{ id: string; email_address: string }>(
        await tx.execute(
          drizzleSql`SELECT id::text AS id, email_address FROM app_mail.accounts
            WHERE org_id = ${orgId}::uuid AND owner_type = 'org'
            ORDER BY created_at LIMIT 1`,
        ),
      )[0]
      if (!account) throw new Error("demo world: the shared mailbox is not seeded")
      const now = new Date().toISOString()
      const inserted = extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`INSERT INTO app_mail.conversations (
              id, org_id, account_id, owner_type, owner_id, external_thread_id,
              subject, snippet, from_email, status, labels, is_read, is_starred,
              last_message_at, message_count, created_at, updated_at
            ) VALUES (
              ${conversationId}::uuid, ${orgId}::uuid, ${account.id}::uuid, 'org', NULL,
              ${`demo-world-${conversationId}`}, ${SAAS_SALES_SUBJECT}, ${BODY.slice(0, 160)},
              ${SAAS_SALES_PROSPECT.email}, 'open', '["INBOX"]'::jsonb, false, false,
              ${now}, 1, ${now}, ${now}
            )
            ON CONFLICT (id) DO NOTHING
            RETURNING id::text AS id`,
        ),
      )
      if (!inserted[0]) return // already delivered on an earlier pass
      await tx.execute(
        drizzleSql`INSERT INTO app_mail.messages (
            id, org_id, conversation_id, account_id, external_message_id,
            message_references, from_address, to_addresses, cc_addresses, bcc_addresses,
            subject, text_body, html_body, snippet,
            is_read, is_starred, labels, direction, owner_type, owner_id,
            sent_at, synced_at, raw_headers, created_at, updated_at
          ) VALUES (
            ${messageId}::uuid, ${orgId}::uuid, ${conversationId}::uuid, ${account.id}::uuid,
            ${`demo-world-${messageId}`}, '[]'::jsonb,
            ${JSON.stringify({ name: SAAS_SALES_PROSPECT.name, email: SAAS_SALES_PROSPECT.email })}::jsonb,
            ${JSON.stringify([{ name: null, email: account.email_address }])}::jsonb,
            '[]'::jsonb, '[]'::jsonb,
            ${SAAS_SALES_SUBJECT}, ${BODY}, NULL, ${BODY.slice(0, 160)},
            false, false, '["INBOX"]'::jsonb, 'inbound', 'org', NULL,
            ${now}, ${now},
            ${JSON.stringify({ "message-id": `<${messageId}@residence-olympe.example>` })}::jsonb,
            ${now}, ${now}
          )`,
      )
      // What a sync emits for a new inbound message (page-write.ts messageEvent).
      await tx.queueEvent({
        app: "mail",
        entity: "message",
        action: "create",
        entityId: messageId,
        data: {
          id: messageId,
          conversationId,
          accountId: account.id,
          direction: "inbound",
          from: { name: SAAS_SALES_PROSPECT.name, email: SAAS_SALES_PROSPECT.email },
          origin: "incremental",
          senderAuth: "pass",
          labels: ["INBOX"],
          isRead: false,
          internalDate: Date.parse(now),
        },
        actorId: ownerUserId,
        actorType: "system",
        orgId,
      })
    })
  },
  // The prospect's conversation (a fixed id per org and run): the reply to approve is on it.
  async entityOf({ orgId, run }) {
    return worldId(orgId, worldRunKey("saas-sales-email:conversation", run))
  },
}
