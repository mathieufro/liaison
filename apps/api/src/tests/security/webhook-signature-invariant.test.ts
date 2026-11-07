// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Webhook signature invariant, enumerated.
//
// The table of webhooks is every `webhooks` entry of every app manifest on disk
// (bundled apps and the in-tree apps), which is exactly what the kernel
// registers. A manifest webhook that is not in VERIFIERS below fails the
// enumeration case, so a new webhook must bring its signing rule with it.
//
// For each verifier, run with the same crypto bridge the kernel route hands the
// sandbox (modules/webhooks/routes.ts):
//   missing signature  -> refused
//   wrong signature    -> refused
//   valid signature    -> accepted with a replay key
//   replay             -> the SAME replay key when only unsigned headers change,
//                         so the route's NX claim drops the second delivery
// The in-tree push verifiers (Google Pub/Sub OIDC, Calendar channel token) are
// driven through the real route and sandbox for the refusals; their valid case
// is the provider's own JWT and is covered by modules/webhooks/google-oidc.test.ts
// and apps/calendar/webhook.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHmac } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { buildVerifyBridge } from "~/modules/webhooks/verify-bridge"
import { boxtalWebhookVerifier } from "../../../../../bundled-apps/boxtal/src/lib/hmac"
import { callsWebhookVerifier } from "../../../../../bundled-apps/calls/src/lib/hmac"
import { monitoringWebhookVerifier } from "../../../../../bundled-apps/monitoring/src/lib/hmac"
import { verifyEinvoicingWebhook } from "../../../../../bundled-apps/pennylane/src/einvoicing/webhooks"
import { shopifyWebhookVerifier } from "../../../../../bundled-apps/shopify/src/lib/hmac"
import { metaWebhookVerifier } from "../../../../../bundled-apps/social/src/handlers"

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..")
const SECRET = "whsec-invariant-0123456789abcdef0123456789abcdef"

type Req = {
  headers: Record<string, string>
  body: string
  method: string
  query: Record<string, string>
}
type Verify = (req: Req) => Promise<unknown>

/** The host bridge, as routes.ts builds it (verify-bridge.ts), with the app's secret under its key. */
function bridge(secretKey: string) {
  return buildVerifyBridge({
    readConfig: async (key: string) => (key === secretKey ? SECRET : null),
    secretConfigKeys: [secretKey],
  })
}
const b64 = (body: string) => createHmac("sha256", SECRET).update(body, "utf8").digest("base64")
const hex = (body: string) => createHmac("sha256", SECRET).update(body, "utf8").digest("hex")

interface VerifierCase {
  verify: Verify
  /** A valid delivery: body plus signed headers. */
  sign: (body: string) => Record<string, string>
  /** The signature header(s) a forged request sets to garbage. */
  sigHeaders: string[]
  /** An unsigned header a resender can change freely (delivery id). */
  unsignedHeader?: string
  body: () => string
  /** For signed-ts verifiers: a correctly signed body whose ts is stale. */
  staleBody?: () => string
}

const tsBody = (ms = Date.now()) => JSON.stringify({ ts: new Date(ms).toISOString(), event: "x" })

