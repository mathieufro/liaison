// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A removed connection's provider work: durable through a provider outage, kept
// from anything another connection still needs, and never leaving a token behind
// once it is done. The provider is a local server.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { connectionTeardowns } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { connectionConfigRegistry, initializedOrgRuntimes } from "~/modules/apps/app-registries"
import {
  runConnectionTeardown,
  runDueConnectionTeardowns,
  teardownOrgConnections,
} from "~/modules/apps/connections/revoke"
import { disconnectConnection } from "~/modules/apps/connections/service"
import { createTicketsMethods } from "~/modules/apps/sandbox/bridge/tickets"
import { seedConnectedAccountRow, seedOAuthProviderRow } from "~/seed/factories/org/platform-rows"
import * as minimal from "~/seed/tiers/minimal"

let orgId: string
let userId: string
let server: ReturnType<typeof Bun.serve>
const calls: Array<{ path: string; auth: string | null; body: string }> = []
let replies: Record<string, { status: number; body?: string }> = {}

const url = (path: string) => `http://localhost:${server.port}${path}`

beforeAll(async () => {
  ;({ orgId, adminUserId: userId } = await minimal.secondOrg({ name: "Teardown Org" }))
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      calls.push({ path, auth: req.headers.get("authorization"), body: await req.text() })
      const reply = replies[path] ?? { status: 200, body: "{}" }
      return new Response(reply.status === 204 ? null : (reply.body ?? "{}"), {
        status: reply.status,
      })
    },
  })
  initializedOrgRuntimes.add(orgId)
})

