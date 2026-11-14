// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The seeded Shopify and Boxtal fixture connections never reach a third party,
// on a box that is NOT in demo mode (a self-hosted install seeded with the
// lively world, a private walk box), proved at the transport.
//
// Before this, the fixture answer was gated on demo mode alone: on such a box
// the sentinel token went out to the real Shopify Admin API and the real Boxtal
// token endpoint (404, 401). The recorder below IS the transport the sandbox
// calls; anything it did not see never left.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createEgressMethods } from "~/modules/apps/sandbox/bridge/egress"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { DEMO_BOXTAL_SENTINEL_KEY } from "~/modules/demo/boxtal/sentinel"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import {
  DEMO_BOXTAL_TOKEN_PREFIX,
  fixtureConnectionOf,
  fixtureRefusal,
} from "~/modules/demo/fixture-credential"
import { DEMO_SHOP_DOMAIN, DEMO_SHOPIFY_SENTINEL_TOKEN } from "~/modules/demo/shopify/sentinel"
import { DEMO_PAYMENTS_SENTINEL_KEY } from "~/modules/demo/worlds/saas/payments/sentinel"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SHOPIFY = `https://${DEMO_SHOP_DOMAIN}/admin/api/2024-10/graphql.json`
const BOXTAL_TOKEN = "https://api.boxtal.build/iam/account-app/token"
const BOXTAL_QUOTE =
  "https://test.envoimoinscher.com/api/v1/cotation?colis_1.poids=1.8&destinataire.pays=DE&expediteur.pays=FR"
const HOSTS = new Set([DEMO_SHOP_DOMAIN, "api.boxtal.build", "test.envoimoinscher.com"])
const SENTINEL_BASIC = `Basic ${Buffer.from(`${DEMO_BOXTAL_SENTINEL_KEY}:${DEMO_BOXTAL_SENTINEL_KEY}`).toString("base64")}`

let onTheWire: string[] = []

function bridgeCtx(orgId: string, appName: string): BridgeContext {
  return {
    orgId,
    userId: "00000000-0000-0000-0000-000000000001",
    appName,
    actorType: "user",
    egress: async () => ({ allowedDomains: [...HOSTS], manifest: { name: appName } }),
    callerScopes: [],
    inheritedActor: { actorType: "user" as const },
    manifest: { name: appName },
    txDb: null,
    resolveCredentials: async () => ({}),
  } as unknown as BridgeContext
}

async function appFetch(
  orgId: string,
  appName: string,
  url: string,
  opts: Record<string, unknown> = {},
): Promise<{ status: number; body: string }> {
  const raw = await createEgressMethods(bridgeCtx(orgId, appName)).fetch(url, JSON.stringify(opts))
  return JSON.parse(raw) as { status: number; body: string }
}

