// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The outbound lockdown, proved by watching the wire rather than by reading a
// config value.
//
// Every "blocked" assertion here is made against a recorder sitting where the
// real transport sits: the send either reached it or it did not. A test that
// only asserted `isDemoOrg(org) === true` would pass with the lockdown deleted.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createEgressMethods } from "~/modules/apps/sandbox/bridge/egress"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { DemoRestrictionError } from "~/modules/demo/demo-egress"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const CREDS = {
  smtpHost: "smtp.example.com",
  smtpPort: "587",
  username: "someone@example.com",
  password: "hunter2",
}

/** Every message that actually reached the transport. */
let onTheWire: unknown[] = []

function smtpBridge(orgId: string, userId: string): (msg: unknown) => Promise<string> {
  const methods = createEgressMethods({
    orgId,
    userId,
    appName: "mail",
    actorType: "user",
    egress: async () => ({ allowedDomains: [], manifest: { name: "mail" } }),
    callerScopes: [],
    inheritedActor: { actorType: "user" as const },
    manifest: { name: "mail" },
    txDb: null,
    resolveCredentials: async () => CREDS,
  } as unknown as BridgeContext)
  return (msg: unknown) => methods.smtp_send("smtp", "someone@example.com", JSON.stringify(msg))
}

describe("demo egress lockdown", () => {
  let demoOrgId: string
  let normalOrgId: string
  let demoUserId: string
  let normalUserId: string

  beforeAll(async () => {
    await acquireTestLock()
    demoOrgId = (await ensureOrg({ slug: "egress-demo", name: "Egress Demo" })).orgId
    normalOrgId = (await ensureOrg({ slug: "egress-normal", name: "Egress Normal" })).orgId
    demoUserId = (
      await ensureUser({
        orgId: demoOrgId,
        email: "demo@example.com",
        name: "Demo",
        password: "Passw0rd!",
        role: "admin",
      })
    ).userId
    normalUserId = (
      await ensureUser({
        orgId: normalOrgId,
        email: "normal@example.com",
        name: "Normal",
        password: "Passw0rd!",
        role: "admin",
      })
    ).userId
    await markOrgAsDemo(demoOrgId, visitorMarker(24))
    SandboxBridgeTestAccess.setSmtpSend(async (_c, _i, message) => {
      onTheWire.push(message)
      return { messageId: "delivered", deliveryState: "sent" }
    })
  })

  afterAll(async () => {
    SandboxBridgeTestAccess.setSmtpSend(null)
    DemoModeTestAccess.set(null)
    await releaseTestLock()
  })

  afterEach(() => {
    onTheWire = []
    invalidateDemoMarker()
  })

  it("refuses a demo org's customer mail, and nothing reaches the transport", async () => {
    DemoModeTestAccess.set(true)
    const send = smtpBridge(demoOrgId, demoUserId)
    await expect(send({ to: "real.person@gmail.com", subject: "Hi", text: "Hi" })).rejects.toThrow(
      DemoRestrictionError,
    )
    expect(onTheWire).toEqual([])
  })

  it("says why, in words a visitor can read, rather than dropping the send", async () => {
    DemoModeTestAccess.set(true)
    const send = smtpBridge(demoOrgId, demoUserId)
    let caught: unknown
    await send({ to: "x@example.com" }).catch((err) => {
      caught = err
    })
    const err = caught as DemoRestrictionError
    expect(err).toBeInstanceOf(DemoRestrictionError)
    expect(err.status).toBe(403)
    expect(err.code).toBe("DEMO_RESTRICTED")
    expect(err.message).toContain("demo instance")
    // A silent sink would have looked like success and recorded nothing.
    expect(onTheWire).toEqual([])
  })

  it("records a demo org's mail to its fictional people as captured, and nothing reaches the transport", async () => {
    DemoModeTestAccess.set(true)
    const send = smtpBridge(demoOrgId, demoUserId)
    const result = JSON.parse(
      await send({ to: ["noor@brasserie.example"], subject: "Hi", textBody: "Hi" }),
    )
    expect(result).toMatchObject({ deliveryState: "delivered", captured: true })
    expect(typeof result.messageId).toBe("string")
    expect(onTheWire).toEqual([])
  })

  it("a normal org's send is not marked captured", async () => {
    DemoModeTestAccess.set(true)
    const send = smtpBridge(normalOrgId, normalUserId)
    const result = JSON.parse(await send({ to: ["customer@example.com"], subject: "Hi" }))
    expect(result.captured).toBeUndefined()
  })

  it("leaves a normal org on the same box sending, so the check is keyed on the org", async () => {
    DemoModeTestAccess.set(true)
    const send = smtpBridge(normalOrgId, normalUserId)
    await send({ to: "customer@example.com", subject: "Invoice", text: "Attached" })
    expect(onTheWire).toHaveLength(1)
  })

  it("changes nothing at all with demo mode off", async () => {
    DemoModeTestAccess.set(false)
    const send = smtpBridge(demoOrgId, demoUserId)
    await send({ to: "customer@example.com", subject: "Invoice", text: "Attached" })
    expect(onTheWire).toHaveLength(1)
  })

  // Org-owned connections are created on a privileged transaction of the org,
  // as the connections route and the provisioning CLI create them.
  it("refuses to store a real connector credential for a demo org", async () => {
    DemoModeTestAccess.set(true)
    await expect(
      withPrivilegedDb(demoOrgId, "test-demo-credentials", (tx) =>
        createCredentialConnection(tx, demoOrgId, demoUserId, "mail", "smtp", {
          identifier: "someone@example.com",
          credentials: CREDS,
          ownerType: "org",
        }),
      ),
    ).rejects.toThrow(DemoRestrictionError)

    // Refused means not written, not written-then-hidden.
    const [row] = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM kernel.connected_accounts WHERE org_id = ${demoOrgId}`
    expect(Number(row.count)).toBe(0)
  })

  // An inbound-only connection (the kernel mints the webhook signing secret, the
  // app declares no egress domain and no password field) stores nothing that
  // belongs to a third party: it is allowed, so a visitor can try the webhook.
  it("lets a demo org create an inbound-only webhook connection", async () => {
    DemoModeTestAccess.set(true)
    connectionConfigRegistry.set([demoOrgId, "inbound-demo-app", "alert-source"], {
      type: "credentials",
      allowedDomains: [],
      webhookSecretConfigKey: "inboundDemoWebhookSecret",
      credentialFields: [{ name: "label", label: "Label", type: "text", required: true }],
    })
    try {
      const account = await withPrivilegedDb(demoOrgId, "test-demo-inbound", (tx) =>
        createCredentialConnection(tx, demoOrgId, demoUserId, "inbound-demo-app", "alert-source", {
          identifier: "grafana-demo",
          credentials: { label: "grafana-demo" },
          ownerType: "org",
        }),
      )
      expect(account.connectionName).toBe("alert-source")
    } finally {
      connectionConfigRegistry.delete([demoOrgId, "inbound-demo-app", "alert-source"])
      await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${demoOrgId}`
      await sql`DELETE FROM kernel.apps WHERE org_id = ${demoOrgId} AND name = 'inbound-demo-app'`
    }
  })

  it("still refuses a demo org a webhook connection that also takes a secret or calls out", async () => {
    DemoModeTestAccess.set(true)
    const cases = [
      // A password field is a real credential even next to a minted secret.
      {
        allowedDomains: [],
        credentialFields: [{ name: "apiKey", label: "Key", type: "password", required: true }],
      },
      // An egress domain means the stored fields are used against someone's API.
      {
        allowedDomains: ["api.example.com"],
        credentialFields: [{ name: "label", label: "Label", type: "text", required: true }],
      },
    ]
    for (const c of cases) {
      connectionConfigRegistry.set([demoOrgId, "inbound-demo-app", "alert-source"], {
        type: "credentials",
        webhookSecretConfigKey: "inboundDemoWebhookSecret",
        ...c,
      })
      try {
        await expect(
          withPrivilegedDb(demoOrgId, "test-demo-inbound-refused", (tx) =>
            createCredentialConnection(
              tx,
              demoOrgId,
              demoUserId,
              "inbound-demo-app",
              "alert-source",
              { identifier: "x", credentials: { label: "x", apiKey: "k" }, ownerType: "org" },
            ),
          ),
        ).rejects.toThrow(DemoRestrictionError)
      } finally {
        connectionConfigRegistry.delete([demoOrgId, "inbound-demo-app", "alert-source"])
      }
    }
    const [row] = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM kernel.connected_accounts WHERE org_id = ${demoOrgId}`
    expect(Number(row.count)).toBe(0)
  })

  it("still stores a normal org's connector credentials", async () => {
    DemoModeTestAccess.set(true)
    await withPrivilegedDb(normalOrgId, "test-normal-credentials", (tx) =>
      createCredentialConnection(tx, normalOrgId, normalUserId, "mail", "smtp", {
        identifier: "someone@example.com",
        credentials: CREDS,
        ownerType: "org",
      }),
    )
    const [row] = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM kernel.connected_accounts WHERE org_id = ${normalOrgId}`
    expect(Number(row.count)).toBe(1)
  })
})
