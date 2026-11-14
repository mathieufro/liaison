// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Shopify app's Admin API, sent to a fake on a labelled private test box.
//
// With LIAISON_TEST_SHOPIFY_ADMIN_URL on (lib/shopify-fake-admin-gate.ts), a
// request of the Shopify app to `https://<shop>.myshopify.com/admin/...` goes to
// that one origin instead, same path and query, with the shop's domain in
// `X-Liaison-Shop-Domain`. The app is unchanged: its connect (webhook
// registration), its disconnect cleanup, its jobs and its reads all build the
// canonical Shopify URL, pass the app's own allowlist (`*.myshopify.com`) and get
// the token from the host as always; only the wire target moves, here, host side.
//
// What does NOT change:
//   - The app's allowlist. An app request that names the fake origin itself is
//     refused like any host it does not declare, gate on or off.
//   - Any other app, any other host, any path outside `/admin/`, a custom app.
//   - With the gate off (every real instance) this returns null and the request
//     goes to Shopify byte for byte as before, so the shop token never goes
//     anywhere but Shopify.
// The rewritten request follows no redirect and may reach only the fake origin,
// resolved to a private or loopback address.
import { env, isTestEnv } from "~/lib/env"
import { isPrivateIp } from "~/lib/ip-classify"
import { type ShopifyFakeAdminGateInput, shopifyFakeAdminGate } from "~/lib/shopify-fake-admin-gate"
import { sandboxTenantKey } from "~/modules/apps/custom-app-name"

const SHOPIFY_APP = "shopify"
const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/

/** The header naming the store the request was for (the fake has one origin for every store). */
export const FAKE_SHOP_DOMAIN_HEADER = "X-Liaison-Shop-Domain"

let testInputs: ShopifyFakeAdminGateInput | null = null

/**
 * Tests set the gate's INPUTS, never its answer: the gate itself always runs, so a
 * test that turns it on still proves the gate. Refused outside a test process.
 */
export const ShopifyFakeAdminTestAccess = {
  setInputs(inputs: ShopifyFakeAdminGateInput | null): void {
    if (!isTestEnv()) throw new Error("ShopifyFakeAdminTestAccess is for tests only")
    testInputs = inputs
  },
}

function gateInputs(): ShopifyFakeAdminGateInput {
  return (
    testInputs ?? {
      value: env.LIAISON_TEST_SHOPIFY_ADMIN_URL,
      declaredPrivate: env.LIAISON_PRIVATE_DEMO_BOX,
      baseUrl: env.BASE_URL,
      managed: env.LIAISON_EDITION === "managed",
    }
  )
}

/** The fake's origin when the gate is on, else null (off, or refused). */
export function activeShopifyFakeAdminOrigin(): string | null {
  const gate = shopifyFakeAdminGate(gateInputs())
  return gate.state === "on" ? gate.origin : null
}

export interface ShopifyFakeAdminTarget {
  /** Where the request goes instead. */
  url: string
  /** The fake's exact origin (the only host the request may reach). */
  origin: string
  /** The store the request was for. */
  shopDomain: string
}

/**
 * Where a sandbox fetch of `appName` to `url` goes instead, or null when it goes
 * where the app sent it. Null unless the gate is on, the app is the Shopify app
 * (not an org's custom app), and the URL is an HTTPS Admin API URL of a store.
 */
export function shopifyFakeAdminTarget(
  appName: string,
  url: string,
): ShopifyFakeAdminTarget | null {
  const origin = activeShopifyFakeAdminOrigin()
  if (!origin) return null
  if (appName !== SHOPIFY_APP || sandboxTenantKey(appName) !== undefined) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  if (u.protocol !== "https:" || u.port !== "" || u.username || u.password) return null
  if (!SHOP_HOST.test(host)) return null
  if (!u.pathname.startsWith("/admin/")) return null
  return { url: `${origin}${u.pathname}${u.search}`, origin, shopDomain: host }
}

/** The pinned-fetch policy of a rewritten request: the fake's origin only, on a private address. */
export function shopifyFakeAdminFetchPolicy(origin: string): {
  privateAllowedFor: (url: URL) => boolean
  refuseAddress: (address: string, url: URL) => string | null
} {
  return {
    privateAllowedFor: (url) => url.origin === origin,
    refuseAddress: (address, url) =>
      url.origin !== origin
        ? "the fake Shopify Admin API request may reach only its own origin"
        : isPrivateIp(address)
          ? null
          : "the fake Shopify Admin API must resolve to a private or loopback address",
  }
}