const VERIFIERS: Record<string, VerifierCase> = {
  "shopify/*": {
    verify: (r) => shopifyWebhookVerifier(r, bridge("shopifyWebhookSecret") as never),
    sign: (body) => ({ "x-shopify-hmac-sha256": b64(body), "x-shopify-webhook-id": "d-1" }),
    sigHeaders: ["x-shopify-hmac-sha256"],
    unsignedHeader: "x-shopify-webhook-id",
    body: () => JSON.stringify({ id: 1, updated_at: "2026-01-01T00:00:00Z" }),
  },
  "boxtal/*": {
    verify: (r) => boxtalWebhookVerifier(r, bridge("boxtalWebhookSecret") as never),
    sign: (body) => ({ "x-bxt-signature": b64(body), "x-bxt-delivery-id": "d-1" }),
    sigHeaders: ["x-bxt-signature"],
    unsignedHeader: "x-bxt-delivery-id",
    body: () => JSON.stringify({ shipmentId: "s1", status: "DELIVERED" }),
  },
  "social/meta": {
    verify: (r) => metaWebhookVerifier(r, bridge("socialMetaAppSecret") as never),
    sign: (body) => ({ "x-hub-signature-256": `sha256=${hex(body)}` }),
    sigHeaders: ["x-hub-signature-256"],
    body: () => JSON.stringify({ object: "page", entry: [] }),
  },
  "calls/segment": {
    verify: (r) => callsWebhookVerifier(r, bridge("callsWebhookSecret") as never),
    sign: (body) => ({ "x-calls-signature": b64(body), "x-calls-delivery": "d-1" }),
    sigHeaders: ["x-calls-signature"],
    unsignedHeader: "x-calls-delivery",
    body: () => tsBody(),
    staleBody: () => tsBody(Date.now() - 24 * 3600_000),
  },
  "monitoring/alert": {
    verify: (r) => monitoringWebhookVerifier(r, bridge("monitoringWebhookSecret") as never),
    sign: (body) => ({ "x-monitoring-signature": b64(body), "x-monitoring-delivery": "d-1" }),
    sigHeaders: ["x-monitoring-signature"],
    unsignedHeader: "x-monitoring-delivery",
    body: () => tsBody(),
    staleBody: () => tsBody(Date.now() - 24 * 3600_000),
  },
  "pennylane/einvoicing": {
    verify: (r) => verifyEinvoicingWebhook(r, bridge("einvoicingWebhookSecret") as never),
    sign: (body) => {
      const t = Math.floor(Date.now() / 1000)
      return { "x-pennylane-signature": `t=${t},v1=${hex(`${t}.${body}`)}` }
    },
    sigHeaders: ["x-pennylane-signature"],
    body: () => JSON.stringify({ id: "evt_1", type: "customer_invoice.updated" }),
    staleBody: undefined,
  },
}

/** Webhooks whose verifier is a provider identity token, driven through the route below. */
const ROUTE_ONLY = new Set([
  "tickets/gmail-push",
  "mail/gmail-push",
  "calendar/google-push",
  "projects/ci-status",
])

function manifestWebhooks(): string[] {
  const out: string[] = []
  const dirs = [
    ...readdirSync(join(REPO, "bundled-apps")).map((d) => join(REPO, "bundled-apps", d)),
    ...readdirSync(join(REPO, "apps", "api", "src", "apps")).map((d) =>
      join(REPO, "apps", "api", "src", "apps", d),
    ),
  ]
  for (const dir of dirs) {
    let m: { name?: string; webhooks?: Record<string, unknown> | Array<{ name: string }> }
    try {
      m = JSON.parse(readFileSync(join(dir, "app.manifest.json"), "utf8"))
    } catch {
      continue
    }
    if (!m.webhooks || !m.name) continue
    const names = Array.isArray(m.webhooks)
      ? m.webhooks.map((w) => w.name)
      : Object.keys(m.webhooks)
    for (const n of names) out.push(`${m.name}/${n}`)
  }
  return out.sort()
}

function caseFor(webhook: string): VerifierCase | undefined {
  return VERIFIERS[webhook] ?? VERIFIERS[`${webhook.split("/")[0]}/*`]
}

const ok = (r: unknown) => {
  const v = r as { ok?: boolean; valid?: boolean; replayKey?: string }
  return (
    (v.ok === true || v.valid === true) && typeof v.replayKey === "string" && v.replayKey.length > 0
  )
}