afterEach(async () => {
  calls.length = 0
  replies = {}
  await sql`DELETE FROM kernel.connection_teardowns WHERE source_org_id = ${orgId}`
  await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`
  connectionConfigRegistry.clear()
})

afterAll(async () => {
  server.stop(true)
  initializedOrgRuntimes.delete(orgId)
})

function declare(
  appName: string,
  connectionName: string,
  opts: { stop?: boolean; inOrg?: string } = {},
): void {
  connectionConfigRegistry.set([opts.inOrg ?? orgId, appName, connectionName], {
    type: "oauth2",
    allowedDomains: [],
    tokenUrl: url("/token"),
    revocationUrl: url("/revoke"),
    ...(opts.stop === false ? {} : { watchStopUrl: url("/stop") }),
  })
}

async function insertConnection(opts: {
  appName?: string
  connectionName?: string
  identifier: string
  expired?: boolean
  access?: string
}): Promise<string> {
  return seedConnectedAccountRow({
    orgId,
    appName: opts.appName ?? "mail",
    connectionName: opts.connectionName ?? "gmail",
    ownerType: "user",
    ownerId: userId,
    providerType: "oauth2",
    identifier: opts.identifier,
    accessTokenEncrypted: encryptSecret(
      opts.access ?? "access-1",
      env.ENCRYPTION_KEY,
      CryptoContext.connectedAccountAccessToken,
    ),
    refreshTokenEncrypted: encryptSecret(
      "refresh-1",
      env.ENCRYPTION_KEY,
      CryptoContext.connectedAccountRefreshToken,
    ),
    tokenExpiresAt: new Date(Date.now() + (opts.expired ? -60_000 : 3_600_000)),
    status: "active",
    createdBy: userId,
  })
}

const disconnect = (id: string) =>
  withPrivilegedDb(orgId, "teardown-test", (tx) => disconnectConnection(tx, orgId, userId, id))

const pending = (id: string) =>
  sql<{ attempts: number; last_error: string | null }[]>`
    SELECT attempts, last_error FROM kernel.connection_teardowns WHERE connection_id = ${id}`

const makeDue = (id: string) =>
  sql`UPDATE kernel.connection_teardowns SET next_attempt_at = now() - interval '1 second'
      WHERE connection_id = ${id}`

const paths = () => calls.map((c) => c.path)

describe("provider teardown of a removed connection", () => {
  it("moves the tokens off the connection in the disconnect's own transaction", async () => {
    declare("mail", "gmail")
    const id = await insertConnection({ identifier: `move-${orgId}@example.com` })
    await disconnect(id)
    expect(calls).toHaveLength(0)
    const [conn] = await sql<{ access: string | null; refresh: string | null }[]>`
      SELECT access_token_encrypted AS access, refresh_token_encrypted AS refresh
      FROM kernel.connected_accounts WHERE id = ${id}`
    expect(conn).toEqual({ access: null, refresh: null })
    const [row] = await sql<{ refresh: string | null }[]>`
      SELECT refresh_token_encrypted AS refresh FROM kernel.connection_teardowns
      WHERE connection_id = ${id}`
    expect(row?.refresh).toBeTruthy()
  })

  it("a disconnect that rolls back leaves no teardown and calls nobody", async () => {
    declare("mail", "gmail")
    const id = await insertConnection({ identifier: `rollback-${orgId}@example.com` })
    await expect(
      withPrivilegedDb(orgId, "teardown-test-rollback", async (tx) => {
        await disconnectConnection(tx, orgId, userId, id)
        throw new Error("caller failed")
      }),
    ).rejects.toThrow("caller failed")
    expect(await pending(id)).toHaveLength(0)
    expect(await runConnectionTeardown(id)).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it("through a provider outage: keeps the tokens, never revokes first, finishes, then holds nothing", async () => {
    declare("mail", "gmail")
    const id = await insertConnection({ identifier: `outage-${orgId}@example.com` })
    await disconnect(id)

    replies = { "/stop": { status: 503 } }
    expect((await runConnectionTeardown(id))[0]?.status).toBe("retry")
    // Revoking now would destroy the only token that can still stop the watch.
    expect(paths()).toEqual(["/stop"])
    const [row] = await pending(id)
    expect(row?.attempts).toBe(1)
    expect(row?.last_error).toContain("503")
    // Not due yet: the delay holds it back from a second delivery of the event.
    expect(await runConnectionTeardown(id)).toEqual([])

    calls.length = 0
    replies = { "/stop": { status: 204 }, "/revoke": { status: 500 } }
    await makeDue(id)
    const second = await runDueConnectionTeardowns()
    expect(second.map((o) => o.status)).toContain("retry")
    expect(paths()).toEqual(["/stop", "/revoke"])
    expect(await pending(id)).toHaveLength(1)

    calls.length = 0
    replies = {}
    await makeDue(id)
    const third = await runDueConnectionTeardowns()
    expect(third).toContainEqual({ status: "done", watch: "stopped", grant: "revoked" })
    expect(await pending(id)).toHaveLength(0)
  })

  it("gives up after the maximum age: the tokens go and the failure is reported", async () => {
    declare("mail", "gmail")
    const id = await insertConnection({ identifier: `give-up-${orgId}@example.com` })
    await disconnect(id)
    await sql`UPDATE kernel.connection_teardowns SET created_at = now() - interval '73 hours'
      WHERE connection_id = ${id}`
    replies = { "/stop": { status: 503 } }
    expect((await runConnectionTeardown(id))[0]?.status).toBe("gave_up")
    expect(await pending(id)).toHaveLength(0)
  })

  it("an expired access token is refreshed for the stop and not stored", async () => {
    // Not Mail: its own client resolver refuses while the org has Gmail turned off.
    declare("crm", "oauth")
    await seedOAuthProviderRow({
      orgId,
      name: "crm:oauth",
      issuerUrl: "https://issuer.example.test",
      clientId: "client-1",
      clientSecretEncrypted: encryptSecret(
        "secret-1",
        env.ENCRYPTION_KEY,
        CryptoContext.oauthProviderClientSecret,
      ),
    })
    const id = await insertConnection({
      appName: "crm",
      connectionName: "oauth",
      identifier: `expired-${orgId}@example.com`,
      expired: true,
    })
    await disconnect(id)
    replies = { "/token": { status: 200, body: JSON.stringify({ access_token: "fresh-token" }) } }
    const [outcome] = await runConnectionTeardown(id)
    await sql`DELETE FROM kernel.oauth_providers WHERE org_id = ${orgId}`
    expect(outcome).toEqual({ status: "done", watch: "stopped", grant: "revoked" })
    expect(paths()).toEqual(["/token", "/stop", "/revoke"])
    expect(calls[1]?.auth).toBe("Bearer fresh-token")
    expect(new URLSearchParams(calls[0]?.body).get("refresh_token")).toBe("refresh-1")
  })

  it("a rejected refresh token means the grant is gone already: done, nothing retried", async () => {
    declare("mail", "gmail")
    const id = await insertConnection({ identifier: `dead-${orgId}@example.com` })
    await disconnect(id)
    replies = {
      "/stop": { status: 401 },
      "/token": { status: 400, body: '{"error":"invalid_grant"}' },
      "/revoke": { status: 400, body: '{"error":"invalid_token"}' },
    }
    const [outcome] = await runConnectionTeardown(id)
    expect(outcome?.status).toBe("done")
    expect(await pending(id)).toHaveLength(0)
  })

  it("Calendar on the same account: the Gmail watch stops, the shared grant stays", async () => {
    declare("mail", "gmail")
    declare("calendar", "google", { stop: false })
    const identifier = `calendar-${orgId}@example.com`
    const mail = await insertConnection({ identifier })
    await insertConnection({ appName: "calendar", connectionName: "google", identifier })
    await disconnect(mail)
    const [outcome] = await runConnectionTeardown(mail)
    expect(outcome).toEqual({ status: "done", watch: "stopped", grant: "still_used" })
    expect(paths()).toEqual(["/stop"])
  })

  it("Tickets on the same mailbox: neither the watch nor the grant is touched", async () => {
    declare("mail", "gmail")
    declare("tickets", "gmail")
    const identifier = `tickets-${orgId}@example.com`
    const mail = await insertConnection({ identifier })
    await insertConnection({ appName: "tickets", connectionName: "gmail", identifier })
    await disconnect(mail)
    const [outcome] = await runConnectionTeardown(mail)
    expect(outcome).toEqual({ status: "done", watch: "still_used", grant: "still_used" })
    expect(calls).toHaveLength(0)
    expect(await pending(mail)).toHaveLength(0)
  })

  it("a person who reconnected before the retry keeps the new watch and grant", async () => {
    declare("mail", "gmail")
    const id = await insertConnection({ identifier: `reconnect-${orgId}@example.com` })
    await disconnect(id)
    replies = { "/stop": { status: 503 } }
    await runConnectionTeardown(id)
    calls.length = 0
    replies = {}
    await sql`UPDATE kernel.connected_accounts SET status = 'active' WHERE id = ${id}`
    await makeDue(id)
    await runConnectionTeardown(id)
    expect(calls).toHaveLength(0)
    expect(await pending(id)).toHaveLength(0)
  })

  it("the same account in another org keeps its watch and grant", async () => {
    const { orgId: otherOrg, adminUserId: otherAdmin } = await minimal.secondOrg({
      name: "Teardown Other",
    })
    const identifier = `other-org-${orgId}@example.com`
    await seedConnectedAccountRow({
      orgId: otherOrg,
      appName: "mail",
      connectionName: "gmail",
      ownerType: "org",
      providerType: "oauth2",
      identifier: identifier.toUpperCase(),
      status: "active",
      createdBy: otherAdmin,
    })
    try {
      declare("mail", "gmail")
      declare("mail", "gmail", { inOrg: otherOrg })
      const id = await insertConnection({ identifier })
      await disconnect(id)
      const [outcome] = await runConnectionTeardown(id)
      expect(outcome).toEqual({ status: "done", watch: "still_used", grant: "still_used" })
      expect(calls).toHaveLength(0)
    } finally {
      await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${otherOrg}`
    }
  })

  it("an org purge stops and revokes each connection, sharers within the org not counting", async () => {
    declare("mail", "gmail")
    declare("calendar", "google", { stop: false })
    const identifier = `purge-${orgId}@example.com`
    await insertConnection({ identifier })
    await insertConnection({ appName: "calendar", connectionName: "google", identifier })
    const out = await teardownOrgConnections(orgId)
    expect(out.every((o) => o.status === "done")).toBe(true)
    expect(paths().filter((p) => p === "/stop")).toHaveLength(1)
    expect(paths()).toContain("/revoke")
    const rows = await sql`SELECT 1 FROM kernel.connected_accounts
      WHERE org_id = ${orgId} AND (access_token_encrypted IS NOT NULL OR status <> 'disconnected')`
    expect(rows).toHaveLength(0)
    expect(
      await sql`SELECT 1 FROM kernel.connection_teardowns WHERE source_org_id = ${orgId}`,
    ).toHaveLength(0)
  })

  it("an org purge with no live connection does not start the org's runtime", async () => {
    const id = await insertConnection({ identifier: `purge-gone-${orgId}@example.com` })
    await sql`UPDATE kernel.connected_accounts SET status = 'disconnected' WHERE id = ${id}`
    initializedOrgRuntimes.delete(orgId)
    try {
      expect(await teardownOrgConnections(orgId)).toEqual([])
      expect(initializedOrgRuntimes.has(orgId)).toBe(false)
    } finally {
      initializedOrgRuntimes.add(orgId)
    }
  })

  it("a teardown row outlives its org's rows while an outage lasts", async () => {
    declare("mail", "gmail")
    const id = await insertConnection({ identifier: `purge-outage-${orgId}@example.com` })
    replies = { "/stop": { status: 503 } }
    await teardownOrgConnections(orgId)
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`
    expect(await pending(id)).toHaveLength(1)
    calls.length = 0
    replies = {}
    await makeDue(id)
    await runConnectionTeardown(id)
    expect(paths()).toEqual(["/stop", "/revoke"])
    expect(await pending(id)).toHaveLength(0)
  })

  it("Tickets drops and acknowledges a push for a mailbox no longer connected", async () => {
    const synced: string[] = []
    const logged: string[] = []
    const record = (fields: unknown, msg?: string) =>
      logged.push(`${JSON.stringify(fields)} ${msg}`)
    const methods = createTicketsMethods({
      appName: "tickets",
      orgId,
      logger: { info: record, warn: record, error: record, debug: record },
      rpcBridge: {
        tickets_runSync: async (job: string) => {
          synced.push(job)
          return "{}"
        },
      },
    } as never)
    const identifier = `push-${orgId}@example.com`
    const id = await insertConnection({ appName: "tickets", connectionName: "gmail", identifier })

    await methods.tickets_onGmailPushService(identifier, "1")
    expect(synced).toEqual(["gmail-incremental-sync"])

    synced.length = 0
    logged.length = 0
    await disconnect(id)
    const answer = JSON.parse(await methods.tickets_onGmailPushService(identifier, "2"))
    expect(answer).toEqual({ skipped: "unknown_account" })
    expect(synced).toEqual([])
    expect(logged.join("\n")).not.toContain(identifier)
  })

  it("the request role may add its own org's row and can read or add nothing else", async () => {
    const row = {
      connectionId: randomUUID(),
      appName: "mail",
      connectionName: "gmail",
      identifier: "rls@example.com",
      refreshTokenEncrypted: "ciphertext",
    }
    const ctx = { actorType: "user", userId, orgId, scopes: ["*"], dimensionGrants: {} } as never
    await withRlsContext(ctx, async (tx) => {
      await tx.insert(connectionTeardowns).values({ ...row, sourceOrgId: orgId })
    })
    await expect(
      withRlsContext(ctx, (tx) => tx.select().from(connectionTeardowns)),
    ).rejects.toThrow()
    await expect(
      withRlsContext(ctx, async (tx) => {
        await tx.insert(connectionTeardowns).values({ ...row, sourceOrgId: randomUUID() })
      }),
    ).rejects.toThrow()
    await expect(
      withRlsContext(ctx, (tx) => tx.execute(drizzleSql`DELETE FROM kernel.connection_teardowns`)),
    ).rejects.toThrow()
  })
})
