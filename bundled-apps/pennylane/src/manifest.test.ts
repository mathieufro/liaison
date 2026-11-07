// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { packageManifestSchema } from "@liaison/app-sdk"
import * as handlers from "../handlers"

const MANIFEST_PATH = join(import.meta.dir, "..", "app.manifest.json")
const load = () => JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** The full text of the app guide: `agentInstructions` is now a short core plus tool-keyed
 *  sections (see apps/api/src/modules/agent/context/app-guide.ts), so a content assertion reads
 *  the core and every section together. A plain string guide is a core with no sections. */
const guideText = (m: unknown): string => {
  const ai = (m as { agentInstructions?: unknown }).agentInstructions
  if (typeof ai === "string") return ai
  if (ai && typeof ai === "object") {
    const g = ai as { core?: string; sections?: Array<{ text?: string }> }
    return [g.core ?? "", ...(g.sections ?? []).map((s) => s.text ?? "")].join("\n\n")
  }
  return ""
}

/** Opaque-param guard — copied verbatim from boxtal/src/manifest.test.ts. */
function findOpaqueParams(m: unknown): string[] {
  if (!isObj(m) || !isObj(m.tools)) return []
  const opaque: string[] = []
  const walk = (schema: unknown, path: string): void => {
    if (!isObj(schema)) return
    if (schema.type === "object") {
      const hasProps = isObj(schema.properties) && Object.keys(schema.properties).length > 0
      if (!hasProps && schema.additionalProperties !== true) opaque.push(`${path} (object)`)
    }
    if (schema.type === "array" && !isObj(schema.items)) opaque.push(`${path} (array)`)
    if (isObj(schema.properties))
      for (const [k, v] of Object.entries(schema.properties)) walk(v, `${path}.${k}`)
    if (isObj(schema.items)) walk(schema.items, `${path}[]`)
  }
  for (const [name, tool] of Object.entries(m.tools)) {
    if (!isObj(tool) || tool.agentVisible === false) continue
    const params = isObj(tool.params) ? tool.params : undefined
    const props = params && isObj(params.properties) ? params.properties : undefined
    if (props) for (const [k, v] of Object.entries(props)) walk(v, `${name}.${k}`)
  }
  return opaque
}

