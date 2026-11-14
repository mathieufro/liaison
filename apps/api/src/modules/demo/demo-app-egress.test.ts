// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A sandboxed app's outbound HTTP on a demo box, proved at the transport.
//
// `ctx.fetch` and `ctx.bulk.fetchToBlob` were governed only by the app
// manifest's `allowedDomains`, which says "this app may talk to Pennylane", not
// "this tenant may". A demo org could therefore put real requests on the wire
// to app.pennylane.com, the Boxtal carrier API, graph.facebook.com and the VIES
// VAT service, from the demo box's address.
//
// The recorder here IS the transport: `SandboxBridgeTestAccess.setFetch` is the
// fetch-impl the sandbox actually calls, and `setFetchInterceptsHost` claims the
// hosts under test so the call would land on it directly. Anything the recorder
// did not see never left.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createDbMethods } from "~/modules/apps/sandbox/bridge/db"
import { createEgressMethods } from "~/modules/apps/sandbox/bridge/egress"
import { envelopeError, SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { DemoRestrictionError } from "~/modules/demo/demo-egress"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { DEMO_SHOP_DOMAIN } from "~/modules/demo/shopify/sentinel"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const PENNYLANE = "https://app.pennylane.com/api/external/v1/customer_invoices"
const VIES = "https://ec.europa.eu/taxation_customs/vies/services/checkVatService"
const SHOPIFY = `https://${DEMO_SHOP_DOMAIN}/admin/api/2024-10/graphql.json`
const PAYMENTS = "https://api.stripe.com/v1/invoices/in_demo01/pdf"
const HOSTS = new Set(["app.pennylane.com", "ec.europa.eu", DEMO_SHOP_DOMAIN, "api.stripe.com"])

/** Every request that actually reached the transport. */
let onTheWire: string[] = []

function bridgeCtx(orgId: string): BridgeContext {
  return {
    orgId,
    userId: "00000000-0000-0000-0000-000000000001",
    appName: "pennylane",
    actorType: "user",
    egress: async () => ({
      allowedDomains: ["app.pennylane.com", "ec.europa.eu", DEMO_SHOP_DOMAIN, "api.stripe.com"],
      manifest: { name: "pennylane" },
    }),
    callerScopes: [],
    inheritedActor: { actorType: "user" as const },
    manifest: { name: "pennylane" },
    txDb: null,
    resolveCredentials: async () => ({}),
    // The bulk path's own bridge collaborators.
    requireCapability: () => {},
    errorEnvelope: (err: any) =>
      envelopeError(err?.code ?? "RPC_ERROR", err?.message ?? String(err)),
    bulkIteratorCursors: new Map(),
  } as unknown as BridgeContext
}

const appFetch =
  (orgId: string) =>
  (url: string, opts: Record<string, unknown> = {}) =>
    createEgressMethods(bridgeCtx(orgId)).fetch(url, JSON.stringify(opts))

const bulkFetch = (orgId: string) => (url: string) =>
  createDbMethods(bridgeCtx(orgId)).bulk_fetchToBlob(url)

async function setOrgLocale(orgId: string, locale: string): Promise<void> {
  await withPrivilegedDb(orgId, "test-set-locale", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE kernel.organizations SET default_locale = ${locale} WHERE id = ${orgId}::uuid`)
  })
}

describe("demo app egress lockdown", () => {
  let demoOrgId: string
  let frenchDemoOrgId: string
  let normalOrgId: string

  beforeAll(async () => {
    await acquireTestLock()
    demoOrgId = (await ensureOrg({ slug: "appegress-demo", name: "App Egress Demo" })).orgId
    frenchDemoOrgId = (await ensureOrg({ slug: "appegress-fr", name: "App Egress FR" })).orgId
    normalOrgId = (await ensureOrg({ slug: "appegress-normal", name: "App Egress Normal" })).orgId
    await markOrgAsDemo(demoOrgId, visitorMarker(24))
    await markOrgAsDemo(frenchDemoOrgId, visitorMarker(24))
    await setOrgLocale(frenchDemoOrgId, "fr-FR")
    invalidateDemoMarker()
    SandboxBridgeTestAccess.setFetch((async (url: string | URL) => {
      onTheWire.push(String(url))
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    }) as unknown as typeof fetch)
    SandboxBridgeTestAccess.setFetchInterceptsHost((hostname) => HOSTS.has(hostname))
  })

  afterAll(async () => {
    SandboxBridgeTestAccess.setFetch(null)
    SandboxBridgeTestAccess.setFetchInterceptsHost(null)
    DemoModeTestAccess.set(null)
    await releaseTestLock()
  })

  afterEach(() => {
    onTheWire = []
    invalidateDemoMarker()
  })

  // ---- ctx.fetch -------------------------------------------------------

  it("refuses a demo org's app fetch, and nothing reaches the transport", async () => {
    DemoModeTestAccess.set(true)
    await expect(appFetch(demoOrgId)(PENNYLANE)).rejects.toThrow(DemoRestrictionError)
    expect(onTheWire).toEqual([])
  })

  it("refuses an unauthenticated third party too, not just the credentialed ones", async () => {
    DemoModeTestAccess.set(true)
    // VIES needs no connection at all, so before this it was reachable by any
    // visitor through the invoicing app's VAT check.
    await expect(appFetch(demoOrgId)(VIES)).rejects.toThrow(DemoRestrictionError)
    expect(onTheWire).toEqual([])
  })

  it("names the host and the reason rather than failing as a confusing 401", async () => {
    DemoModeTestAccess.set(true)
    let caught: unknown
    await appFetch(demoOrgId)(PENNYLANE).catch((err: unknown) => {
      caught = err
    })
    const err = caught as DemoRestrictionError
    expect(err).toBeInstanceOf(DemoRestrictionError)
    expect(err.status).toBe(403)
    expect(err.code).toBe("DEMO_RESTRICTED")
    expect(err.message).toContain("demo instance")
    expect(err.message).toContain("app.pennylane.com")
  })

  it("refuses in the org's own language", async () => {
    DemoModeTestAccess.set(true)
    let caught: unknown
    await appFetch(frenchDemoOrgId)(PENNYLANE).catch((err: unknown) => {
      caught = err
    })
    const err = caught as DemoRestrictionError
    expect(err.message).toContain("instance de démonstration")
    expect(err.message).toContain("app.pennylane.com")
    expect(onTheWire).toEqual([])
  })

  // ---- the Shopify carve-out stays exactly as it was --------------------

  it("still answers a demo org's Shopify call from fixtures rather than refusing it", async () => {
    DemoModeTestAccess.set(true)
    const raw = await appFetch(demoOrgId)(SHOPIFY, {
      method: "POST",
      body: JSON.stringify({ query: "{ shop { name } }" }),
    })
    // A fixture answer, not a refusal: the call returned a response envelope
    // instead of throwing, and it still never reached the transport.
    const parsed = JSON.parse(raw) as { status: number; body: string }
    expect(typeof parsed.status).toBe("number")
    expect(parsed.body).not.toContain("app.pennylane.com")
    expect(onTheWire).toEqual([])
  })

  // ---- bulk.fetchToBlob -------------------------------------------------

  it("refuses a demo org's bulk download with an explanation, and does not crash the app", async () => {
    DemoModeTestAccess.set(true)
    const raw = await bulkFetch(demoOrgId)(PENNYLANE)
    const parsed = JSON.parse(raw) as { error: { code: string; message: string } }
    expect(parsed.error.code).toBe("DEMO_RESTRICTED")
    expect(parsed.error.message).toContain("demo instance")
    expect(parsed.error.message).toContain("app.pennylane.com")
    expect(onTheWire).toEqual([])
  })

  it("a demo org's bulk download from the payments host is refused off the demo box too, never sent", async () => {
    DemoModeTestAccess.set(false)
    const raw = await bulkFetch(demoOrgId)(PAYMENTS)
    const parsed = JSON.parse(raw) as { error?: { code: string; message: string } }
    expect(parsed.error?.code).toBe("DEMO_RESTRICTED")
    expect(parsed.error?.message).toContain("cannot store real connector credentials")
    expect(onTheWire).toEqual([])
  })

  it("an unmarked org's bulk download from the payments host goes out as before", async () => {
    DemoModeTestAccess.set(false)
    const raw = await bulkFetch(normalOrgId)(PAYMENTS)
    expect((JSON.parse(raw) as { error?: { code: string } }).error?.code).not.toBe(
      "DEMO_RESTRICTED",
    )
    expect(onTheWire).toEqual([PAYMENTS])
  })

  // ---- OFF, twice over -------------------------------------------------

  it("changes nothing with demo mode off: a marked org's fetch goes out as before", async () => {
    DemoModeTestAccess.set(false)
    const raw = await appFetch(demoOrgId)(PENNYLANE)
    expect(JSON.parse(raw).status).toBe(200)
    expect(onTheWire).toEqual([PENNYLANE])
  })

  it("changes nothing for an UNMARKED org on the demo box itself", async () => {
    DemoModeTestAccess.set(true)
    const raw = await appFetch(normalOrgId)(PENNYLANE)
    expect(JSON.parse(raw).status).toBe(200)
    expect(onTheWire).toEqual([PENNYLANE])
  })

  it("leaves bulk downloads alone off the demo box", async () => {
    DemoModeTestAccess.set(false)
    // No refusal: the call proceeds past the demo check and fails (or succeeds)
    // on its own terms, which is what "byte-identical to today" means here.
    const raw = await bulkFetch(demoOrgId)(PENNYLANE)
    const parsed = JSON.parse(raw) as { error?: { code: string } }
    expect(parsed.error?.code).not.toBe("DEMO_RESTRICTED")
  })
})
