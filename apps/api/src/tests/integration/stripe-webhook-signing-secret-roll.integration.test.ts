// SPDX-License-Identifier: FSL-1.1-ALv2
// Rolling a payments app's webhook signing secret: the old secret keeps verifying for 24 hours, then stops.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHmac, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { __privileged_db__ as db, sql } from "~/db/connection"
import {
  decryptConnectionConfigValue,
  storeAppHeldSecret,
} from "~/modules/apps/connections/service"
import { buildVerifyBridge } from "~/modules/webhooks/verify-bridge"
import { seedOrgRow } from "~/seed/factories/org/rows"
import { insertSql } from "~/seed/factories/org/test-rows"
import {
  type StripeVerifyBridge,
  verifyStripeDelivery,
} from "../../../../../bundled-apps/stripe/src/verify"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const manifest = JSON.parse(
  readFileSync(join(REPO_ROOT, "bundled-apps", "stripe", "app.manifest.json"), "utf8"),
) as { connections: Record<string, never> }

const OLD = "whsec_oldSigningSecret0123456789"
const NEW = "whsec_newSigningSecret0123456789"
const BODY = JSON.stringify({ id: "evt_ROLL1", type: "customer.updated" })
const HOUR = 3_600_000

let orgId: string

async function storedConfig(): Promise<Record<string, unknown>> {
  const [row] =
    await sql`SELECT config FROM kernel.apps WHERE org_id = ${orgId} AND name = 'stripe'`
  return (typeof row?.config === "string" ? JSON.parse(row.config) : row?.config) as Record<
    string,
    unknown
  >
}

async function bridge(): Promise<StripeVerifyBridge> {
  const config = await storedConfig()
  return buildVerifyBridge({
    readConfig: async (key) =>
      decryptConnectionConfigValue(
        orgId,
        "stripe",
        key,
        config[key] ?? null,
        undefined,
        manifest.connections,
      ),
    secretConfigKeys: ["webhookSigningSecret", "webhookSigningSecretPrevious"],
    workersRun: true,
  }) as unknown as StripeVerifyBridge
}

async function deliver(secret: string, atMs: number) {
  const t = Math.floor(atMs / 1000)
  const sig = createHmac("sha256", secret).update(`${t}.${BODY}`).digest("hex")
  return verifyStripeDelivery(
    { headers: { "stripe-signature": `t=${t},v1=${sig}` }, body: BODY, method: "POST", query: {} },
    await bridge(),
    atMs,
  )
}

const store = (value: string) =>
  storeAppHeldSecret({
    orgId,
    appName: "stripe",
    key: "webhookSigningSecret",
    value,
    manifestConnections: manifest.connections,
  })

beforeAll(async () => {
  orgId = await seedOrgRow({ id: randomUUID(), name: "Roll Org", slug: `roll-${randomUUID()}` })
  await db.execute(
    drizzleSql.raw(
      insertSql("kernel.apps", {
        id: randomUUID(),
        org_id: orgId,
        name: "stripe",
        version: "1.0.0",
        status: "active",
      }),
    ),
  )
})

afterAll(async () => {
  await sql`DELETE FROM kernel.apps WHERE org_id = ${orgId}`
})

describe("webhook signing secret roll", () => {
  it("the first secret has no previous one, and verifies", async () => {
    await store(OLD)
    const config = await storedConfig()
    expect(config.webhookSigningSecretPrevious).toBeUndefined()
    expect(await deliver(OLD, Date.now())).toMatchObject({ ok: true })
  })

  it("a replaced secret keeps the old one for 24 hours, encrypted, and then refuses it", async () => {
    const before = Date.now()
    await store(NEW)
    const config = await storedConfig()
    expect(config.webhookSigningSecretPrevious).toEqual(expect.any(String))
    expect(config.webhookSigningSecretPrevious).not.toBe(OLD)
    expect(config.webhookSigningSecret).not.toBe(NEW)
    const until = Date.parse(String(config.webhookSigningSecretPreviousUntil))
    expect(until).toBeGreaterThanOrEqual(before + 24 * HOUR)
    expect(until).toBeLessThanOrEqual(Date.now() + 24 * HOUR)

    // Signed with the new secret: accepted. With the old one: accepted before the deadline.
    expect(await deliver(NEW, before + HOUR)).toMatchObject({ ok: true })
    expect(await deliver(OLD, before + HOUR)).toMatchObject({ ok: true })
    // After the deadline the old secret verifies nothing; the new one still does.
    expect(await deliver(OLD, until + HOUR)).toEqual({ ok: false, reason: "signature_mismatch" })
    expect(await deliver(NEW, until + HOUR)).toMatchObject({ ok: true })
  })

  it("a second roll replaces the previous secret with the one it displaced", async () => {
    const third = "whsec_thirdSigningSecret0123456789"
    const at = Date.now()
    await store(third)
    expect(await deliver(NEW, at)).toMatchObject({ ok: true })
    expect(await deliver(OLD, at)).toEqual({ ok: false, reason: "signature_mismatch" })
    expect(await deliver(third, at)).toMatchObject({ ok: true })
  })
})