describe("pennylane app.manifest.json", () => {
  it("validates against packageManifestSchema (freeze-time zod)", () => {
    const r = packageManifestSchema.safeParse(load())
    if (!r.success) console.error(JSON.stringify(r.error.issues, null, 2))
    expect(r.success).toBe(true)
  })

  it("declares NO opaque object/array params on agent-visible tools", () => {
    expect(findOpaqueParams(load())).toEqual([])
  })

  it("is version 0.1.7, packageFormat 1, kebab name 'pennylane'", () => {
    const m = load() as { name: string; version: string; packageFormat: number }
    expect(m.name).toBe("pennylane")
    // 0.1.21: status-change items carry their own ack; listing narrows by kind.
    // 0.1.22: a 422 on send_to_pa that Pennylane does not show yet is unconfirmed, never failed.
    // 0.1.23: reception ops (catch-up, normalised received invoice, first-hop-only download, refuse/dispute),
    //   the real supplier bill import, and supplier_invoice_upload refuses a received e-invoice file.
    // 0.1.24: op errors answer with their own HTTP status (refusals 4xx, outage 502), not a blanket 500.
    // 0.1.25: the e-invoicing reads declare readOnly and the inbox ack its table.
    // 0.1.27: the webhook upstream probe is declared through webhookHealth.
    // 0.1.28: Edit credentials opens the kernel connect dialog over the settings page.
    // 0.1.29: a connector card on Settings > Connectors (declarative settings); no UI bundle.
    // 0.1.30: store listing (manifest `listing`: category, icon, summary, source repository).
    // 0.1.33: named after its provider: the listing summary says Pennylane.
    // 0.1.34: the manifest declares its host API range (`host: "^1"`) instead of sdkVersion.
    // 0.1.35: the icon as data (`iconName`), drawn when the UI runs framed.
    // 0.1.38: every HUMAN setup step says its own minutes.
    // 0.1.40: webhook health waits 3 h for a received e-invoice's delivery (deliveryGraceSec).
    // 0.1.41: the app's own install resolves the control-plane contract through an override
    // (the shared package depends on it by workspace protocol); no change to what it does.
    // 0.1.43: above 0.1.42, so an instance on either line of work upgrades; no change of its own.
    // 0.1.44: above both lines of work, which each changed it under the number before; no change of its own.
    // 0.1.45: the shared settings types it builds against changed; no change of its own.
    expect(m.version).toBe("0.1.45")
    expect(m.packageFormat).toBe(1)
  })

  // Settings overhaul P2: a connector, its settings a declarative card on
  // Settings > Connectors whose status line is a real cheap read.
  it("is a connector with a declarative settings card and no views.settings", () => {
    const m = load() as {
      kind?: string
      views?: { settings?: unknown }
      tools: Record<string, { readOnly?: boolean; gated?: boolean }>
      settings?: {
        sections: Array<{
          scope: string
          adminScope?: string
          titleKey?: string
          blocks: Array<{
            block: string
            names?: string[]
            status?: { tool: string; params?: Record<string, unknown> }
          }>
        }>
      }
    }
    expect(m.kind).toBe("connector")
    expect(m.views?.settings).toBeUndefined()
    const [section] = m.settings?.sections ?? []
    expect(section?.scope).toBe("org")
    expect(section?.adminScope).toBe("pennylane:admin:connection")
    expect(section?.titleKey).toBe("kernel.appSettings.pennylane.connectionTitle")
    const block = section?.blocks[0]
    expect(block).toEqual({
      block: "connections",
      names: ["pennylane"],
      status: { tool: "supplier_invoices_list", params: { limit: 1 } },
    })
    const probe = m.tools.supplier_invoices_list
    expect(probe?.readOnly).toBe(true)
    expect(probe?.gated).not.toBe(true)
  })

  it("declares a credentials connection with apiToken + scope fields (keyed on `name`)", () => {
    const conn = (
      load() as {
        connections?: Record<
          string,
          { type?: string; allowedDomains?: string[]; credentialFields?: { name: string }[] }
        >
      }
    ).connections?.pennylane
    expect(conn?.type).toBe("credentials")
    expect(conn?.allowedDomains).toContain("app.pennylane.com")
    const fields = (conn?.credentialFields ?? []).map((f) => f.name) // boxtal uses `name`, NOT `key`
    expect(fields).toEqual(expect.arrayContaining(["apiToken", "scope"]))
  })

  it("declares the nine read tools (gated≠true, scoped pennylane:*:read) + gated upload", () => {
    const tools = (
      load() as { tools: Record<string, { gated?: boolean; requiredScopes: string[]; handler: string }> }
    ).tools
    const reads = [
      "supplier_invoices_list",
      "supplier_invoice_get",
      "customer_invoices_list",
      "trial_balance_get",
      "pnl_summary",
      "cash_position",
      "transactions_list",
      "spend_by_category",
      "runway_estimate",
    ]
    for (const name of reads) {
      expect(tools[name], `tool ${name} missing`).toBeDefined()
      expect(tools[name]!.gated, `${name} must be a read (no gated:true)`).not.toBe(true)
      for (const scope of tools[name]!.requiredScopes) expect(scope).toMatch(/^pennylane:.*:read$/)
    }
    expect(tools.home_load).toBeDefined()
    expect(tools.supplier_invoice_upload?.gated).toBe(true)
  })

  it("every declared tool/event/job handler resolves from the handlers barrel", () => {
    const m = load() as {
      tools: Record<string, { handler: string }>
      events?: { subscribes?: Record<string, string> }
      jobs?: Record<string, { handler: string }>
    }
    const names = new Set<string>()
    for (const t of Object.values(m.tools)) names.add(t.handler)
    for (const v of Object.values(m.events?.subscribes ?? {})) names.add(v)
    for (const j of Object.values(m.jobs ?? {})) names.add(j.handler)
    for (const n of names)
      expect(typeof (handlers as Record<string, unknown>)[n], `handler ${n}`).toBe("function")
  })

  it("judges its webhooks by the upstream probe job, scheduled every 15 minutes", () => {
    const m = load() as {
      webhookHealth?: { probe: string | null; deliveryGraceSec?: number }
      jobs?: Record<
        string,
        { handler?: string; schedule?: string; runsFor?: { connection: string } }
      >
    }
    // Pennylane announces a received e-invoice well after the invoice's created_at (the time the
    // probe reports): in production one stayed undelivered 31 min and arrived over an hour later,
    // so the default 30 min grace paged on a working subscription. 3 h covers the observed delay
    // with room; a dead subscription is still caught the same afternoon.
    expect(m.webhookHealth).toEqual({
      probe: "probe-webhook-upstream",
      deliveryGraceSec: 10800,
    })
    expect(m.jobs?.["probe-webhook-upstream"]).toEqual({
      handler: "probeWebhookUpstreamJob",
      // Only for orgs with a Pennylane connection (manifest runsFor).
      runsFor: { connection: "pennylane" },
      schedule: "*/15 * * * *",
    })
    expect(typeof (handlers as Record<string, unknown>).probeWebhookUpstreamJob).toBe("function")
  })

  it("declares the pennylane scope set", () => {
    const m = load() as { scopes: string[] }
    for (const s of [
      "pennylane:invoices:read",
      "pennylane:reports:read",
      "pennylane:cash:read",
      "pennylane:invoices:write",
      "pennylane:admin:connection",
    ]) {
      expect(m.scopes).toContain(s)
    }
  })

  it("carries a non-empty agentInstructions guide", () => {
    const m = load() as { agentInstructions?: unknown }
    expect(typeof m.agentInstructions).toBe("object")
    expect(guideText(m).trim().length).toBeGreaterThan(40)
  })

  // Regression for received-vendor-invoices-impossible (BL-233): under sustained
  // "but these invoices hit my inbox / I received them by email" pressure, the
  // agent must HOLD the AP-store-as-source-of-truth line and state plainly that
  // items absent from the AP store are simply not booked payables — never abandon
  // the AP store for a lossy mail:search, and never invent sync/folder/ingestion
  // "missing data" excuses that imply the authoritative AP store is incomplete.
  it("agentInstructions tell the agent to HOLD the AP-store line under email-pressure (no sync/ingestion excuses)", () => {
    const a = guideText(load()).toLowerCase()
    // It must instruct holding the line under insistence...
    expect(a).toContain("hold the line")
    // ...framing absent items as not booked in the AP store (not a data gap)...
    expect(a).toContain("not booked")
    // ...and explicitly forbid sync/ingestion-style excuses that undermine the store.
    expect(a).toContain("sync/folder/ingestion")
  })

  it("every gated tool declares a summarizer that resolves to a real export (../handlers barrels ./summarizers)", () => {
    const m = load() as { tools: Record<string, { gated?: boolean; summarizer?: string }> }
    const gated = Object.entries(m.tools).filter(([, t]) => t.gated === true)
    expect(gated.length).toBeGreaterThan(0)
    for (const [name, tool] of gated) {
      expect(tool.summarizer, `${name} is gated but declares no summarizer`).toBeDefined()
      const fn = (handlers as Record<string, unknown>)[tool.summarizer as string]
      expect(
        typeof fn,
        `${name}'s summarizer "${tool.summarizer}" is not exported`,
      ).toBe("function")
    }
  })
})
