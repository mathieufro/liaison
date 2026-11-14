// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Installing a demo org's card-payments connection: the sentinel key, so the
// payments app resolves its connection and every call it makes reaches the
// stand-in (provider.ts), which answers it in-process.
//
// Demo mode refuses credential posts on every visitor door
// (`createCredentialConnection`), and that stays as it is: this function is not
// that path. It is called by the demo seeder and nothing else, takes no key
// from its caller, and writes only the constants in sentinel.ts. Even a real
// key would be inert: a demo org's payments call that does not carry the
// sentinel is refused, never put on the wire.
//
// The row is org-owned, written on the privileged handle as the connection
// service does for its org-owned callers.
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import {
  DEMO_PAYMENTS_IDENTIFIER,
  DEMO_PAYMENTS_SENTINEL_KEY,
  PAYMENTS_APP,
  PAYMENTS_CONNECTION,
} from "./sentinel"

/** The one field the payments app's connection declares (its restricted key). */
export function demoPaymentsCredentials(): Record<string, string> {
  return { restrictedKey: DEMO_PAYMENTS_SENTINEL_KEY }
}

/**
 * Give `orgId` the demo card-payments connection. Idempotent: a second call
 * refreshes the sentinel on the same row.
 */
export async function installDemoPaymentsConnection(opts: {
  orgId: string
  /** The seeded admin, for `created_by`. */
  createdByUserId: string
}): Promise<{ connectionId: string }> {
  const credentialsEncrypted = encryptSecret(
    JSON.stringify(demoPaymentsCredentials()),
    process.env.ENCRYPTION_KEY ?? "",
    CryptoContext.connectedAccountCredentials,
  )
  const connectionId = await withPrivilegedDb(opts.orgId, "install-demo-payments", async (tx) => {
    const match = and(
      eq(connectedAccounts.orgId, opts.orgId),
      eq(connectedAccounts.appName, PAYMENTS_APP),
      eq(connectedAccounts.connectionName, PAYMENTS_CONNECTION),
      eq(connectedAccounts.ownerType, "org"),
    )
    const [existing] = await tx
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(match)
      .limit(1)
    const fields = {
      providerType: "credentials" as const,
      identifier: DEMO_PAYMENTS_IDENTIFIER,
      displayName: "Card payments (demo stand-in)",
      credentialsEncrypted,
      status: "active" as const,
      statusMessage: null,
      disconnectedAt: null,
      metadata: { demo: true, note: "Demo stand-in. No real account, no real key." },
    }
    if (existing) {
      await tx
        .update(connectedAccounts)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(connectedAccounts.id, existing.id))
      return existing.id
    }
    const [row] = await tx
      .insert(connectedAccounts)
      .values({
        ...fields,
        orgId: opts.orgId,
        appName: PAYMENTS_APP,
        connectionName: PAYMENTS_CONNECTION,
        ownerType: "org",
        ownerId: null,
        createdBy: opts.createdByUserId,
      })
      .returning({ id: connectedAccounts.id })
    if (!row) throw new Error("demo payments connection was not written")
    return row.id
  })
  return { connectionId }
}