describe("webhook signature invariant (every manifest-declared webhook)", () => {
  const all = manifestWebhooks()

  it("the enumeration finds the webhooks, and each one has a signing rule here", () => {
    expect(all.length).toBeGreaterThanOrEqual(20)
    const unclassified = all.filter((w) => !caseFor(w) && !ROUTE_ONLY.has(w))
    expect(unclassified).toEqual([])
  })

  for (const webhook of all.filter((w) => !ROUTE_ONLY.has(w))) {
    describe(webhook, () => {
      const c = caseFor(webhook)!
      const req = (headers: Record<string, string>, body: string): Req => ({
        headers: { "content-type": "application/json", ...headers },
        body,
        method: "POST",
        query: {},
      })

      it("refuses a delivery with no signature", async () => {
        const body = c.body()
        expect(ok(await c.verify(req({}, body)))).toBe(false)
      })

      it("refuses a delivery with a wrong signature", async () => {
        const body = c.body()
        const forged: Record<string, string> = { ...c.sign(body) }
        for (const h of c.sigHeaders)
          forged[h] = forged[h]!.replace(/[A-Za-z0-9]/, (ch) => (ch === "A" ? "B" : "A"))
        expect(ok(await c.verify(req(forged, body)))).toBe(false)
        // A valid signature over a DIFFERENT body is a wrong signature too.
        expect(ok(await c.verify(req(c.sign(`${body} `), body)))).toBe(false)
      })

      it("accepts a valid delivery, and a replay with fresh unsigned headers gets the same replay key", async () => {
        const body = c.body()
        const first = (await c.verify(req(c.sign(body), body))) as { replayKey: string }
        expect(ok(first)).toBe(true)
        const resent = { ...c.sign(body) }
        if (c.unsignedHeader) resent[c.unsignedHeader] = "d-2-fresh"
        const second = (await c.verify(req(resent, body))) as { replayKey: string }
        expect(second.replayKey).toBe(first.replayKey)
      })

      if (c.staleBody) {
        it("refuses a correctly signed delivery whose signed timestamp is stale", async () => {
          const body = c.staleBody!()
          expect(ok(await c.verify(req(c.sign(body), body)))).toBe(false)
        })
      }
    })
  }
})

// --- The route itself, for the in-tree push webhooks, through the real sandbox. ---
describe("webhook route refuses unsigned and forged push deliveries (real app, real sandbox)", () => {
  let orgId = ""
  let appRequest: (path: string, init: RequestInit) => Promise<Response>

  beforeAll(async () => {
    const { acquireTestLock } = await import("~/tests/route-test-setup")
    await acquireTestLock()
    const { initSandboxPool } = await import("~/modules/apps/sandbox/pool")
    await initSandboxPool()
    const { createTestOrg } = await import("~/tests/helpers/org")
    orgId = (await createTestOrg()).id
    const { app } = await import("~/app")
    appRequest = async (p, i) => app.request(p, i)
  }, 180_000)

  afterAll(async () => {
    const { shutdownSandboxPool } = await import("~/modules/apps/sandbox/pool")
    await shutdownSandboxPool()
    const { releaseTestLock } = await import("~/tests/route-test-setup")
    await releaseTestLock()
  })

  it("every webhook the org registered refuses a delivery with no or a forged credential", async () => {
    const { webhookHandlers } = await import("~/modules/apps/app-registries")
    // Test scaffolding apps (apps/api/test-support) load only under NODE_ENV
    // test/development and are not in the production image.
    const { TEST_ONLY_APPS } = await import("~/modules/apps/discover-apps")
    const registered: string[] = []
    for (const [[regOrg, app, endpoint]] of webhookHandlers.entries() as Iterable<
      [[string, string, string], unknown]
    >) {
      if (regOrg === orgId && !TEST_ONLY_APPS.has(app)) registered.push(`${app}/${endpoint}`)
    }
    expect(registered.length).toBeGreaterThan(0)
    const accepted: string[] = []
    const forgedHeaders: Record<string, string> = {
      authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ4In0.c2ln",
      "x-goog-channel-token": "forged",
      "x-goog-channel-id": "chan-1",
      "x-goog-message-number": "1",
      "x-projects-ci-signature": "Zm9yZ2Vk",
    }
    const body = JSON.stringify({
      ts: new Date().toISOString(),
      message: { messageId: "m-1", data: "e30=" },
    })
    for (const w of registered) {
      for (const headers of [{}, forgedHeaders]) {
        const res = await appRequest(`/webhooks/${orgId}/${w}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
        })
        if (res.status >= 200 && res.status < 300) accepted.push(`${res.status} ${w}`)
      }
    }
    expect(accepted).toEqual([])
    // The in-tree push webhooks are among those refused.
    for (const w of ROUTE_ONLY) expect(registered).toContain(w)
  }, 120_000)
})
