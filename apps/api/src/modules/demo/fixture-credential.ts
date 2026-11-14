// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A seeded fixture connection never reaches a third party, whatever mode the
// box runs in.
//
// The demo world installs Shopify, Boxtal and card-payments connections whose credentials are
// sentinels (shopify/sentinel.ts, boxtal/sentinel.ts) and whose shop domain is
// fixed. On the demo instance the providers answer them from fixtures. A box
// that is NOT in demo mode can still hold that world (`liaison seed --tier
// lively` on a self-hosted install, a private walk box), and there the gate
// used to be demo mode alone: the sentinel token went out to the real Shopify
// Admin API and the real Boxtal token endpoint, and came back as 404 and 401.
//
// The request itself says whether it belongs to a fixture connection: it
// carries a sentinel credential, the token the fixture responder issued, or
// the fixed demo shop domain. Such a request is answered in-process for an org
// holding the demo world, and refused for any other. It is never forwarded.
import { DEMO_BOXTAL_SENTINEL_KEY } from "./boxtal/sentinel"
import { DEMO_SHOP_DOMAIN, DEMO_SHOPIFY_SENTINEL_TOKEN } from "./shopify/sentinel"
import { DEMO_PAYMENTS_SENTINEL_KEY } from "./worlds/saas/payments/sentinel"

/** The prefix of every access token the Boxtal fixture responder issues. */
export const DEMO_BOXTAL_TOKEN_PREFIX = "liaison-demo-boxtal-token-"

export type FixtureProvider = "shopify" | "boxtal" | "stripe"

function headerValues(headers: Record<string, string> | undefined): string[] {
  if (!headers) return []
  return Object.values(headers).filter((v): v is string => typeof v === "string")
}

function decodeBasic(value: string): string | null {
  const m = /^\s*basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(value)
  if (!m) return null
  try {
    return Buffer.from(m[1]!, "base64").toString("utf8")
  } catch {
    return null
  }
}

/**
 * Which fixture connection this request belongs to, or null for any other
 * request. Pure and synchronous: a string compare per header, no I/O.
 */
export function fixtureConnectionOf(
  url: string,
  headers: Record<string, string> | undefined,
): FixtureProvider | null {
  let hostname = ""
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  if (hostname === DEMO_SHOP_DOMAIN) return "shopify"
  for (const value of headerValues(headers)) {
    if (value.includes(DEMO_SHOPIFY_SENTINEL_TOKEN)) return "shopify"
    if (value.includes(DEMO_PAYMENTS_SENTINEL_KEY)) return "stripe"
    if (value.includes(DEMO_BOXTAL_SENTINEL_KEY) || value.includes(DEMO_BOXTAL_TOKEN_PREFIX)) {
      return "boxtal"
    }
    const basic = decodeBasic(value)
    if (basic?.includes(DEMO_BOXTAL_SENTINEL_KEY)) return "boxtal"
  }
  return null
}

/** The answer to a fixture request from an org that does not hold the demo world. */
export function fixtureRefusal(provider: FixtureProvider): Response {
  if (provider === "stripe") {
    // In the card processor's own error shape, so the payments app reads the sentence.
    return new Response(
      JSON.stringify({
        error: {
          type: "invalid_request_error",
          code: "demo_fixture_connection",
          message:
            "This payments connection is a demo fixture: it holds no real key and is never sent to the card processor.",
        },
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    )
  }
  const name = provider === "shopify" ? "Shopify" : "Boxtal"
  return new Response(
    JSON.stringify({
      errors: `This ${name} connection is a demo fixture: it holds no real credential and is never sent to ${name}.`,
    }),
    { status: 403, headers: { "content-type": "application/json" } },
  )
}
