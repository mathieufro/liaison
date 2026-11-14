// SPDX-License-Identifier: FSL-1.1-ALv2
//
// files_importFromUrl for a demo org (walk D62): the demo carrier's label is a
// specimen served in-process, so its download goes through the same door as
// the app's own Boxtal calls and never leaves the box. Without it the label
// import of a demo booking failed, and the approved sequence polled for a
// label for 21 minutes, then failed and woke the agent. Any other org, and a
// box out of demo mode, download as before.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { manifestFileParentRegistry } from "~/modules/apps/app-registries"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createFilesMethods } from "~/modules/apps/sandbox/bridge/files"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"

const DEMO_ORG = randomUUID()
const NORMAL_ORG = randomUUID()
const HOST = "api.boxtal.build"
const LABEL = `https://${HOST}/shipping/v3.1/shipping-order/DEMO-AB12CD34/demo-label.pdf`
const PAYMENTS_HOST = "api.stripe.com"
const PAYMENTS_PDF = `https://${PAYMENTS_HOST}/v1/invoices/in_demo01/pdf`

const PARENT = {
  tableName: "organizations",
  schemaRef: "kernel",
  joinOn: "id",
  readScope: "boxtal:read",
  writeScope: "boxtal:write",
}

function files(orgId: string, txDb: unknown) {
  return createFilesMethods({
    orgId,
    userId: "system",
    appName: "boxtal",
    egress: async () => ({
      allowedDomains: [HOST, PAYMENTS_HOST],
      manifest: { name: "boxtal", network: { allowPrivateHostsInTest: false } },
    }),
    manifest: { name: "boxtal", network: { allowPrivateHostsInTest: false } },
    bridgeOptions: {},
    schemaName: "app_boxtal",
    txDb,
    assertMailboxNotResetMidRun: async () => {},
  } as unknown as BridgeContext) as Record<string, (json: string) => Promise<string>>
}

// A first-party app's privileged bridge (its system events and jobs) runs on the
// background jobs pool, never on an interactive privileged slot: so does this one.
const importLabel = (orgId: string, url = LABEL) =>
  withPrivilegedDb(
    orgId,
    "test:import-demo-label",
    (tx) =>
      files(orgId, tx).files_importFromUrl!(
        JSON.stringify({
          targetApp: "boxtal",
          targetEntityType: "shipment",
          targetEntityId: orgId,
          url,
          filename: "label-DEMO-AB12CD34.pdf",
          mimeType: "application/pdf",
          pdfStripRotation: true,
        }),
      ),
    { pool: "jobs" },
  )

/** Every download that reaches the network, answered 404 as the real host would. */
function network(): string[] {
  const seen: string[] = []
  SandboxBridgeTestAccess.setFetch((async (input: string | URL) => {
    seen.push(String(input))
    return new Response("not found", { status: 404 })
  }) as unknown as typeof fetch)
  return seen
}

beforeAll(async () => {
  for (const id of [DEMO_ORG, NORMAL_ORG]) {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${id}, 'Import Demo Org', ${`idemo-${id.slice(0, 8)}`})`
    manifestFileParentRegistry.set([id, "boxtal", "shipment"], PARENT)
  }
  await markOrgAsDemo(DEMO_ORG, visitorMarker(24))
  invalidateDemoMarker()
})

afterEach(() => {
  SandboxBridgeTestAccess.setFetch(null)
  DemoModeTestAccess.set(null)
})

afterAll(async () => {
  await sql`DELETE FROM kernel.files WHERE org_id IN (${DEMO_ORG}, ${NORMAL_ORG})`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${DEMO_ORG}, ${NORMAL_ORG})`
  invalidateDemoMarker()
})

describe("files_importFromUrl on the demo instance", () => {
  it("stores a demo booking's label from the demo carrier, with nothing on the network", async () => {
    DemoModeTestAccess.set(true)
    const seen = network()
    const out = JSON.parse(await importLabel(DEMO_ORG)) as { id: string; sizeBytes: number }
    expect(seen).toEqual([])
    expect(out.sizeBytes).toBeGreaterThan(0)
    const [row] = await sql<Array<{ app: string; mime_type: string }>>`SELECT app, mime_type
      FROM kernel.files WHERE id = ${out.id}`
    expect(row).toMatchObject({ app: "boxtal", mime_type: "application/pdf" })
  })

  it("downloads as before for a normal org, and for any org out of demo mode", async () => {
    DemoModeTestAccess.set(true)
    let seen = network()
    await expect(importLabel(NORMAL_ORG)).rejects.toThrow(/upstream returned 404/)
    expect(seen).toEqual([LABEL])
    DemoModeTestAccess.set(false)
    seen = network()
    await expect(importLabel(DEMO_ORG)).rejects.toThrow(/upstream returned 404/)
    expect(seen).toEqual([LABEL])
  })

  it("a demo org's download from the payments host is refused off the demo box too, never sent", async () => {
    DemoModeTestAccess.set(false)
    const seen = network()
    await expect(importLabel(DEMO_ORG, PAYMENTS_PDF)).rejects.toThrow(
      /cannot store real connector credentials/,
    )
    expect(seen).toEqual([])
  })

  it("a normal org's download from the payments host goes out as before", async () => {
    DemoModeTestAccess.set(false)
    const seen = network()
    await expect(importLabel(NORMAL_ORG, PAYMENTS_PDF)).rejects.toThrow(/upstream returned 404/)
    expect(seen).toEqual([PAYMENTS_PDF])
  })
})
