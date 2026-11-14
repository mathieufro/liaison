// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A card number in an inbound mail, a ticket message or a staff note is stored
// as bullets plus its last four digits, with a note on the message, before any
// person or agent reads it. A nearby security code becomes bullets too. A
// sealed mailbox stores no plaintext on the server, so its text is masked where
// the agent reads it instead: the mailbox context block of the turn.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { runAdminOp } from "~/apps/tickets/admin"
import { processInboundMessage } from "~/apps/tickets/inbound"
import { getTicket } from "~/apps/tickets/search"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { setPrivilegedContext, withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { ParsedEmail } from "~/lib/email/types"
import { fulfilMailboxMarker } from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-broker"
import {
  MailboxPlaintextRegistryTestAccess,
  resolveMailboxRequest,
} from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-registry"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { writeMailPage } from "~/modules/mail/page-write"
import { seedContext } from "~/seed/context"
import {
  ensureTicketMailboxAccount,
  ensureTicketMailboxInbox,
} from "~/seed/factories/support/inboxes"
import * as minimal from "~/seed/tiers/minimal"
import { asOrgMember } from "~/tests/helpers/org-caller"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { ensureMailAccount } from "../../../test-support/seed/mail"

// Luhn-valid numbers with real network prefixes, and full-length key shapes.
const MASTERCARD = "5555555555554444"
const AMEX = "378282246310005"
const VISA = "4917484589897107"
const LIVE_SECRET = `sk_live_${"51HxQzA9bC3dE4fG5hI6jK7lM8nO9pQ"}`
const TEST_RESTRICTED = `rk_test_${"51HxQzA9bC3dE4fG5hI6jKmN"}`
const ALL_SECRETS = [MASTERCARD, AMEX, VISA, LIVE_SECRET, TEST_RESTRICTED]

let orgId = ""
let staff: minimal.Person
let mailboxInbox: Record<string, unknown>
let n = 0

/** Whether any secret, written with or without separators, is in `value`. */
function leaks(value: unknown): string[] {
  const text = JSON.stringify(value)
  const digits = text.replace(/\D/g, "")
  return ALL_SECRETS.filter((s) => text.includes(s) || (/^\d+$/.test(s) && digits.includes(s)))
}

function mail(over: Partial<ParsedEmail> = {}): ParsedEmail {
  const id = ++n
  return {
    messageId: `<panmask-${id}-${orgId.slice(0, 8)}@customer.example>`,
    from: { email: "claire@customer.example", name: "Claire Martin" },
    to: [{ email: "desk@panmask.example" }],
    cc: [],
    subject: `Payment for order ${id}`,
    textBody: "hello",
    headers: {},
    sentAt: new Date().toISOString(),
    ...over,
  } as ParsedEmail
}

async function ingest(raw: ParsedEmail) {
  const inbox = { ...mailboxInbox, org_id: orgId }
  const result = await withPrivilegedDb(orgId, "pan-mask-inbound", (tx) =>
    processInboundMessage(raw, inbox as never, { db: tx, privilegedTx: tx, orgId } as never),
  )
  if ("error" in result) throw new Error(result.error.message)
  return result as unknown as { ticketId: string }
}

const admin = (op: string, params: Record<string, unknown>) =>
  asOrgMember(orgId, staff.id, (tx) =>
    runAdminOp(tx as never, orgId, op as never, params, { actorType: "user", userId: staff.id }),
  ) as Promise<Record<string, unknown>>

async function ticketMessages(ticketId: string) {
  return extractRows<{
    kind: string
    subject: string | null
    text_body: string | null
    html_body: string | null
    snippet: string | null
  }>(
    await db.execute(drizzleSql`
      SELECT kind, subject, text_body, html_body, snippet FROM app_tickets.messages
       WHERE org_id = ${orgId} AND ticket_id = ${ticketId} ORDER BY created_at`),
  )
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg({ name: "Card Mask Org" })).orgId
  await ensureAppsForOrg(orgId, {})
  staff = await minimal.person(orgId)
  await minimal.grantScope(staff.id, "tickets:inboxes:admin")
  const seed = seedContext({ orgId, now: new Date() })
  const inbox = await ensureTicketMailboxInbox(seed, {
    key: "panmask-desk",
    name: "Desk",
    emailAddress: "desk@panmask.example",
    connectedAccountId: await ensureTicketMailboxAccount(seed, {
      key: "panmask-desk",
      emailAddress: "desk@panmask.example",
      createdBy: staff.id,
    }),
  })
  const list = (await admin("inboxesList", {})) as unknown as Array<Record<string, unknown>>
  mailboxInbox = list.find((i) => i.id === inbox.id) as Record<string, unknown>
})