describe("fixture connections off the demo instance", () => {
  let worldOrgId: string
  let plainOrgId: string

  beforeAll(async () => {
    await acquireTestLock()
    worldOrgId = (await ensureOrg({ slug: "fixture-conn-world", name: "Fixture World" })).orgId
    plainOrgId = (await ensureOrg({ slug: "fixture-conn-plain", name: "Fixture Plain" })).orgId
    // What `liaison seed --tier lively` leaves on a self-hosted box: the demo world's org.
    await markOrgAsDemo(worldOrgId, visitorMarker(24))
    invalidateDemoMarker()
    SandboxBridgeTestAccess.setFetch((async (url: string | URL) => {
      onTheWire.push(String(url))
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    }) as unknown as typeof fetch)
    SandboxBridgeTestAccess.setFetchInterceptsHost((hostname) => HOSTS.has(hostname))
    DemoModeTestAccess.set(false)
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

  it("answers the world's Shopify fixture in-process with demo mode off", async () => {
    const res = await appFetch(worldOrgId, "shopify", SHOPIFY, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": DEMO_SHOPIFY_SENTINEL_TOKEN },
      body: JSON.stringify({ query: "{ shop { name } }" }),
    })
    expect(res.status).toBe(200)
    expect(res.body).toContain("data")
    expect(onTheWire).toEqual([])
  })

  it("answers the world's Boxtal fixture in-process, token exchange and the call after it", async () => {
    const token = await appFetch(worldOrgId, "boxtal", BOXTAL_TOKEN, {
      method: "POST",
      headers: { Authorization: SENTINEL_BASIC },
    })
    expect(token.status).toBe(200)
    const accessToken = (JSON.parse(token.body) as { accessToken: string }).accessToken
    expect(accessToken.startsWith(DEMO_BOXTAL_TOKEN_PREFIX)).toBe(true)
    const quote = await appFetch(worldOrgId, "boxtal", BOXTAL_QUOTE, {
      headers: { Authorization: SENTINEL_BASIC },
    })
    expect(quote.status).toBe(200)
    expect(quote.body).toContain("<cotation>")
    expect(onTheWire).toEqual([])
  })

  it("refuses a fixture credential from an org without the demo world, and sends nothing", async () => {
    const shopify = await appFetch(plainOrgId, "shopify", SHOPIFY, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": DEMO_SHOPIFY_SENTINEL_TOKEN },
      body: "{}",
    })
    expect(shopify.status).toBe(403)
    const boxtal = await appFetch(plainOrgId, "boxtal", BOXTAL_TOKEN, {
      method: "POST",
      headers: { Authorization: SENTINEL_BASIC },
    })
    expect(boxtal.status).toBe(403)
    expect(boxtal.body).toContain("demo fixture")
    expect(onTheWire).toEqual([])
  })

  it("a real credential goes out exactly as before", async () => {
    const res = await appFetch(plainOrgId, "boxtal", BOXTAL_TOKEN, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from("real-key:real-secret").toString("base64")}` },
    })
    expect(res.status).toBe(200)
    expect(onTheWire).toEqual([BOXTAL_TOKEN])
  })
})

describe("fixtureConnectionOf", () => {
  it("recognises the fixture by its shop, its sentinels and the token it was issued", () => {
    expect(fixtureConnectionOf(SHOPIFY, {})).toBe("shopify")
    expect(
      fixtureConnectionOf("https://other.myshopify.com/x", {
        "X-Shopify-Access-Token": DEMO_SHOPIFY_SENTINEL_TOKEN,
      }),
    ).toBe("shopify")
    expect(fixtureConnectionOf(BOXTAL_TOKEN, { Authorization: SENTINEL_BASIC })).toBe("boxtal")
    expect(
      fixtureConnectionOf(BOXTAL_QUOTE, { Authorization: `Bearer ${DEMO_BOXTAL_TOKEN_PREFIX}abc` }),
    ).toBe("boxtal")
  })

  it("recognises the card-payments stand-in by its sentinel key, on any host", () => {
    const auth = { Authorization: `Bearer ${DEMO_PAYMENTS_SENTINEL_KEY}` }
    expect(fixtureConnectionOf("https://payments.example/v1/customers", auth)).toBe("stripe")
    expect(
      fixtureConnectionOf("https://payments.example/v1/customers", {
        Authorization: "Bearer rk_test_abc",
      }),
    ).toBeNull()
  })

  it("refuses a payments sentinel request in the processor's own error shape", async () => {
    const res = fixtureRefusal("stripe")
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain("demo fixture")
  })

  it("is null for every other request", () => {
    expect(
      fixtureConnectionOf("https://shop.myshopify.com/x", { "X-Shopify-Access-Token": "shpat_1" }),
    ).toBeNull()
    expect(fixtureConnectionOf(BOXTAL_TOKEN, { Authorization: "Basic cmVhbDpyZWFs" })).toBeNull()
    expect(fixtureConnectionOf("not a url", {})).toBeNull()
  })
})
