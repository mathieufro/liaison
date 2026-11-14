// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which sandbox requests the fake Shopify Admin API takes, and the address
// policy of a rewritten request. The real path (sandbox, bridge, a real fake
// server) is in tests/integration/shopify-fake-admin.test.ts.
import { afterEach, describe, expect, it } from "bun:test"
import {
  activeShopifyFakeAdminOrigin,
  ShopifyFakeAdminTestAccess,
  shopifyFakeAdminFetchPolicy,
  shopifyFakeAdminTarget,
} from "~/modules/apps/sandbox/bridge/shopify-fake-admin"

const FAKE = "http://127.0.0.1:8899"
const ADMIN = "https://some-store.myshopify.com/admin/api/2026-04/graphql.json"

const on = () =>
  ShopifyFakeAdminTestAccess.setInputs({
    value: FAKE,
    declaredPrivate: true,
    baseUrl: "http://127.0.0.1:3000",
    managed: false,
  })

afterEach(() => ShopifyFakeAdminTestAccess.setInputs(null))

describe("the fake Shopify Admin API target", () => {
  it("is off in a process that did not set it", () => {
    expect(activeShopifyFakeAdminOrigin()).toBeNull()
    expect(shopifyFakeAdminTarget("shopify", ADMIN)).toBeNull()
  })

  it("is off when the setting is present on a box that is not labelled private", () => {
    ShopifyFakeAdminTestAccess.setInputs({
      value: FAKE,
      declaredPrivate: false,
      baseUrl: "http://127.0.0.1:3000",
      managed: false,
    })
    expect(shopifyFakeAdminTarget("shopify", ADMIN)).toBeNull()
  })

  it("sends a Shopify app Admin API request to the fake, same path and query", () => {
    on()
    expect(shopifyFakeAdminTarget("shopify", `${ADMIN}?x=1`)).toEqual({
      url: `${FAKE}/admin/api/2026-04/graphql.json?x=1`,
      origin: FAKE,
      shopDomain: "some-store.myshopify.com",
    })
  })

  it("leaves every other request where the app sent it", () => {
    on()
    for (const [app, url] of [
      ["invoicing", ADMIN],
      ["shopify", "https://some-store.myshopify.com/products/x"],
      ["shopify", "http://some-store.myshopify.com/admin/api/2026-04/graphql.json"],
      ["shopify", "https://some-store.myshopify.com:8443/admin/api/2026-04/graphql.json"],
      ["shopify", "https://myshopify.com.evil.example/admin/api"],
      ["shopify", "https://cdn.shopify.com/admin/x"],
      ["shopify", "not a url"],
    ] as const) {
      expect({ app, url, target: shopifyFakeAdminTarget(app, url) }).toEqual({
        app,
        url,
        target: null,
      })
    }
  })

  it("lets the rewritten request reach only the fake's origin, on a private address", () => {
    const policy = shopifyFakeAdminFetchPolicy(FAKE)
    expect(policy.privateAllowedFor(new URL(`${FAKE}/admin/x`))).toBe(true)
    expect(policy.privateAllowedFor(new URL("http://127.0.0.1:8900/admin/x"))).toBe(false)
    expect(policy.refuseAddress("127.0.0.1", new URL(`${FAKE}/admin/x`))).toBeNull()
    expect(policy.refuseAddress("fd12:3456::1", new URL(`${FAKE}/admin/x`))).toBeNull()
    expect(policy.refuseAddress("93.184.216.34", new URL(`${FAKE}/admin/x`))).not.toBeNull()
    expect(policy.refuseAddress("127.0.0.1", new URL("https://example.com/"))).not.toBeNull()
  })
})
