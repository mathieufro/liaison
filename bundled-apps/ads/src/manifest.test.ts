// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { packageManifestSchema } from "@liaison/app-sdk"

const MANIFEST_PATH = join(import.meta.dir, "..", "app.manifest.json")

function loadManifest(): unknown {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
}

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

/**
 * Returns the dotted paths of every OPAQUE param on an agent-visible tool — a `type:object`
 * with neither `properties` nor `additionalProperties:true`, or a `type:array` with no `items`
 * schema. Tools flagged `agentVisible:false` are system/internal and exempt.
 */
function findOpaqueParams(manifest: unknown): string[] {
  if (!isObj(manifest) || !isObj(manifest.tools)) return []
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
  for (const [name, tool] of Object.entries(manifest.tools)) {
    if (!isObj(tool) || tool.agentVisible === false) continue
    const params = isObj(tool.params) ? tool.params : undefined
    const props = params && isObj(params.properties) ? params.properties : undefined
    if (props) for (const [k, v] of Object.entries(props)) walk(v, `${name}.${k}`)
  }
  return opaque
}

describe("ads app.manifest.json", () => {
  it("parses as JSON", () => {
    expect(loadManifest()).toBeTypeOf("object")
  })

  // readOnly is what keeps a read from provisioning a connection thread, from
  // tainting the caller's scope, and from being refused on a read-only rerun, so
  // it means no table write AND no external state change a person could see.
  // insights_query's large/daily path POSTs an async report run to Meta and polls
  // it: a transient query job on the fixed Meta host, read back by this call only,
  // carrying the same kind of parameters graph_get already sends. Unmarked, the
  // Monday account review parked its own read for approval every week, so the
  // mark is back. metrics_list/metrics_run no longer seed a table.
  it("is version 0.1.49 and marks the weekly-review reads readOnly", () => {
    const m = loadManifest() as {
      version: string
      tools: Record<string, { readOnly?: boolean; writesToTable?: string }>
    }
    // 0.1.40: settings move to the declarative page (manifest `settings`).
    // 0.1.41: store listing (manifest `listing`: category, icon, summary, source repository).
    // 0.1.42: the Google connections name the account (Merchant Center account names).
    // 0.1.43: the manifest declares its host API range (`host: "^1"`) instead of sdkVersion.
    // 0.1.44: the icon as data (`iconName`), drawn when the UI runs framed; the UI reads the page's path with `currentPath()`.
    // 0.1.46: insights_query, metrics_list and metrics_run are readOnly (the review routine no longer parks them).
    // 0.1.47: no developer token (retired by Google 2026-09-09); google-config derives its identifier from customerId.
    // 0.1.49: every HUMAN setup step says its own minutes. The legacy developerToken is read without error and never threaded into the client.
    // 0.1.52: a bunfig.toml wires the Solid JSX preload for `bun test` run from the app dir.
    // 0.1.53: the app's own install resolves the control-plane contract through an override
    // (the shared package depends on it by workspace protocol); no change to what it does.
    // 0.1.55: above 0.1.54, so an instance on either line of work upgrades; no change of its own.
    // 0.1.56: above both lines of work, which each changed it under the number before; no change of its own.
    // 0.1.57: the shared settings types it builds against changed; no change of its own.
    // 0.1.58: tool_search no longer offers the approvals read; the agent uses the kernel's one.
    // 0.1.59: graph_get and google_search_terms read text people outside the org wrote (page
    // comments, the queries searchers typed), so a turn that read them is marked.
    // 0.1.60: its bundle carries host SDK 1.3.
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/)
    for (const name of ["insights_query", "metrics_list", "metrics_run"]) {
      expect(m.tools[name]?.readOnly).toBe(true)
      expect(m.tools[name]?.writesToTable).toBeUndefined()
    }
    // The mirror on both sides: a plain GET read carries the mark, a writer does not.
    expect(m.tools.campaigns_list?.readOnly).toBe(true)
    expect(m.tools.create_campaign?.readOnly).not.toBe(true)
  })

  // Settings > Apps labels each connection with its purpose and demotes the
  // optional ones (a bare "Connect" made a working app look uninstalled).
  it("declares what each connection connects, and which ones are optional", () => {
    const c = (
      loadManifest() as {
        connections: Record<string, { purpose?: string; optional?: boolean }>
      }
    ).connections
    expect(c.meta?.purpose).toBe("Meta ads account")
    expect(c.meta?.optional === true).toBe(false)
    expect(c.google?.purpose).toBe("Google Ads account")
    expect(c.google?.optional === true).toBe(false)
    expect(c.merchant?.purpose).toBe("Separate Merchant Center account")
    expect(c.merchant?.optional).toBe(true)
    expect(c["google-config"]?.purpose).toBe("Google Ads API settings")
    expect(c["google-config"]?.optional).toBe(true)
  })

  it("validates against packageManifestSchema", () => {
    const result = packageManifestSchema.safeParse(loadManifest())
    if (!result.success) {
      console.error("manifest validation failed:", JSON.stringify(result.error.issues, null, 2))
    }
    expect(result.success).toBe(true)
  })

  it("declares NO opaque object/array params on agent-visible tools", () => {
    expect(findOpaqueParams(loadManifest())).toEqual([])
  })

  it("events.emits entries match ^[a-z_]+:[a-z_]+$ (EVENT_PATTERN); only the P4 bulk-pause notification is app-prefixed", () => {
    const m = loadManifest() as { events: { emits: string[] } }
    const pattern = /^[a-z_]+:[a-z_]+$/
    // P1 events (campaign:created, ad:paused) are bare, cross-app-consumable
    // entity:action names by house convention. P4 adds `ads:bulk_pause_threshold` — a
    // deliberately APP-NAMESPACED notification-only event (spec §4.8): it is never a
    // routine trigger (no kind:'event' routine references it), so the app-prefix does
    // not collide with the routine event-resolution `app/entity:action` split. It still
    // satisfies EVENT_PATTERN (lowercase, one colon) — only the "no app prefix" house
    // convention is deliberately relaxed for this one entry.
    const ALLOWED_PREFIXED = new Set(["ads:bulk_pause_threshold"])
    for (const ev of m.events.emits) {
      expect(ev, `emit '${ev}' must match entity:action pattern`).toMatch(pattern)
      if (ALLOWED_PREFIXED.has(ev)) continue
      expect(ev.startsWith("ads:"), `emit '${ev}' must NOT have app prefix`).toBe(false)
    }
  })

  it("has NO capabilities block (or empty) — no messages.post, no bulk.fetch, no agent.run", () => {
    const m = loadManifest() as Record<string, unknown>
    const caps = m.capabilities
    // capabilities must be absent OR empty
    if (caps !== undefined) {
      expect(Array.isArray(caps)).toBe(true)
      expect((caps as string[]).length).toBe(0)
    }
    // The manifest JSON string must not contain these capability strings
    const raw = JSON.stringify(m)
    expect(raw).not.toContain('"messages.post"')
    expect(raw).not.toContain('"bulk.fetch"')
  })

  it("has a top-level agentInstructions guide (always-injected honesty framing)", () => {
    const m = loadManifest() as Record<string, unknown>
    expect(typeof m.agentInstructions).toBe("object")
    expect(guideText(m).length).toBeGreaterThan(50)
  })

  it("agentInstructions contains load-bearing honesty substrings", () => {
    const ai = guideText(loadManifest())
    expect(ai).toContain("effective_status")
    expect(ai).toContain("1487632") // the exact budget-cap subcode
    expect(ai).toContain("blended") // blended ROAS framing
    expect(ai).toContain("minor") // minor units
    expect(ai).toMatch(/sensitive/i) // sensitive attribute refusal
  })

  it("structural cross-field check: every kind:'event' routine has event app-segment === 'ads' AND entity:action in events.emits", () => {
    // mirrors contract.ts:617-629 to surface the red here rather than only at install
    const m = loadManifest() as {
      routines?: Record<string, { kind?: string; event?: string }>
      events: { emits: string[] }
    }
    const emitsSet = new Set(m.events.emits)
    for (const [name, routine] of Object.entries(m.routines ?? {})) {
      if (routine.kind !== "event") continue
      const ev = routine.event ?? ""
      const parts = ev.split("/")
      expect(parts.length, `routine '${name}' event must have 3 segments (app/entity:action)`).toBe(
        2,
      )
      const [appSeg, entityAction] = parts
      expect(appSeg, `routine '${name}' event app-segment must be 'ads'`).toBe("ads")
      expect(
        emitsSet.has(entityAction ?? ""),
        `routine '${name}' event entity:action '${entityAction}' must be in events.emits`,
      ).toBe(true)
    }
  })

  // ─── Task 4 pins ─────────────────────────────────────────────────────────

  it("declares connections.meta as type 'credentials' with graph.facebook.com in allowedDomains", () => {
    const m = loadManifest() as {
      connections: Record<string, { type: string; allowedDomains?: string[] }>
    }
    const meta = m.connections?.meta
    expect(meta, "connections.meta must exist").toBeDefined()
    expect(meta?.type).toBe("credentials")
    expect(meta?.allowedDomains).toContain("graph.facebook.com")
  })

  it("connections.meta has the three required credentialFields (keyed by `name`, the runtime schema field): accessToken, adAccountId, defaultPageId", () => {
    const m = loadManifest() as {
      connections: Record<
        string,
        {
          credentialFields?: Array<{
            name: string
            type: string
            label: string
            required?: boolean
          }>
        }
      >
    }
    const fields = m.connections?.meta?.credentialFields ?? []
    // Runtime credentialFieldSchema requires `name` (not `key`) + label + type.
    for (const f of fields) {
      expect(typeof f.name, `credentialField must use 'name': ${JSON.stringify(f)}`).toBe("string")
      expect(typeof f.label).toBe("string")
    }
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]))
    expect(byName.accessToken?.type).toBe("password")
    expect(byName.adAccountId?.type).toBe("text")
    expect(byName.defaultPageId?.type).toBe("text")
    // defaultPageId is optional (required:false or absent)
    expect(byName.defaultPageId?.required).not.toBe(true)
  })

  it("connections.meta.setupGuide is an OBJECT with a summary (runtime schema requires object, not string)", () => {
    const m = loadManifest() as {
      connections: Record<string, { setupGuide?: unknown }>
    }
    const guide = m.connections?.meta?.setupGuide
    expect(typeof guide).toBe("object")
    expect(guide).not.toBeNull()
    expect(typeof (guide as { summary?: unknown }).summary).toBe("string")
  })

  it("top-level scopes[] deep-equals the canonical §3.0 list (no stray scopes like ads:config)", () => {
    const m = loadManifest() as { scopes: string[] }
    expect(m.scopes).toEqual([
      "ads:insights:read",
      "ads:campaigns:read",
      "ads:campaigns:write",
      "ads:adsets:write",
      "ads:ads:write",
      "ads:audiences:read",
      "ads:audiences:write",
      "ads:admin:connection",
      "ads:internal",
      "ads:approve",
      "ads:google:read",
      "ads:google:pause",
      "ads:google:write",
      "ads:merchant:read",
    ])
  })

  // ─── Roles: auto-maintained Full Member reconciler contract ───────────────

  it("declares admin + member roles; member is the non-privileged operational tier", () => {
    const m = loadManifest() as {
      scopes: string[]
      roles?: Record<string, { description?: string; scopes: string[] }>
    }
    const roles = m.roles
    expect(
      roles,
      "manifest must declare roles: extendFullMemberRole grants the member tier to the auto-maintained Full Member role",
    ).toBeDefined()
    expect(Object.keys(roles ?? {}).sort()).toEqual(["admin", "member"])

    const admin = roles?.admin
    const member = roles?.member
    for (const r of [admin, member]) {
      expect(typeof r?.description).toBe("string")
      expect((r?.description ?? "").length).toBeGreaterThan(0)
    }

    // admin holds the full declared scope set.
    expect([...(admin?.scopes ?? [])].sort()).toEqual([...m.scopes].sort())

    // No phantom scopes: every role scope is a declared top-level scope.
    for (const s of [...(admin?.scopes ?? []), ...(member?.scopes ?? [])]) {
      expect(m.scopes, `role scope ${s} must be declared in top-level scopes[]`).toContain(s)
    }

    // member is exactly the declared set minus the two privileged tiers. This
    // is the precise set non-admin Full Members receive, so account connection
    // and spend approval must never leak in, and ads:internal (app visibility +
    // internal reads) must be present.
    const privileged = ["ads:admin:connection", "ads:approve"]
    const expectedMember = m.scopes.filter((s) => !privileged.includes(s))
    expect([...(member?.scopes ?? [])].sort()).toEqual([...expectedMember].sort())
    expect(member?.scopes).toContain("ads:internal")
    for (const p of privileged) {
      expect(member?.scopes, `member tier must NOT include ${p}`).not.toContain(p)
    }
  })

  // ─── P4: Google + Merchant connections ────────────────────────────────────

  it("declares connections.google as type 'oauth2' with adwords+content scopes, three allowedDomains, offline/consent extraParams", () => {
    const m = loadManifest() as {
      connections: Record<
        string,
        {
          type: string
          scopes?: string[]
          allowedDomains?: string[]
          extraParams?: Record<string, string>
        }
      >
    }
    const google = m.connections?.google
    expect(google, "connections.google must exist").toBeDefined()
    expect(google?.type).toBe("oauth2")
    expect(google?.scopes).toContain("https://www.googleapis.com/auth/adwords")
    expect(google?.scopes).toContain("https://www.googleapis.com/auth/content")
    expect(google?.allowedDomains).toContain("googleads.googleapis.com")
    expect(google?.allowedDomains).toContain("merchantapi.googleapis.com")
    expect(google?.allowedDomains).toContain("oauth2.googleapis.com")
    expect(google?.extraParams?.access_type).toBe("offline")
    expect(google?.extraParams?.prompt).toBe("consent")
  })

  it("declares connections.google-config as type 'credentials' with the four Google Ads/Merchant config fields", () => {
    const m = loadManifest() as {
      connections: Record<
        string,
        { type: string; credentialFields?: Array<{ name: string; type: string }> }
      >
    }
    const cfg = m.connections?.["google-config"]
    expect(cfg, "connections.google-config must exist").toBeDefined()
    expect(cfg?.type).toBe("credentials")
    const byName = Object.fromEntries((cfg?.credentialFields ?? []).map((f) => [f.name, f]))
    expect(byName.developerToken?.type).toBe("password")
    expect(byName.loginCustomerId?.type).toBe("text")
    expect(byName.customerId?.type).toBe("text")
    expect(byName.merchantId?.type).toBe("text")
  })

  it("google-config: developer token optional, identifier from customerId, guide sends to Cloud console Explorer access (never API Center)", () => {
    const m = loadManifest() as {
      connections: Record<
        string,
        {
          identifierVar?: string
          credentialFields?: Array<{ name: string; required?: boolean }>
          setupGuide?: { summary?: string; steps?: Array<string | { text: string }> }
        }
      >
    }
    const cfg = m.connections["google-config"]
    const byName = Object.fromEntries((cfg?.credentialFields ?? []).map((f) => [f.name, f]))
    expect(byName.developerToken?.required).toBe(false)
    expect(byName.loginCustomerId?.required).not.toBe(false)
    expect(byName.customerId?.required).not.toBe(false)
    // `liaison config apply` derives the connection identifier (no explicit `identifier` needed).
    expect(cfg?.identifierVar).toBe("customerId")
    const guide = [
      cfg?.setupGuide?.summary ?? "",
      ...(cfg?.setupGuide?.steps ?? []).map((s) => (typeof s === "string" ? s : s.text)),
    ].join("\n")
    expect(guide).toContain("https://console.cloud.google.com/google/ads-apis/overview")
    expect(guide).toContain("Apply for access")
    expect(guide).toContain("Explorer")
    expect(guide).not.toMatch(/aw\/apicenter/)
    // The old instruction is gone; the API Center link is named only as the one NOT to use.
    expect(guide).not.toMatch(/apply there for Basic access/i)
    expect(guide).toContain("App Conversion Tracking")
    expect(guide).not.toMatch(/developer token\b[^.]*\b(copy|enter|paste)/i)
    expect(guide).toMatch(/optional/i)
    // Recognising a manager account, and the ids read from a screenshot of a named page.
    expect(guide).toContain("Manager account settings")
    expect(guide).toContain("(This manager)")
    expect(guide).toContain("https://ads.google.com/aw/accounts")
    expect(guide).toMatch(/screenshot/i)
    // Merchant Center only for Google Shopping sellers.
    expect(guide).toContain("Google Shopping")
  })

  // ─── P4 batch 2: Google Ads read tools + google_pause + Merchant reads ────

  it("declares the 7 Google Ads read tools with scope ads:google:read, ungated", () => {
    const m = loadManifest() as {
      tools: Record<string, { requiredScopes?: string[]; gated?: boolean; handler?: string }>
    }
    const GOOGLE_READ_TOOLS = [
      "google_campaigns_list",
      "google_adgroups_list",
      "google_ads_list",
      "google_insights_query",
      "google_account_info",
      "google_search_terms",
      "google_recommendations_list",
    ]
    for (const name of GOOGLE_READ_TOOLS) {
      const tool = m.tools[name]
      expect(tool, `tools.${name} must exist`).toBeDefined()
      expect(tool?.requiredScopes).toEqual(["ads:google:read"])
      expect(tool?.gated).not.toBe(true)
      expect(tool?.handler).toBe(name)
    }
  })

  it("both pause tools also require ads:internal, the scope of the pause_ledger they write after the provider call", () => {
    // Without it a caller holding only the write scope paused the ad at the provider,
    // then failed to record it: the ledger is what tells a later resume what we paused.
    const m = loadManifest() as { tools: Record<string, { requiredScopes?: string[] }> }
    expect(m.tools.pause?.requiredScopes).toEqual(["ads:campaigns:write", "ads:internal"])
    expect(m.tools.google_pause?.requiredScopes).toEqual(["ads:google:pause", "ads:internal"])
  })

  it("declares google_pause with scopes ads:google:pause + ads:internal, GATED, with its summarizer", () => {
    const m = loadManifest() as {
      tools: Record<
        string,
        {
          requiredScopes?: string[]
          gated?: boolean
          trustBoundary?: string
          summarizer?: string
          handler?: string
        }
      >
    }
    const tool = m.tools.google_pause
    expect(tool, "tools.google_pause must exist").toBeDefined()
    expect(tool?.requiredScopes).toEqual(["ads:google:pause", "ads:internal"])
    expect(tool?.gated).toBe(true)
    expect(tool?.trustBoundary).toBe("user")
    expect(tool?.summarizer).toBe("summarizeGooglePause")
    expect(tool?.handler).toBe("google_pause")
  })

  it("declares pause (Meta) GATED with its summarizer — all pauses are approval-gated", () => {
    const m = loadManifest() as {
      tools: Record<
        string,
        {
          requiredScopes?: string[]
          gated?: boolean
          trustBoundary?: string
          summarizer?: string
          handler?: string
        }
      >
    }
    const tool = m.tools.pause
    expect(tool, "tools.pause must exist").toBeDefined()
    expect(tool?.gated).toBe(true)
    expect(tool?.trustBoundary).toBe("user")
    expect(tool?.summarizer).toBe("summarizePause")
    expect(tool?.handler).toBe("pause")
  })

  it("the removed stock-aware auto-pause surface is gone from the manifest", () => {
    const m = loadManifest() as {
      tools: Record<string, unknown>
      schema: Record<string, unknown>
      events: { emits: string[]; subscribes?: Record<string, string> }
    }
    expect(m.tools.map_product_ads).toBeUndefined()
    expect(m.tools.list_product_ads).toBeUndefined()
    expect(m.schema.product_ad_map).toBeUndefined()
    expect(m.events.emits).not.toContain("stock:low")
    expect(m.events.subscribes ?? {}).not.toHaveProperty("shopify/inventory:low")
  })

  it("declares the 2 Merchant Center read tools with scope ads:merchant:read, ungated", () => {
    const m = loadManifest() as {
      tools: Record<string, { requiredScopes?: string[]; gated?: boolean; handler?: string }>
    }
    for (const name of ["merchant_feed_status", "merchant_product_issues"]) {
      const tool = m.tools[name]
      expect(tool, `tools.${name} must exist`).toBeDefined()
      expect(tool?.requiredScopes).toEqual(["ads:merchant:read"])
      expect(tool?.gated).not.toBe(true)
      expect(tool?.handler).toBe(name)
    }
  })

  it("pause_ledger schema carries the optional object_type field (Google pause taxonomy)", () => {
    const m = loadManifest() as { schema: Record<string, { fields?: Record<string, string> }> }
    expect(m.schema.pause_ledger?.fields?.object_type).toBe("string?")
  })

  it("events.emits includes ads:bulk_pause_threshold", () => {
    const m = loadManifest() as { events: { emits: string[] } }
    expect(m.events.emits).toContain("ads:bulk_pause_threshold")
  })

  it("agentInstructions carries the Google micros rule and the Merchant product-data split marker", () => {
    const ai = guideText(loadManifest())
    expect(ai).toContain("MICROS")
    expect(ai).toContain("PRODUCT-DATA")
    expect(ai).toContain("NON-PRODUCT-DATA")
  })

  it("agentInstructions' micros rule names the correct divisor (1,000,000 — never /100, that's the Meta minor-unit path)", () => {
    const ai = guideText(loadManifest())
    expect(ai).toContain("1,000,000")
  })

  it("every write tool has gated:true AND trustBoundary:'user' (manifest-level pin)", () => {
    const m = loadManifest() as {
      tools: Record<string, { gated?: boolean; trustBoundary?: string }>
    }
    const WRITE_TOOLS = [
      "create_campaign",
      "create_adset",
      "create_ad",
      "create_creative",
      "upload_image",
      "update_budget",
      "set_status",
      "create_custom_audience",
      "create_lookalike_audience",
      "add_users_to_audience",
    ]
    for (const name of WRITE_TOOLS) {
      const tool = m.tools[name]
      expect(tool?.gated, `${name} must have gated:true`).toBe(true)
      expect(tool?.trustBoundary, `${name} must have trustBoundary:'user'`).toBe("user")
    }
  })

  it("create_campaign requires special_ad_categories (P1: force the agent to pass it; Meta 400s on absence)", () => {
    const m = loadManifest() as {
      tools: Record<string, { params?: { required?: string[] } }>
    }
    const required = m.tools.create_campaign?.params?.required ?? []
    expect(required).toContain("special_ad_categories")
    expect(required).toContain("name")
    expect(required).toContain("objective")
  })

  it("budget text-widget editableFields reference a string-typed param (runtime cross-field rule)", () => {
    const m = loadManifest() as {
      tools: Record<
        string,
        {
          params?: { properties?: Record<string, { type?: string }> }
          editableFields?: Array<{ field: string; widget: string }>
        }
      >
    }
    for (const [toolName, tool] of Object.entries(m.tools)) {
      for (const ef of tool.editableFields ?? []) {
        if (ef.widget === "text" || ef.widget === "richtext") {
          expect(
            tool.params?.properties?.[ef.field]?.type,
            `${toolName}.editableFields '${ef.field}' (${ef.widget}) needs params.properties.${ef.field}.type === 'string'`,
          ).toBe("string")
        }
      }
    }
  })

  // ─── Task 4b pins ────────────────────────────────────────────────────────

  it("dependencies.optional includes 'shopify' (A16: P1/P2 are standalone; only P3 cross-app needs shopify)", () => {
    // Amendment A16 — shopify is an OPTIONAL dep, not required. A REQUIRED dep is
    // hard-rejected at install when absent (resolver.ts:47-60 → silent unregister),
    // which would make every ads scenario run TOOLLESS in a world without
    // shopify. As optional, ads registers regardless, and the cross-app event
    // subscription still wires (runtime.ts:1086-1097 accepts a source app in EITHER
    // required OR optional).
    const m = loadManifest() as { dependencies: { optional?: string[]; required?: string[] } }
    expect(m.dependencies?.optional).toContain("shopify")
    expect(m.dependencies?.required ?? []).not.toContain("shopify")
  })

  it("cross_app_calls declares all four Shopify read targets with non-empty reasons", () => {
    const m = loadManifest() as { cross_app_calls: Array<{ target: string; reason: string }> }
    const targets = new Set((m.cross_app_calls ?? []).map((c) => c.target))
    const required = [
      "shopify:orders_search",
      "shopify:refunds_get",
      "shopify:inventory_levels_list",
      "shopify:customers_search",
    ]
    for (const t of required) {
      expect(targets.has(t), `cross_app_calls missing target: ${t}`).toBe(true)
    }
    // Every entry must have a non-empty reason
    for (const entry of m.cross_app_calls ?? []) {
      expect(
        entry.reason.length,
        `cross_app_calls entry '${entry.target}' has no reason`,
      ).toBeGreaterThan(0)
    }
  })

  it("cross_app_calls targets satisfy both manifest-schema and package-format patterns (lowercase-first tool segment, no dots)", () => {
    const m = loadManifest() as { cross_app_calls: Array<{ target: string }> }
    // Intersection of manifest-schema ^[a-z][a-z0-9_-]*:[a-zA-Z][a-zA-Z0-9_]*$
    // AND package-format ^[a-z][a-z0-9_-]*:[a-z][a-zA-Z0-9_.]*$
    // The intersection: lowercase-first tool segment
    const intersectionPattern = /^[a-z][a-z0-9_-]*:[a-z][a-zA-Z0-9_]*$/
    for (const entry of m.cross_app_calls ?? []) {
      expect(
        entry.target,
        `cross_app_calls target '${entry.target}' fails intersection pattern`,
      ).toMatch(intersectionPattern)
    }
  })

  // Task 6: every write tool has gated:true + trustBoundary:"user" + approvalCard + summarizer
  // Task 7: pause has NO gated:true; map_product_ads scope; both table schemas declared
  // Task 8: events.subscribes shopify/inventory:low; events.emits includes stock:low

  // ─── Task 9: Recurring routines pins ───────────────────────────────────────
  //
  // NOTE: Full routine tick execution is scenario-verified post-build (Amendment A11).
  // These pins only validate manifest shape — not handler execution.

  // P6 disposition: weekly-performance-digest + weekly-roas-digest RETIRED
  // (superseded by weekly-account-review, which covers both platforms + blended
  // MER + experiments + anomalies). low-roas-autopause KEPT + generalized to
  // Google. restock-resume KEPT unchanged. See p6-blueprint.md §2.

  it("declares the net routine set: weekly-account-review, monthly-deep-review, low-roas-autopause (restock-resume removed with auto-pause)", () => {
    const m = loadManifest() as { routines: Record<string, unknown> }
    expect(m.routines).toBeDefined()
    const names = Object.keys(m.routines ?? {})
    expect(names).toContain("weekly-account-review")
    expect(names).toContain("monthly-deep-review")
    expect(names).toContain("low-roas-autopause")
    expect(names).not.toContain("restock-resume")
  })

  it("retired templates (weekly-performance-digest, weekly-roas-digest) no longer exist", () => {
    const m = loadManifest() as { routines: Record<string, unknown> }
    const names = Object.keys(m.routines ?? {})
    expect(names).not.toContain("weekly-performance-digest")
    expect(names).not.toContain("weekly-roas-digest")
  })

  it("all 3 routines have kind:'recurring'", () => {
    const m = loadManifest() as { routines: Record<string, { kind: string }> }
    for (const name of ["weekly-account-review", "monthly-deep-review", "low-roas-autopause"]) {
      expect(m.routines[name]?.kind, `${name} kind`).toBe("recurring")
    }
  })

  it("all 3 routines have enabledByDefault:false", () => {
    const m = loadManifest() as { routines: Record<string, { enabledByDefault: boolean }> }
    for (const name of ["weekly-account-review", "monthly-deep-review", "low-roas-autopause"]) {
      expect(m.routines[name]?.enabledByDefault, `${name} enabledByDefault`).toBe(false)
    }
  })

  it("weekly-account-review: cron '0 9 * * 1', timezone Europe/Paris, both-platform + lab scopes", () => {
    const m = loadManifest() as {
      routines: Record<string, { cron: string; timezone: string; scopes: string[] }>
    }
    const r = m.routines["weekly-account-review"]
    expect(r?.cron).toBe("0 9 * * 1")
    expect(r?.timezone).toBe("Europe/Paris")
    expect(r?.scopes).toContain("ads:insights:read")
    expect(r?.scopes).toContain("ads:campaigns:read")
    expect(r?.scopes).toContain("ads:google:read")
    expect(r?.scopes).toContain("shopify:orders:read")
  })

  it("weekly-account-review prompt carries the tier-1 honesty doctrine markers verbatim", () => {
    const m = loadManifest() as { routines: Record<string, { promptTemplate: string }> }
    const body = m.routines["weekly-account-review"]?.promptTemplate ?? ""
    expect(body).toContain("unaudited")
    expect(body).toContain("directional")
    expect(body.toLowerCase()).toContain("below the minimum-sample floor")
    expect(body.toLowerCase()).toContain("inconclusive")
    expect(body).toContain("experiment_list")
    expect(body).toContain("metrics_run")
  })

  it("monthly-deep-review: cron '0 9 1 * *', timezone Europe/Paris, read + gated-write scopes", () => {
    const m = loadManifest() as {
      routines: Record<string, { cron: string; timezone: string; scopes: string[] }>
    }
    const r = m.routines["monthly-deep-review"]
    expect(r?.cron).toBe("0 9 1 * *")
    expect(r?.timezone).toBe("Europe/Paris")
    expect(r?.scopes).toContain("ads:campaigns:write")
    expect(r?.scopes).toContain("ads:google:write")
  })

  it("monthly-deep-review prompt stages a gated write as a draft approval, never executes spend", () => {
    const m = loadManifest() as { routines: Record<string, { promptTemplate: string }> }
    const body = m.routines["monthly-deep-review"]?.promptTemplate ?? ""
    expect(body).toContain("unaudited")
    expect(body).toContain("directional")
    expect(body.toLowerCase()).toContain("inconclusive")
    expect(body).toContain("experiment_list")
    expect(body).toContain("experiment_open")
    expect(body).toContain("pending approval")
  })

  it("low-roas-autopause: generalized to sweep Google (google_insights_query + google_pause), budget raises stay gated", () => {
    const m = loadManifest() as {
      routines: Record<string, { scopes: string[]; promptTemplate: string }>
    }
    const r = m.routines["low-roas-autopause"]
    expect(r?.scopes).toContain("ads:campaigns:write")
    expect(r?.scopes).toContain("ads:insights:read")
    expect(r?.scopes).toContain("shopify:orders:read")
    expect(r?.scopes).toContain("ads:google:read")
    expect(r?.scopes).toContain("ads:google:pause")
    expect(r?.promptTemplate).toContain("google_insights_query")
    expect(r?.promptTemplate).toContain("google_pause")
    expect(r?.promptTemplate).toContain("NEVER auto-raise budget")
  })

  it("restock-resume routine is removed (its only purpose was resuming auto-paused ads)", () => {
    const m = loadManifest() as { routines: Record<string, unknown> }
    expect(m.routines["restock-resume"]).toBeUndefined()
  })

  it("low-roas-autopause prompt no longer references product_ad_map and treats pauses as gated proposals", () => {
    const m = loadManifest() as { routines: Record<string, { promptTemplate: string }> }
    const body = m.routines["low-roas-autopause"]?.promptTemplate ?? ""
    expect(body).not.toContain("product_ad_map")
    expect(body).toContain("GATED")
    expect(body).not.toContain("both ungated, execute immediately")
  })

  it("agentInstructions rule 10 no longer names a retired template, points at weekly-account-review", () => {
    const m = loadManifest()
    expect(guideText(m)).not.toContain("weekly-roas-digest")
    expect(guideText(m)).not.toContain("weekly-performance-digest")
    expect(guideText(m)).toContain("weekly-account-review")
  })

  it("no retired template key survives anywhere in the manifest (skills bodies included)", () => {
    const raw = readFileSync(MANIFEST_PATH, "utf8")
    expect(raw).not.toContain("weekly-roas-digest")
    expect(raw).not.toContain("weekly-performance-digest")
  })

  // ─── Task 10: agentInstructions + skill pins ──────────────────────────────

  it("agentInstructions contains 'effective_status'", () => {
    const m = loadManifest()
    expect(guideText(m)).toContain("effective_status")
  })

  it("agentInstructions contains '1487632' (exact 613+subcode — not just bare 613)", () => {
    const m = loadManifest()
    expect(guideText(m)).toContain("1487632")
  })

  it("agentInstructions contains 'blended'", () => {
    const m = loadManifest()
    expect(guideText(m)).toContain("blended")
  })

  it("agentInstructions contains 'minor' (minor units rule)", () => {
    const m = loadManifest()
    expect(guideText(m).toLowerCase()).toContain("minor")
  })

  it("agentInstructions contains 'sensitive' (sensitive-attribute refusal)", () => {
    const m = loadManifest()
    expect(guideText(m).toLowerCase()).toContain("sensitive")
  })

  // ─── Task 4: Tier-1 platform-neutral doctrine markers ─────────────────────
  //
  // The doctrine block interleaves platform-neutral advertising-science doctrine
  // with the existing Meta operational rules. These markers pin each hard rule
  // (spec Tier 1) so a rewrite that drops one goes red. Doctrine paragraphs are
  // platform-neutral for verbatim P4 lift into the generic `ads` app.

  it("agentInstructions doctrine: trust hierarchy (unaudited + blended MER)", () => {
    const ai = guideText(loadManifest())
    expect(ai).toContain("unaudited")
    expect(ai).toContain("blended MER")
  })

  it("agentInstructions doctrine: regime-first (regime + actual spend)", () => {
    const ai = guideText(loadManifest())
    expect(ai).toContain("regime")
    expect(ai).toContain("actual spend")
  })

  it("agentInstructions doctrine: statistical honesty (directional + minimum sample + inconclusive)", () => {
    const ai = guideText(loadManifest())
    expect(ai).toContain("directional")
    expect(ai).toContain("minimum sample")
    expect(ai).toContain("inconclusive")
  })

  it("agentInstructions doctrine: DTC/wholesale split (B2B + conversion feed)", () => {
    const ai = guideText(loadManifest())
    expect(ai).toContain("B2B")
    expect(ai).toContain("conversion feed")
  })

  it("agentInstructions doctrine: GDPR floor (consent)", () => {
    const ai = guideText(loadManifest())
    expect(ai).toContain("consent")
  })

  it("agentInstructions doctrine: experiment discipline (decision date + before proposing)", () => {
    const ai = guideText(loadManifest())
    expect(ai).toContain("decision date")
    expect(ai).toContain("before proposing")
  })

  it("agentInstructions still carries existing operational markers (effective_status, 1487632, blended)", () => {
    const ai = guideText(loadManifest())
    expect(ai).toContain("effective_status")
    expect(ai).toContain("1487632")
    expect(ai).toContain("blended")
  })

  it("ads-playbook skill exists with kind:'guide' and enabledByDefault:true", () => {
    const m = loadManifest() as {
      skills: Record<string, { kind: string; enabledByDefault: boolean; body: string }>
    }
    const skill = m.skills?.["ads-playbook"]
    expect(skill).toBeDefined()
    expect(skill?.kind).toBe("guide")
    expect(skill?.enabledByDefault).toBe(true)
  })

  it("ads-playbook skill body contains 'effective_status'", () => {
    const m = loadManifest() as { skills: Record<string, { body: string }> }
    expect(m.skills?.["ads-playbook"]?.body).toContain("effective_status")
  })

  it("ads-playbook skill body contains '1487632' (subcode — not just bare 613)", () => {
    const m = loadManifest() as { skills: Record<string, { body: string }> }
    expect(m.skills?.["ads-playbook"]?.body).toContain("1487632")
  })

  it("ads-playbook skill body contains 'blended'", () => {
    const m = loadManifest() as { skills: Record<string, { body: string }> }
    expect(m.skills?.["ads-playbook"]?.body).toContain("blended")
  })

  it("ads-playbook skill body contains 'special_ad_categories'", () => {
    const m = loadManifest() as { skills: Record<string, { body: string }> }
    expect(m.skills?.["ads-playbook"]?.body).toContain("special_ad_categories")
  })

  it("ads-playbook skill body contains 'SHA-256' (PII hashing)", () => {
    const m = loadManifest() as { skills: Record<string, { body: string }> }
    expect(m.skills?.["ads-playbook"]?.body).toContain("SHA-256")
  })

  it("ads-playbook skill body contains 'Business Manager' (billing limitation)", () => {
    const m = loadManifest() as { skills: Record<string, { body: string }> }
    expect(m.skills?.["ads-playbook"]?.body).toContain("Business Manager")
  })

  it("ads-playbook skill body contains 'sensitive'", () => {
    const m = loadManifest() as { skills: Record<string, { body: string }> }
    expect(m.skills?.["ads-playbook"]?.body.toLowerCase()).toContain("sensitive")
  })

  // ─── Tier-2 playbooks: 9 generated skills + existing ads-playbook ───

  const TIER2_PLAYBOOK_NAMES = [
    "01-account-structure-by-budget",
    "02-creative-strategy",
    "03-audience-doctrine",
    "04-testing-and-measurement",
    "05-high-aov-funnel",
    "06-scaling-and-kill-rules",
    "07-google-specifics",
    "08-merchant-feed-health",
    "09-budget-allocation-brand-activation",
  ]

  it("has exactly 10 skills: ads-playbook + the 9 Tier-2 playbooks", () => {
    const m = loadManifest() as { skills: Record<string, unknown> }
    const names = Object.keys(m.skills)
    expect(names.sort()).toEqual(["ads-playbook", ...TIER2_PLAYBOOK_NAMES].sort())
  })

  it("every Tier-2 playbook skill has kind:'playbook', enabledByDefault:false, non-empty body, description <=100 chars", () => {
    const m = loadManifest() as {
      skills: Record<
        string,
        {
          kind: string
          enabledByDefault: boolean
          body: string
          description: string
          requiredScopes?: string[]
        }
      >
    }
    for (const name of TIER2_PLAYBOOK_NAMES) {
      const skill = m.skills[name]
      expect(skill, `skill '${name}' must exist`).toBeDefined()
      expect(skill?.kind, `${name}.kind`).toBe("playbook")
      expect(skill?.enabledByDefault, `${name}.enabledByDefault`).toBe(false)
      expect(skill?.body.length, `${name}.body must be non-empty`).toBeGreaterThan(0)
      expect(skill?.description.length, `${name}.description length`).toBeGreaterThanOrEqual(1)
      expect(skill?.description.length, `${name}.description length`).toBeLessThanOrEqual(100)
    }
  })

  it("every Tier-2 playbook requiredScopes is a non-empty subset of the top-level scopes[] array", () => {
    const m = loadManifest() as {
      scopes: string[]
      skills: Record<string, { requiredScopes?: string[] }>
    }
    for (const name of TIER2_PLAYBOOK_NAMES) {
      const scopes = m.skills[name]?.requiredScopes ?? []
      expect(scopes.length, `${name}.requiredScopes must be non-empty`).toBeGreaterThan(0)
      for (const scope of scopes) {
        expect(
          m.scopes,
          `${name}.requiredScopes contains '${scope}' not declared in top-level scopes[]`,
        ).toContain(scope)
      }
    }
  })

  // ─── P5 T1: lab tables (experiments, manual_spend, dealer_profiles) ───

  describe("P5 lab tables schema", () => {
    it("declares experiments with rlsScope:internal, its fields+enums, and indexes [status]/[decision_date]", () => {
      const m = loadManifest() as {
        schema: Record<
          string,
          { rlsScope?: string; fields?: Record<string, unknown>; indexes?: string[][] }
        >
      }
      const t = m.schema.experiments
      expect(t, "experiments table must exist").toBeDefined()
      expect(t?.rlsScope).toBe("internal")
      const f = t?.fields ?? {}
      expect(f.title).toBe("string")
      expect(f.hypothesis).toBe("string")
      expect(f.platforms).toBe("string")
      expect((f.metric_tier as { type: string; enum: string[] })?.enum?.sort()).toEqual(
        ["upper_funnel", "purchase", "blended"].sort(),
      )
      expect(f.primary_metric).toBe("string")
      expect(f.variants).toBe("string")
      expect(f.start_date).toBe("date?")
      expect(f.decision_date).toBe("date?")
      expect(f.minimum_sample).toBe("number?")
      expect((f.status as { type: string; enum: string[] })?.enum?.sort()).toEqual(
        ["draft", "running", "decided", "abandoned"].sort(),
      )
      expect(f.verdict).toBe("string?")
      expect(f.learnings).toBe("string?")
      expect(f.linked_campaign_ids).toBe("string?")
      expect(f.created_by).toBe("string")
      expect(t?.indexes).toContainEqual(["status"])
      expect(t?.indexes).toContainEqual(["decision_date"])
    })

    it("declares manual_spend with rlsScope:internal, its fields, and indexes [channel]/[period_start]", () => {
      const m = loadManifest() as {
        schema: Record<
          string,
          { rlsScope?: string; fields?: Record<string, unknown>; indexes?: string[][] }
        >
      }
      const t = m.schema.manual_spend
      expect(t, "manual_spend table must exist").toBeDefined()
      expect(t?.rlsScope).toBe("internal")
      const f = t?.fields ?? {}
      expect(f.channel).toBe("string")
      expect(f.site).toBe("string?")
      expect(f.period_start).toBe("date")
      expect(f.period_end).toBe("date")
      expect(f.amount).toBe("number")
      expect(f.currency).toBe("string")
      expect(f.notes).toBe("string?")
      expect(f.created_by).toBe("string")
      expect(t?.indexes).toContainEqual(["channel"])
      expect(t?.indexes).toContainEqual(["period_start"])
    })

    it("declares dealer_profiles with rlsScope:internal, its fields+enum, and index [dealer_name]", () => {
      const m = loadManifest() as {
        schema: Record<
          string,
          { rlsScope?: string; fields?: Record<string, unknown>; indexes?: string[][] }
        >
      }
      const t = m.schema.dealer_profiles
      expect(t, "dealer_profiles table must exist").toBeDefined()
      expect(t?.rlsScope).toBe("internal")
      const f = t?.fields ?? {}
      expect(f.dealer_name).toBe("string")
      expect(f.sku_match_hints).toBe("string?")
      expect(f.coverage_area).toBe("string?")
      expect((f.dealer_type as { type: string; enum: string[] })?.enum?.sort()).toEqual(
        ["broadline", "boutique"].sort(),
      )
      expect(f.notes).toBe("string?")
      expect(f.reorder_cadence).toBe("string?")
      expect(f.created_by).toBe("string")
      expect(t?.indexes).toContainEqual(["dealer_name"])
    })
  })

  // ─── P5 T2/T3: lab tools present with correct gating ───

  describe("P5 lab tools — gating + summarizers", () => {
    it("experiment_open is present and NOT gated (no summarizer required)", () => {
      const m = loadManifest() as { tools: Record<string, { gated?: boolean; handler?: string }> }
      const tool = m.tools.experiment_open
      expect(tool, "experiment_open tool must exist").toBeDefined()
      expect(tool?.gated).not.toBe(true)
    })

    it("experiment_update, experiment_close, experiment_list are present and NOT gated", () => {
      const m = loadManifest() as { tools: Record<string, { gated?: boolean }> }
      for (const name of ["experiment_update", "experiment_close", "experiment_list"]) {
        const tool = m.tools[name]
        expect(tool, `${name} tool must exist`).toBeDefined()
        expect(tool?.gated).not.toBe(true)
      }
    })

    it("manual_spend_add is gated with a summarizer; manual_spend_list is ungated", () => {
      const m = loadManifest() as {
        tools: Record<string, { gated?: boolean; summarizer?: string }>
      }
      expect(m.tools.manual_spend_add?.gated).toBe(true)
      expect(m.tools.manual_spend_add?.summarizer).toBe("summarizeManualSpendAdd")
      expect(m.tools.manual_spend_list?.gated).not.toBe(true)
    })

    it("dealer_profile_upsert is gated with a summarizer; dealer_profiles_list is ungated", () => {
      const m = loadManifest() as {
        tools: Record<string, { gated?: boolean; summarizer?: string }>
      }
      expect(m.tools.dealer_profile_upsert?.gated).toBe(true)
      expect(m.tools.dealer_profile_upsert?.summarizer).toBe("summarizeDealerProfileUpsert")
      expect(m.tools.dealer_profiles_list?.gated).not.toBe(true)
    })
  })

  // ─── P5 T4: Google gated writes — present, gated, scoped, summarized ───

  describe("P5 Google gated writes", () => {
    const GOOGLE_WRITE_TOOLS = [
      "google_create_campaign",
      "google_create_adgroup",
      "google_create_ad",
      "google_update_budget",
      "google_set_status",
      "google_add_negative_keywords",
      "google_create_conversion_action",
    ]
    const SUMMARIZER_BY_TOOL: Record<string, string> = {
      google_create_campaign: "summarizeGoogleCreateCampaign",
      google_create_adgroup: "summarizeGoogleCreateAdgroup",
      google_create_ad: "summarizeGoogleCreateAd",
      google_update_budget: "summarizeGoogleUpdateBudget",
      google_set_status: "summarizeGoogleSetStatus",
      google_add_negative_keywords: "summarizeGoogleAddNegativeKeywords",
      google_create_conversion_action: "summarizeGoogleCreateConversionAction",
    }

    it("all seven Google gated write tools exist, are gated:true, trustBoundary:'user', scope ads:google:write, with their summarizer", () => {
      const m = loadManifest() as {
        tools: Record<
          string,
          {
            gated?: boolean
            trustBoundary?: string
            requiredScopes?: string[]
            summarizer?: string
            handler?: string
          }
        >
      }
      for (const name of GOOGLE_WRITE_TOOLS) {
        const tool = m.tools[name]
        expect(tool, `${name} tool must exist`).toBeDefined()
        expect(tool?.gated, `${name} must be gated`).toBe(true)
        expect(tool?.trustBoundary, `${name} must have trustBoundary:'user'`).toBe("user")
        expect(tool?.requiredScopes, `${name} must have scope ads:google:write`).toEqual([
          "ads:google:write",
        ])
        expect(tool?.summarizer, `${name} must reference its summarizer`).toBe(
          SUMMARIZER_BY_TOOL[name],
        )
        expect(tool?.handler).toBe(name)
      }
    })

    it("ads:google:write is present in top-level scopes[]", () => {
      const m = loadManifest() as { scopes: string[] }
      expect(m.scopes).toContain("ads:google:write")
    })

    it("google_create_campaign restricts advertising_channel_type to SEARCH/PERFORMANCE_MAX and accepts an experiment param", () => {
      const m = loadManifest() as {
        tools: Record<string, { params?: { properties?: Record<string, { enum?: string[] }> } }>
      }
      const props = m.tools.google_create_campaign?.params?.properties ?? {}
      expect(props.advertising_channel_type?.enum?.sort()).toEqual(
        ["PERFORMANCE_MAX", "SEARCH"].sort(),
      )
      expect(props.experiment).toBeDefined()
    })

    it("google_set_status restricts status to ENABLED/PAUSED and accepts an experiment param", () => {
      const m = loadManifest() as {
        tools: Record<string, { params?: { properties?: Record<string, { enum?: string[] }> } }>
      }
      const props = m.tools.google_set_status?.params?.properties ?? {}
      expect(props.status?.enum?.sort()).toEqual(["ENABLED", "PAUSED"].sort())
      expect(props.experiment).toBeDefined()
    })
  })

  // ─── P5 T6/T7: metrics registry tools ───

  describe("P5 metrics registry tools", () => {
    it("metrics_list and metrics_run exist, are ungated reads under ads:internal", () => {
      const m = loadManifest() as {
        tools: Record<string, { gated?: boolean; requiredScopes?: string[]; handler?: string }>
      }
      for (const name of ["metrics_list", "metrics_run"]) {
        const tool = m.tools[name]
        expect(tool, `${name} tool must exist`).toBeDefined()
        expect(tool?.gated).not.toBe(true)
        expect(tool?.requiredScopes).toEqual(["ads:internal"])
        expect(tool?.handler).toBe(name)
      }
    })

    it("metrics_run's formula_id enum lists exactly the five registry formulas", () => {
      const m = loadManifest() as {
        tools: Record<string, { params?: { properties?: Record<string, { enum?: string[] }> } }>
      }
      const enumValues = m.tools.metrics_run?.params?.properties?.formula_id?.enum ?? []
      expect([...enumValues].sort()).toEqual(
        [
          "blended_mer_dtc",
          "blended_mer_total",
          "cpa_by_sku_class",
          "revenue_by_channel",
          "total_vs_dtc_mer_gap",
        ].sort(),
      )
    })

    it("metric_formulas table is declared with rlsScope:internal", () => {
      const m = loadManifest() as { schema: Record<string, { rlsScope?: string }> }
      expect(m.schema.metric_formulas?.rlsScope).toBe("internal")
    })
  })

  // ─── P5 T8/T9: consent-join + erasure sweep ───

  describe("P5 consent-join + audience-erasure sweep", () => {
    it("create_custom_audience declares an audience_purpose property (buyer/newsletter)", () => {
      const m = loadManifest() as {
        tools: Record<string, { params?: { properties?: Record<string, { enum?: string[] }> } }>
      }
      const prop = m.tools.create_custom_audience?.params?.properties?.audience_purpose
      expect(prop, "create_custom_audience must declare audience_purpose").toBeDefined()
      expect(prop?.enum?.sort()).toEqual(["buyer", "newsletter"].sort())
    })

    it("add_users_to_audience REQUIRES audience_purpose", () => {
      const m = loadManifest() as {
        tools: Record<
          string,
          { params?: { required?: string[]; properties?: Record<string, { enum?: string[] }> } }
        >
      }
      const tool = m.tools.add_users_to_audience
      expect(tool?.params?.required).toContain("audience_purpose")
      expect(tool?.params?.properties?.audience_purpose?.enum?.sort()).toEqual(
        ["buyer", "newsletter"].sort(),
      )
    })

    it("audience_erasure_sweep exists, is UNGATED (safe-direction GDPR obligation), under ads:internal", () => {
      const m = loadManifest() as {
        tools: Record<string, { gated?: boolean; requiredScopes?: string[]; handler?: string }>
      }
      const tool = m.tools.audience_erasure_sweep
      expect(tool, "audience_erasure_sweep tool must exist").toBeDefined()
      expect(tool?.gated).not.toBe(true)
      expect(tool?.requiredScopes).toEqual(["ads:internal"])
      expect(tool?.handler).toBe("audience_erasure_sweep")
    })

    it("audience_erasure_log table is declared with rlsScope:internal", () => {
      const m = loadManifest() as { schema: Record<string, { rlsScope?: string }> }
      expect(m.schema.audience_erasure_log?.rlsScope).toBe("internal")
    })

    it("cross_app_calls declares database:db_read and database:db_query", () => {
      const m = loadManifest() as { cross_app_calls: Array<{ target: string }> }
      const targets = m.cross_app_calls.map((c) => c.target)
      expect(targets).toContain("database:db_read")
      expect(targets).toContain("database:db_query")
    })
  })

  // ─── P5 T10: doctrine markers for the lab/metrics/consent operating rules ───

  describe("P5 agentInstructions lab/metrics/consent doctrine", () => {
    it("names every P5 Google gated write tool", () => {
      const ai = guideText(loadManifest())
      for (const name of [
        "google_create_campaign",
        "google_create_adgroup",
        "google_create_ad",
        "google_update_budget",
        "google_set_status",
        "google_add_negative_keywords",
        "google_create_conversion_action",
      ]) {
        expect(ai, `agentInstructions must name ${name}`).toContain(name)
      }
    })

    it("carries the metrics quote-verbatim doctrine and byte-identical determinism framing", () => {
      const ai = guideText(loadManifest())
      expect(ai).toContain("metrics_run")
      expect(ai).toContain("metrics_list")
      expect(ai.toUpperCase()).toContain("VERBATIM")
      expect(ai).toMatch(/byte-identical/i)
    })

    it("carries the target-CPA gap-flag doctrine (never invent a target)", () => {
      const ai = guideText(loadManifest())
      expect(ai).toMatch(/target.CPA/i)
      expect(ai).toMatch(/no target CPA configured/i)
    })

    it("carries the audience_purpose + consent-join-in-code doctrine (SC 8)", () => {
      const ai = guideText(loadManifest())
      expect(ai).toContain("audience_purpose")
      expect(ai).toMatch(/default-deny/i)
      expect(ai).toMatch(/dropped_no_consent/i)
    })

    it("carries the audience_erasure_sweep doctrine (ungated, audited, idempotent)", () => {
      const ai = guideText(loadManifest())
      expect(ai).toContain("audience_erasure_sweep")
      expect(ai).toMatch(/UNGATED/)
      expect(ai).toMatch(/idempotent/i)
    })

    it("A-G doctrine block is still present verbatim (block markers)", () => {
      const ai = guideText(loadManifest())
      for (const marker of [
        "A. TRUST HIERARCHY",
        "B. REGIME-FIRST",
        "C. SPEND GATING",
        "D. STATISTICAL HONESTY",
        "E. HYBRID DTC/WHOLESALE",
        "F. CONSENT FLOOR",
        "G. EXPERIMENT DISCIPLINE",
      ]) {
        expect(ai, `missing doctrine marker: ${marker}`).toContain(marker)
      }
    })
  })

  // ─── P6 Task 5: dashboard tab + activityBar repoint + copy fixes ──────────

  describe("P6 dashboard view + copy fixes", () => {
    it("declares a 'dashboard' tabType with component AdsDashboard at /ads/dashboard", () => {
      const m = loadManifest() as {
        views: {
          tabTypes: Record<string, { component: string; urlPattern: string; singleton?: boolean }>
        }
      }
      const dash = m.views.tabTypes.dashboard
      expect(dash).toBeDefined()
      expect(dash?.component).toBe("AdsDashboard")
      expect(dash?.urlPattern).toBe("/ads/dashboard")
      expect(dash?.singleton).toBe(true)
    })

    it("activityBar tabAction repoints to the dashboard tab (default landing)", () => {
      const m = loadManifest() as {
        views: { activityBar: { tabAction: { type: string; entityId: string } } }
      }
      expect(m.views.activityBar.tabAction.entityId).toBe("dashboard")
    })

    it("campaigns tab still exists at /ads/campaigns (only the default landing changed)", () => {
      const m = loadManifest() as { views: { tabTypes: Record<string, { urlPattern: string }> } }
      expect(m.views.tabTypes.campaigns?.urlPattern).toBe("/ads/campaigns")
    })

    it("settings are the declarative page: connections and the account status block", () => {
      const m = loadManifest() as {
        tools: Record<string, unknown>
        views: { settings?: unknown }
        settings: { sections: Array<{ id: string; blocks: Array<Record<string, unknown>> }> }
      }
      expect(m.views.settings).toBeUndefined()
      expect(m.settings.sections.map((s) => s.id)).toEqual(["connections", "status"])
      const blocks = m.settings.sections.flatMap((s) => s.blocks)
      expect(blocks.map((b) => b.block)).toEqual(["connections", "custom"])
      expect(blocks[1]?.component).toBe("AdsAccountStatus")
      const barrel = readFileSync(join(import.meta.dir, "ui", "index.tsx"), "utf8")
      expect(barrel).toContain("AdsAccountStatus")
    })

    it("no user-facing 'Meta Ads' HEADER copy remains in the sidebar (export identifiers excepted)", () => {
      const sidebarSrc = readFileSync(join(import.meta.dir, "ui", "sidebar.tsx"), "utf8")
      expect(sidebarSrc).not.toContain(">Meta Ads<")
      expect(sidebarSrc).not.toContain("Meta Ads v0.1")
      expect(sidebarSrc).toContain("MetaAdsSidebar")
    })

    it("no dash punctuation (em/en dash or double-hyphen) in the account status copy", () => {
      const src = readFileSync(join(import.meta.dir, "ui", "AccountStatus.tsx"), "utf8")
      const literals =
        src
          .split("\n")
          .map((line) => line.replace(/\/\/.*$/, ""))
          .join("\n")
          .match(/"[^"\n]*"/g) ?? []
      for (const l of literals) {
        expect(l).not.toMatch(/[—–]/)
        expect(l).not.toContain("--")
      }
    })

    it("no dash punctuation (em/en dash or double-hyphen) in Dashboard.tsx or sidebar.tsx rendered string literals", () => {
      // Scans JSX text-node string literals and quoted attribute values for
      // user-visible dash punctuation. Unlike the Settings.tsx check above
      // (which only checks title/subtitle attrs), this walks every quoted
      // string literal in the two files — Dashboard.tsx's zombie-campaign
      // row copy (`{c.name} — ACTIVE, no spend this week`) is a template
      // literal, not a JSX attribute, so a broader scan is required.
      const files = ["Dashboard.tsx", "sidebar.tsx"]
      for (const file of files) {
        const src = readFileSync(join(import.meta.dir, "ui", file), "utf8")
        // Strip `//` line comments FIRST — otherwise a comment containing a
        // stray backtick/quote can pair with a real string delimiter later
        // in the file and swallow unrelated source (incl. other comments)
        // into a bogus "literal". Only actual rendered string/template
        // literals should be scanned for user-visible dash punctuation.
        const withoutComments = src
          .split("\n")
          .map((line) => line.replace(/\/\/.*$/, ""))
          .join("\n")
        // Match quoted string literals ("...", '...', `...`) — covers JSX
        // attributes, plain JS strings, and template literals alike.
        const literals =
          withoutComments.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? []
        // Also match bare JSX text nodes (text between `>` and `<`, no
        // quoting at all) — e.g. `{c.name} — ACTIVE, no spend this week`
        // rendered directly as JSX children, not a string/template literal.
        // Braces are allowed inside (JSX expression children like
        // `{c.name}` interleave with literal text in the same text node).
        const jsxTextNodes = withoutComments.match(/>[^<>]*(?=<)/g) ?? []
        for (const lit of [...literals, ...jsxTextNodes]) {
          expect(lit).not.toMatch(/[—–]/)
          expect(lit).not.toContain(" -- ")
        }
      }
    })
  })
})
