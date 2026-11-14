// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mail factory: mailboxes with their conversations and messages, stored
// as PLAINTEXT on UNARMED mailboxes.
//
// THE MAILBOX ENCRYPTION INVARIANT. `enforce_mailbox_plaintext_invariant`
// refuses a plaintext `subject`, `text_body`, `html_body` or `snippet` on a
// mailbox that is ARMED, and armed is not a flag a seed chooses:
// `app_mail.mailbox_invariant_armed(acct)` is "owner_type = 'user' AND that
// owner has an ACTIVE row in the user mailbox identities". A shared, org-owned
// mailbox can never arm, and a personal one arms only once its owner enrols a
// key IN A BROWSER (the private half lives in that browser; no server-side
// path can mint one). A seed that forged an identity would write ciphertext
// nobody could open. So these mailboxes are unarmed and store plaintext, the
// trigger's own supported branch, not a workaround: nothing is disabled, no
// key is faked, and the invariant is fully armed the moment a person enrols
// one of these accounts. It is also the only posture under which seeded mail
// is READABLE (`agentMailSearch` serves an unarmed mailbox from those columns).
//
// Raw SQL, privileged, category UNARMED PLAINTEXT MAIL (`insertUnarmedMail`):
// `app_mail` has no host-callable write service (the real writer runs inside
// the sandbox behind the gmail and imap sync handlers), so the rows go in the
// way those handlers write them, with deterministic ids so a re-run is a no-op.
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { seedClock } from "~/seed/clock"
import type { SeedContext } from "~/seed/context"
import { rowsOf } from "~/seed/factories/people/actors"

export interface MailMessageSpec {
  direction: "inbound" | "outbound"
  fromName: string
  fromEmail: string
  toName: string
  toEmail: string
  hoursAgo: number
  body: string
  /** Headers the message arrived with beyond its id, such as an auto-reply's `auto-submitted`. */
  headers?: Record<string, string>
}

export interface MailConversationSpec {
  key: string
  /** `org` for the shared mailbox, or a person key for a personal one. */
  box: string
  subject: string
  status: string
  labels: string[]
  isRead: boolean
  isStarred: boolean
  messages: MailMessageSpec[]
}

/** A mailbox: the org's shared one (`ownerUserId` null) or a person's. */
export interface MailboxSeed {
  box: string
  ownerUserId: string | null
  email: string
  displayName: string
}

/**
 * UNARMED PLAINTEXT MAIL: write the mailboxes, then each conversation and its
 * messages, in one privileged transaction. `domain` names the message ids.
 */
