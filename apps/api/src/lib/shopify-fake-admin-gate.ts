// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The gate of LIAISON_TEST_SHOPIFY_ADMIN_URL: a fake Shopify Admin API for a
// labelled private test box.
//
// When the setting is on, the sandbox egress bridge sends the Shopify app's Admin
// API requests (`https://<shop>.myshopify.com/admin/...`) to this one origin
// instead of Shopify, with the shop's token on them (bridge/shopify-fake-admin.ts).
// On a real instance that would be a way to send a store's token anywhere, so it
// is honoured only on a box that is private by the same two keys that make a
// demo-mode box private (modules/demo/demo-mode.ts `publicDemoInstance`):
//   - LIAISON_PRIVATE_DEMO_BOX declared, AND
//   - a loopback BASE_URL (a box reached only through a tunnel),
// and never in the managed edition. Whatever NODE_ENV says: a private test box runs the
// production image, and a development or test process gets no exception either.
//
// Anything else with the setting present is REFUSED: lib/env.ts stops the process
// at boot, so a real instance never runs with it. The value itself must be one
// bare origin on the box's own network (a loopback address, a one-label service
// name, or host.docker.internal), never a public name, an IP outside loopback, a
// path, credentials or a query.
//
// Pure: the caller passes the values. lib/env.ts calls it at boot, the bridge on
// every request, so a gate that changed after boot still closes.
import { isAlwaysBlockedIp } from "~/lib/ip-classify"

export const SHOPIFY_FAKE_ADMIN_ENV = "LIAISON_TEST_SHOPIFY_ADMIN_URL"

export interface ShopifyFakeAdminGateInput {
  /** The setting's raw value. */
  value: string | undefined
  /** LIAISON_PRIVATE_DEMO_BOX. */
  declaredPrivate: boolean
  /** BASE_URL. */
  baseUrl: string
  /** The managed edition (LIAISON_EDITION=managed). */
  managed: boolean
}

export type ShopifyFakeAdminGate =
  | { state: "off" }
  | { state: "on"; origin: string }
  | { state: "refused"; reason: string }

function loopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "")
  if (h === "localhost" || h.endsWith(".localhost")) return true
  if (h === "::1") return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

function loopbackOrigin(url: string): boolean {
  try {
    return loopbackHost(new URL(url).hostname)
  } catch {
    return false
  }
}

/** A one-label name such as a Compose service (`shopfake`): resolved on the box's own network. */
const SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function boxLocalHost(host: string): boolean {
  const h = host.toLowerCase()
  if (loopbackHost(h)) return true
  if (h === "host.docker.internal") return true
  // A bare number is an IPv4 literal to WHATWG URL parsing, never a service name.
  if (/^\d+$/.test(h)) return false
  return SERVICE_NAME.test(h)
}

/** Parse the setting into its exact origin, or say why it is not one. */
function parseFakeOrigin(raw: string): { origin: string } | { reason: string } {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { reason: "it is not a URL" }
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { reason: "it must be an http or https origin" }
  }
  if (u.username || u.password) return { reason: "it must not carry credentials" }
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) {
    return { reason: "it must be a bare origin, with no path, query or fragment" }
  }
  const host = u.hostname.replace(/^\[|\]$/g, "")
  if (isAlwaysBlockedIp(host)) return { reason: "it must not be a link-local or metadata address" }
  if (!boxLocalHost(u.hostname)) {
    return {
      reason:
        "its host must be on this box: a loopback address, a one-label service name or host.docker.internal",
    }
  }
  return { origin: u.origin }
}

/** Is the fake Shopify Admin API on, off, or refused for these settings? */
export function shopifyFakeAdminGate(input: ShopifyFakeAdminGateInput): ShopifyFakeAdminGate {
  const raw = input.value?.trim() ?? ""
  if (raw === "") return { state: "off" }
  if (input.managed) {
    return { state: "refused", reason: "it is never honoured in the managed edition" }
  }
  if (!input.declaredPrivate) {
    return {
      state: "refused",
      reason: "this box is not labelled private (LIAISON_PRIVATE_DEMO_BOX is not set)",
    }
  }
  if (!loopbackOrigin(input.baseUrl)) {
    return {
      state: "refused",
      reason: "BASE_URL is not a loopback address, so this box is reachable from outside",
    }
  }
  const parsed = parseFakeOrigin(raw)
  if ("reason" in parsed) return { state: "refused", reason: parsed.reason }
  return { state: "on", origin: parsed.origin }
}