afterAll(async () => {
  await releaseTestLock()
})

describe("card numbers in mail and tickets are masked before storage", () => {
  it("an inbound mail and a ticket message store bullets and last 4 and carry a note, before any agent read", async () => {
    // Mail: an org mailbox (not sealed), one inbound message through the page writer.
    const box = await ensureMailAccount(seedContext({ orgId, now: new Date() }), {
      ownerType: "org",
      userId: staff.id,
      email: `billing-${orgId.slice(0, 8)}@panmask.example`,
      provider: "gmail",
    })
    const external = `<inbound-card-${orgId.slice(0, 8)}@customer.example>`
    await db.transaction(async (tx) => {
      await tx.execute(drizzleSql`SET LOCAL ROLE liaison_admin`)
      await setPrivilegedContext(tx as never, orgId)
      await writeMailPage(
        {
          tx: tx as never,
          schemaName: schemaRef("app_mail"),
          orgId,
          actorId: staff.id,
          queueEvents: async () => {},
        } as never,
        {
          accountId: box.accountId,
          origin: "incremental",
          messages: [
            {
              externalMessageId: external,
              externalProviderId: external,
              externalThreadId: external,
              from: { email: "claire@customer.example" },
              to: [box.email],
              cc: [],
              bcc: [],
              subject: `Card ${MASTERCARD}`,
              textBody: `Please use 5555 5555 5555 4444, CVV 123, exp 08/28.`,
              htmlBody: `<p>Please use <b>5555</b>&nbsp;5555 5555 <i>4444</i>, CVV 123</p>`,
              snippet: "Please use 5555 5555 5555 4444, CVV 123",
              isRead: false,
              isStarred: false,
              labels: ["INBOX"],
              direction: "inbound",
              sentAt: new Date().toISOString(),
              headers: {},
            },
          ],
        },
      )
    })
    const [row] = extractRows<Record<string, string | null>>(
      await db.execute(drizzleSql`
        SELECT subject, text_body, html_body, snippet FROM app_mail.messages
         WHERE org_id = ${orgId} AND external_message_id = ${external}`),
    )
    expect(row).toBeDefined()
    expect(leaks(row)).toEqual([])
    expect(row?.text_body).toBe(
      "Please use •••• •••• •••• 4444, CVV •••, exp 08/28.\n\n[A card number was hidden.]",
    )
    expect(row?.html_body).toContain("•••• •••• •••• 4444")
    expect(row?.html_body).toContain("[A card number was hidden.]")
    expect(row?.subject).toBe("Card •••• •••• •••• 4444")
    expect(row?.snippet).toContain("CVV •••")

    // Ticket: a new ticket from a customer's mail, then their reply on it.
    const first = await ingest(
      mail({
        subject: `Order with card ${AMEX}`,
        textBody: `My Amex is 3782 822463 10005 cvc 4421`,
      }),
    )
    const firstId = (await ticketMessages(first.ticketId))[0]
    expect(firstId).toBeDefined()
    const reply = mail({
      textBody: `Sorry, use this one: ${VISA} security code 737`,
      htmlBody: `<div>Sorry, use this one: ${VISA} security code 737</div>`,
    })
    const firstMessageId = (
      extractRows<{ external_message_id: string }>(
        await db.execute(drizzleSql`
          SELECT external_message_id FROM app_tickets.messages
           WHERE org_id = ${orgId} AND ticket_id = ${first.ticketId} LIMIT 1`),
      )[0] as { external_message_id: string }
    ).external_message_id
    await ingest({ ...reply, inReplyTo: firstMessageId, references: [firstMessageId] })

    const rows = await ticketMessages(first.ticketId)
    expect(rows.length).toBe(2)
    expect(leaks(rows)).toEqual([])
    expect(rows[0]?.text_body).toBe(
      "My Amex is •••• •••• •••• 0005 cvc •••\n\n[A card number was hidden.]",
    )
    expect(rows[1]?.text_body).toContain("•••• •••• •••• 7107 security code •••")
    expect(rows[1]?.text_body).toContain("[A card number was hidden.]")
    expect(rows[1]?.html_body).toContain("[A card number was hidden.]")
    const [ticket] = extractRows<{ subject: string }>(
      await db.execute(drizzleSql`
        SELECT subject FROM app_tickets.tickets WHERE id = ${first.ticketId}`),
    )
    expect(leaks(ticket)).toEqual([])

    // The agent's read of the ticket returns what is stored.
    const read = await asOrgMember(orgId, staff.id, (tx) =>
      getTicket(tx as never, orgId, { ticketId: first.ticketId }),
    )
    expect(leaks(read)).toEqual([])
    expect(JSON.stringify(read)).toContain("•••• •••• •••• 7107")
  }, 60_000)

  it("a sealed mailbox's message is masked at the agent plaintext layer", async () => {
    MailboxPlaintextRegistryTestAccess.reset()
    const userId = staff.id
    const contexts: string[] = []
    const emitted: Array<{ data: Record<string, unknown> }> = []
    const pending = fulfilMailboxMarker({
      result: {
        needsPlaintext: { requestKind: "mail.read", messageIds: ["m1"], purpose: "answer" },
        envelope: [{ messageId: "m1" }],
      },
      orgId,
      userId,
      threadId: crypto.randomUUID(),
      frame: {
        runId: "run-pan",
        rootRunId: "run-pan",
        mailboxTurnNonce: "nonce-pan",
      } as RunContext,
      deps: {
        getUnlock: async () => ({ unlocked: true, keyIds: [1], expiresAt: Date.now() + 60_000 }),
        emit: async (_action: string, data: Record<string, unknown>) => {
          emitted.push({ data })
        },
        injectContext: (_runId: string, block: string) => {
          contexts.push(block)
        },
      } as never,
    })
    await Bun.sleep(5)
    const requestId = String(emitted[0]?.data.requestId)
    expect(
      resolveMailboxRequest(requestId, {
        userId,
        turnNonce: "nonce-pan",
        response: {
          kind: "plaintext",
          items: [
            {
              messageId: "m1",
              subject: `Card ${MASTERCARD}`,
              textBody: `Here: 5555-5555-5555-4444 CVC 123 and the key ${LIVE_SECRET}`,
            },
          ],
          undecryptable: [],
        },
      }),
    ).toBe("resolved")
    const out = await pending
    expect(contexts.length).toBe(1)
    expect(leaks(contexts)).toEqual([])
    expect(leaks(out)).toEqual([])
    expect(contexts[0]).toContain("Here: •••• •••• •••• 4444 CVC ••• and the key sk_live_••••••••")
    expect(contexts[0]).toContain("[A card number and a key were hidden.]")
    expect(contexts[0]).toContain("Subject: Card •••• •••• •••• 4444")
  })

  it("a staff note and the agent's context are masked the same way", async () => {
    const { ticketId } = await ingest(mail({ textBody: "Where is my order?" }))
    const added = await admin("addNote", {
      ticketId,
      text: `Customer read their card on the phone: ${VISA}, CVV 123. Our key ${TEST_RESTRICTED}`,
    })
    const messageId = String(added.messageId)
    const note = (await ticketMessages(ticketId)).find((m) => m.kind === "note")
    expect(leaks(note)).toEqual([])
    expect(note?.text_body).toBe(
      "Customer read their card on the phone: •••• •••• •••• 7107, CVV •••. Our key rk_test_••••••••\n\n[A card number and a key were hidden.]",
    )

    // An edit of the note is masked as well.
    await admin("editNote", { ticketId, messageId, text: `corrected: ${MASTERCARD}` })
    const edited = (await ticketMessages(ticketId)).find((m) => m.kind === "note")
    expect(edited?.text_body).toBe("corrected: •••• •••• •••• 4444\n\n[A card number was hidden.]")

    // What the agent reads of the ticket, notes included.
    const read = await asOrgMember(orgId, staff.id, (tx) =>
      getTicket(tx as never, orgId, { ticketId }),
    )
    expect(leaks(read)).toEqual([])
    expect(JSON.stringify(read)).toContain("•••• •••• •••• 4444")

    // The events the note queued (fan-out, timeline, the agent's triggers).
    const events = extractRows<{ payload: unknown }>(
      await db.execute(drizzleSql`
        SELECT payload FROM kernel.pending_events
         WHERE org_id = ${orgId} AND payload->>'entityId' = ${messageId}`),
    )
    expect(leaks(events)).toEqual([])
  })
})
