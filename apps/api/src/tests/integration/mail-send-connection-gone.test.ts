// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Sending from a mailbox whose connection is gone (its connected account was
// deleted or disconnected) is the person's to fix, not a server fault: the send
// answers `connection_not_connected` (a 422 on the web's sends, the tool's
// answer on mail:reply), names the mailbox, says nothing was sent and what to
// do next, never a 500 "Internal server error".
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { initializedOrgRuntimes, registeredApps, toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { sendCompose, sendReply } from "~/modules/mail/service"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

/** A JSON value as a jsonb literal for insertSql. */
const jsonb = (value: unknown) => ({
  raw: `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`,
})

const orgId = "00000000-0000-0000-0000-0000005e8201"
const userId = "00000000-0000-0000-0000-0000005e8202"
const connectedAccountId = "00000000-0000-0000-0000-0000005e8204"
const accountId = "00000000-0000-0000-0000-0000005e8205"
const conversationId = "00000000-0000-0000-0000-0000005e8206"
const MAILBOX = "support-gone@example.com"

const SCOPES = [
  "mail:conversations:read",
  "mail:conversations:write",
  "mail:accounts:read",
  "mail:messages:read",
  "mail:messages:write",
]
const actor = {
  actorType: "user" as const,
  userId,
  orgId,
  scopes: SCOPES,
  dimensionGrants: { "mail:inbox": [accountId] },
}

describe("sending from a mailbox whose connection is gone", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await initSandboxPool()
    const once = { onConflictDoNothing: true }
    await sql.unsafe(
      insertSql(
        "kernel.organizations",
        { id: orgId, name: "Mail Gone Org", slug: "mail-gone-org" },
        once,
      ),
    )
    await sql.unsafe(
      insertSql(
        "kernel.users",
        {
          id: userId,
          org_id: orgId,
          email: "mail-gone@test.com",
          name: "Gone Conn",
          status: "active",
          password_hash: "hash",
          auth_version: 1,
          permission_version: 1,
        },
        once,
      ),
    )
    await sql.unsafe(
      insertSql(
        "kernel.user_scope_grants",
        SCOPES.map((scope) => ({ user_id: userId, org_id: orgId, scope })),
        once,
      ),
    )
    await sql.unsafe(
      insertSql(
        "kernel.user_dimension_grants",
        {
          user_id: userId,
          org_id: orgId,
          dimension_key: "mail:inbox",
          dimension_values: jsonb([accountId]),
        },
        once,
      ),
    )
    await ensureAppsForOrg(orgId)
    // The mailbox points at a connected account that no longer exists.
    await sql.unsafe(
      insertSql(
        "app_mail.accounts",
        {
          id: accountId,
          org_id: orgId,
          connected_account_id: connectedAccountId,
          owner_type: "org",
          owner_id: null,
          provider: "imap",
          email_address: MAILBOX,
          display_name: "Support",
          sync_status: "active",
        },
        once,
      ),
    )
    await sql.unsafe(
      insertSql(
        "app_mail.conversations",
        {
          id: conversationId,
          org_id: orgId,
          account_id: accountId,
          owner_type: "org",
          owner_id: null,
          external_thread_id: "imap-thread-1",
          subject: "Order question",
          snippet: "When does it ship?",
          status: "open",
          labels: jsonb(["INBOX"]),
          is_read: false,
          is_starred: false,
          last_message_at: { raw: "now()" },
          message_count: 1,
        },
        once,
      ),
    )
    await sql.unsafe(
      insertSql(
        "app_mail.messages",
        {
          id: { raw: "gen_random_uuid()" },
          org_id: orgId,
          conversation_id: conversationId,
          account_id: accountId,
          external_message_id: "<gone-1@example.com>",
          external_provider_id: "imap-1",
          in_reply_to: null,
          message_references: jsonb([]),
          from_address: jsonb({ name: "Casey Customer", email: "casey@example.com" }),
          to_addresses: jsonb([{ email: MAILBOX }]),
          cc_addresses: jsonb([]),
          bcc_addresses: jsonb([]),
          subject: "Order question",
          text_body: "When does it ship?",
          html_body: null,
          snippet: "When does it ship?",
          is_read: false,
          is_starred: false,
          labels: jsonb(["INBOX"]),
          direction: "inbound",
          sent_at: { raw: "now()" },
          synced_at: { raw: "now()" },
          raw_headers: jsonb({}),
          owner_type: "org",
          owner_id: null,
        },
        once,
      ),
    )
  })

  afterAll(async () => {
    await shutdownSandboxPool()
    toolRegistry.deleteByPrefix([orgId])
    registeredApps.delete(`${orgId}:mail`)
    initializedOrgRuntimes.delete(orgId)
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.user_dimension_grants WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${orgId}`
    await sql`DELETE FROM app_mail.messages WHERE org_id = ${orgId}`
    await sql`DELETE FROM app_mail.conversations WHERE org_id = ${orgId}`
    await sql`DELETE FROM app_mail.accounts WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
    await releaseTestLock()
  })

  type Typed = Error & { status?: number; code?: string }
  const expectNotConnected = (err: Typed | null) => {
    expect(err).not.toBeNull()
    expect({ status: err?.status, code: err?.code }).toEqual({
      status: 422,
      code: "connection_not_connected",
    })
    expect(err?.message).toContain(MAILBOX)
    expect(err?.message).toContain("nothing was sent")
    expect(err?.message).toContain("Reconnect it in Settings → Connections")
  }

  it("the person's reply (mail:reply) answers connection_not_connected, naming the mailbox", async () => {
    // A not-connected state is the tool's answer, not a failure (execute-tool
    // isNotConnectedToolErrorCode): the error rides back as the result.
    const result = await executeTool({
      toolName: "mail:reply",
      orgId,
      actor,
      params: { conversationId, textBody: "It ships tomorrow." },
      origin: "human-ui",
    })
    const answer = (result.data as { error?: { code?: string; message?: string } }).error
    expect(answer?.code).toBe("connection_not_connected")
    expect(answer?.message).toContain(MAILBOX)
    expect(answer?.message).toContain("nothing was sent")
    expect(answer?.message).toContain("Reconnect it in Settings → Connections")
  })

  it("the web's reply send (mail service sendReply) answers the same", async () => {
    const err = (await withRlsContext(actor, (tx) =>
      sendReply(tx, {
        orgId,
        userId,
        conversationId,
        htmlBody: "<p>It ships tomorrow.</p>",
        textBody: "It ships tomorrow.",
      }),
    ).then(
      () => null,
      (e: unknown) => e,
    )) as Typed | null
    expectNotConnected(err)
  })

  it("the web's new message send (mail service sendCompose) answers the same", async () => {
    const err = (await withRlsContext(actor, (tx) =>
      sendCompose(tx, {
        orgId,
        userId,
        accountId,
        to: ["casey@example.com"],
        subject: "Delivery",
        htmlBody: "<p>It ships tomorrow.</p>",
        textBody: "It ships tomorrow.",
      }),
    ).then(
      () => null,
      (e: unknown) => e,
    )) as Typed | null
    expectNotConnected(err)
  })
})