export async function insertUnarmedMail(
  ctx: SeedContext,
  input: {
    domain: string
    mailboxes: readonly MailboxSeed[]
    conversations: readonly MailConversationSpec[]
  },
): Promise<{ accountIds: string[]; conversationIds: string[] }> {
  const { orgId } = ctx
  const clock = seedClock(ctx.now)
  const accountIds: string[] = []
  const conversationIds: string[] = []

  await withPrivilegedDb(orgId, "seed-mail", async (tx) => {
    const accountByBox: Record<string, string> = {}
    const ownerByBox: Record<string, string | null> = {}
    for (const box of input.mailboxes) {
      const isOrg = box.ownerUserId === null
      const seededId = ctx.id("mail-account", box.box)
      // A personal mailbox starts awaiting its owner's mailbox password
      // (encryption_state pending_enrollment): it has never synced, so it
      // carries no last sync. Only an org mailbox has fetched mail.
      const lastSyncAt = isOrg ? clock.hoursBefore(0.1).toISOString() : null
      await tx.execute(
        sql`INSERT INTO ${sql.raw(schemaRef("app_mail"))}.accounts (
              id, org_id, connected_account_id, owner_type, owner_id, provider,
              email_address, display_name, sync_status, last_sync_at, created_at, updated_at
            ) VALUES (
              ${seededId}::uuid, ${orgId}::uuid,
              ${ctx.id("mail-connection", box.box)}::uuid,
              ${isOrg ? "org" : "user"}, ${box.ownerUserId}::uuid,
              'imap', ${box.email}, ${box.displayName},
              'idle', ${lastSyncAt},
              ${clock.daysBefore(60).toISOString()}, ${clock.hoursBefore(0.1).toISOString()}
            )
            ON CONFLICT DO NOTHING`,
      )
      // An org that already holds this address (a world seeded before this
      // tier, an earlier run) keeps its mailbox: the conversations join it.
      const existing = rowsOf<{ id: string }>(
        await tx.execute(
          sql`SELECT id FROM ${sql.raw(schemaRef("app_mail"))}.accounts
              WHERE org_id = ${orgId}::uuid AND email_address = ${box.email} LIMIT 1`,
        ),
      )
      const accountId = existing[0]?.id ?? seededId
      accountByBox[box.box] = accountId
      ownerByBox[box.box] = box.ownerUserId
      accountIds.push(accountId)
    }

    for (const conv of input.conversations) {
      const accountId = accountByBox[conv.box] as string
      const ownerId = ownerByBox[conv.box] ?? null
      const ownerType = ownerId === null ? "org" : "user"
      const conversationId = ctx.id("mail-conversation", conv.key)
      const last = conv.messages[conv.messages.length - 1] as MailMessageSpec
      const lastAt = clock.hoursBefore(last.hoursAgo)
      const first = conv.messages[0] as MailMessageSpec

      await tx.execute(
        sql`INSERT INTO ${sql.raw(schemaRef("app_mail"))}.conversations (
              id, org_id, account_id, owner_type, owner_id, external_thread_id,
              subject, snippet, from_email, status, labels, is_read, is_starred,
              last_message_at, message_count, created_at, updated_at
            ) VALUES (
              ${conversationId}::uuid, ${orgId}::uuid, ${accountId}::uuid,
              ${ownerType}, ${ownerId}::uuid,
              ${`demo-thread-${conv.key}`},
              ${conv.subject}, ${last.body.slice(0, 160)}, ${first.fromEmail},
              ${conv.status}, ${JSON.stringify(conv.labels)}::jsonb,
              ${conv.isRead}, ${conv.isStarred},
              ${lastAt.toISOString()}, ${conv.messages.length},
              ${clock.hoursBefore(first.hoursAgo).toISOString()}, ${lastAt.toISOString()}
            )
            ON CONFLICT (id) DO NOTHING`,
      )
      conversationIds.push(conversationId)

      for (let i = 0; i < conv.messages.length; i++) {
        const m = conv.messages[i] as MailMessageSpec
        const sentAt = clock.hoursBefore(m.hoursAgo)
        await tx.execute(
          sql`INSERT INTO ${sql.raw(schemaRef("app_mail"))}.messages (
                id, org_id, conversation_id, account_id, external_message_id,
                message_references, from_address, to_addresses, cc_addresses, bcc_addresses,
                subject, text_body, html_body, snippet,
                is_read, is_starred, labels, direction, owner_type, owner_id,
                sent_at, synced_at, raw_headers, created_at, updated_at
              ) VALUES (
                ${ctx.id("mail-message", `${conv.key}:${i}`)}::uuid,
                ${orgId}::uuid, ${conversationId}::uuid, ${accountId}::uuid,
                ${`demo-thread-${conv.key}-msg-${i}`},
                '[]'::jsonb,
                ${JSON.stringify({ name: m.fromName, email: m.fromEmail })}::jsonb,
                ${JSON.stringify([{ name: m.toName, email: m.toEmail }])}::jsonb,
                '[]'::jsonb, '[]'::jsonb,
                ${conv.subject}, ${m.body}, NULL, ${m.body.slice(0, 160)},
                ${conv.isRead}, ${conv.isStarred},
                ${JSON.stringify(conv.labels)}::jsonb, ${m.direction},
                ${ownerType}, ${ownerId}::uuid,
                ${sentAt.toISOString()}, ${sentAt.toISOString()},
                ${JSON.stringify({ ...m.headers, "message-id": `<demo-${conv.key}-${i}@${input.domain}>` })}::jsonb,
                ${sentAt.toISOString()}, ${sentAt.toISOString()}
              )
              ON CONFLICT (id) DO NOTHING`,
        )
      }
    }
  })

  return { accountIds, conversationIds }
}
