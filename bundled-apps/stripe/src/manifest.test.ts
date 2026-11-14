// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { packageManifestSchema } from "@liaison/app-sdk"
import * as handlers from "../handlers"

const load = () =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"))

/** Every handler name the manifest references. */
function referencedHandlers(m: any): string[] {
  const out: string[] = []
  for (const t of Object.values<any>(m.tools ?? {})) if (t.handler) out.push(t.handler)
  for (const j of Object.values<any>(m.jobs ?? {})) out.push(j.handler)
  for (const w of Object.values<any>(m.webhooks ?? {})) out.push(w.handler, w.verify)
  for (const h of Object.values<any>(m.events?.subscribes ?? {})) out.push(h)
  return out
}

// A card number, a security code or a PAN, by name: `cardNumber`, `card_number`, `cvc`, `pan`, `panLast`, ...
const CARD_PARAM =
  /[cC]ard_?[nN]umber|[cC][vV][cC]|[cC][vV][vV]|(^|_)([pP]an|PAN)($|_|[A-Z])|Pan($|[A-Z_])|[eE]xpir/

describe("stripe manifest", () => {
  it("is at version 0.1.29", () => {
    expect(load().version).toBe("0.1.29")
  })

  it("paces Stripe calls with the connection's shared limits, never inside a run", () => {
    // Under Stripe's test-mode rate (25 a second), so every mode stays clear of a 429.
    expect(load().connections.stripe.limits).toEqual({ concurrency: 4, perSecond: 20, burst: 20 })
  })

  it("parses with the package manifest schema", () => {
    expect(packageManifestSchema.safeParse(load()).success).toBe(true)
  })

  it("the connection refuses a request to another host", () => {
    const m = load()
    // The only host any request may reach: the API itself, nothing for files, hosted pages or the dashboard.
    expect(m.connections.stripe.allowedDomains).toEqual(["api.stripe.com"])
    expect(m.network).toBeUndefined()
    expect(Object.keys(m.connections)).toEqual(["stripe"])
  })

  it("the connection stores a restricted key only, and the webhook secrets as app config", () => {
    const c = load().connections.stripe
    expect(c.type).toBe("credentials")
    expect(c.adminScope).toBe("stripe:admin:connection")
    expect(c.credentialFields).toHaveLength(1)
    expect(c.credentialFields[0]).toMatchObject({
      name: "restrictedKey",
      type: "password",
      label: "Restricted key",
    })
    expect(c.credentialFields[0].refusePattern.code).toBe("secret_key_refused")
    expect(c.appSecretConfigKeys).toEqual(["webhookSigningSecret", "webhookSigningSecretPrevious"])
  })

  it("the app declares no agent instructions", () => {
    expect(load().agentInstructions).toBeUndefined()
  })

  it("no tool takes a card number parameter", () => {
    for (const [name, t] of Object.entries<any>(load().tools ?? {})) {
      for (const p of Object.keys((t.params ?? t.parameters)?.properties ?? {})) {
        expect({ tool: name, param: p, card: CARD_PARAM.test(p) }).toEqual({
          tool: name,
          param: p,
          card: false,
        })
      }
    }
  })

  it("every handler the manifest names is exported", () => {
    for (const name of referencedHandlers(load())) {
      expect({ name, type: typeof (handlers as Record<string, unknown>)[name] }).toEqual({
        name,
        type: "function",
      })
    }
  })

  it("webhook events accept a body up to 5 MB and the probe is a declared job", () => {
    const m = load()
    expect(m.webhooks.events).toEqual({
      handler: "eventsHandler",
      verify: "stripeWebhookVerifier",
      bodyLimitBytes: 5242880,
    })
    expect(m.jobs[m.webhookHealth.probe]).toBeDefined()
  })

  it("every table declares its RLS scope", () => {
    const scopes = Object.fromEntries(
      Object.entries<any>(load().schema).map(([t, d]) => [t, d.rlsScope]),
    )
    expect(scopes).toEqual({
      stripe_customers: "customers",
      stripe_subscriptions: "subscriptions",
      stripe_invoices: "invoices",
      stripe_payments: "payments",
      stripe_refunds: "payments",
      stripe_disputes: "payments",
      stripe_mrr_events: "subscriptions",
      sync_state: "internal",
      install_metadata: "internal",
      webhook_deliveries: "internal",
    })
  })

  it("the member tier reads only: refunds, cancellations and the connection stay out of it", () => {
    const roles = load().roles
    for (const s of roles.member.scopes) expect(s).toMatch(/:read$/)
    for (const s of [
      "stripe:refunds:write",
      "stripe:subscriptions:write",
      "stripe:admin:connection",
    ]) {
      expect(roles.member.scopes).not.toContain(s)
    }
    expect(roles.billing.extends).toBe("member")
    expect(roles.admin.scopes).toContain("stripe:admin:connection")
  })

  it("a sync user id column is erased by anonymising it", () => {
    const f = load().schema.stripe_customers.fields.match_by
    expect(f).toEqual({ type: "uuid", required: false, userRef: true, onErase: "anonymize" })
  })

  it("uses the app SDK only", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"))
    // The UI's own libraries sit beside the SDK; nothing from the kernel's apps.
    expect(Object.keys(pkg.dependencies)).toEqual([
      "@liaison/app-sdk",
      "@liaison/app-ui",
      "@liaison/host",
      "solid-js",
    ])
  })
})
