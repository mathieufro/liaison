// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Outside text is declared by data. An app names under `outsideTextFields` the fields of its data
// that a person outside the org can set (a mail's subject, a customer's note, a commit message).
// A read tool whose `returns` names one of them must declare `taintSource` (or narrow it with
// `taintSourceWhen`), so the turn that read it is marked and a later outbound call parks. No
// keyword in a name or a description decides: the guard reads the declarations alone.
//
// A read tool that declares no `returns` cannot show it returns none of those fields. Each one is
// listed below with the reason it carries no outside text, never silently allowed. An app with
// read tools that declares no outside fields at all is listed the same way, with its reason: an
// app cannot pass by saying nothing. Declaring
// `taintSource` on a read tool used today makes later outbound calls in the same turn park, so a
// routine that reads it starts parking with no change on the customer's side: a read that does
// carry outside text declares it, and `outside-text-reads.test.ts` shows its result marks the turn.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const API_APPS = join(import.meta.dir, "..", "..", "apps")
const BUNDLED = join(import.meta.dir, "..", "..", "..", "..", "..", "bundled-apps")

interface ManifestTool {
  readOnly?: boolean
  agentVisible?: boolean
  taintSource?: boolean
  taintSourceWhen?: { field: string; equals: unknown }
  returns?: { schema?: Record<string, string>; dimensions?: Record<string, string> }
}

interface Manifest {
  name: string
  outsideTextFields?: string[]
  tools?: Record<string, ManifestTool>
}

function loadManifests(): Manifest[] {
  const out: Manifest[] = []
  for (const dir of [API_APPS, BUNDLED]) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        out.push(JSON.parse(readFileSync(join(dir, entry.name, "app.manifest.json"), "utf8")))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
      }
    }
  }
  return out
}

const declaresTaint = (tool: ManifestTool): boolean =>
  tool.taintSource === true || tool.taintSourceWhen !== undefined

/** A read whose result reaches a model: a read-only tool the agent and the MCP door can call. */
const isModelRead = (tool: ManifestTool): boolean =>
  tool.readOnly === true && tool.agentVisible !== false

/**
 * What the guard finds wrong in one manifest, each naming the tool. `listed` holds the read tools
 * without `returns` that carry a reason (`app:tool` keys); `listedApps` the apps with read tools
 * that declare no outside fields, each with its reason.
 */
export function outsideFieldProblems(
  manifest: Manifest,
  listed: ReadonlyMap<string, string>,
  listedApps: ReadonlyMap<string, string> = new Map(),
): string[] {
  const problems: string[] = []
  const fields = new Set(manifest.outsideTextFields ?? [])
  const tools = Object.entries(manifest.tools ?? {})
  const appReason = listedApps.get(manifest.name)
  if (fields.size === 0) {
    // An app that already reads outside text says which of its fields carry it.
    const sources = tools.filter(([, t]) => isModelRead(t) && declaresTaint(t)).map(([n]) => n)
    if (sources.length > 0) {
      problems.push(
        `${manifest.name}: ${sources.join(", ")} read outside text but the app declares no outsideTextFields`,
      )
      return problems
    }
    if (!tools.some(([, t]) => isModelRead(t))) {
      if (appReason !== undefined)
        problems.push(`${manifest.name} has no read tool and is still listed`)
      return problems
    }
    if (appReason === undefined) {
      problems.push(
        `${manifest.name} has read tools, declares no outsideTextFields, and is not listed with a reason`,
      )
    } else if (appReason.trim().length === 0) {
      problems.push(`${manifest.name} is listed without a reason`)
    }
    return problems
  }
  if (appReason !== undefined) {
    problems.push(`${manifest.name} declares outsideTextFields and is still listed`)
  }
  for (const [name, tool] of tools) {
    if (!isModelRead(tool)) continue
    const key = `${manifest.name}:${name}`
    if (declaresTaint(tool)) {
      if (listed.has(key)) problems.push(`${key} declares a taint source and is still listed`)
      continue
    }
    const returned = [
      ...Object.keys(tool.returns?.schema ?? {}),
      ...Object.keys(tool.returns?.dimensions ?? {}),
    ]
    const outside = returned.filter((field) => fields.has(field))
    if (outside.length > 0) {
      problems.push(
        `${key} returns the outside field ${outside.join(", ")} and declares neither taintSource nor taintSourceWhen`,
      )
      continue
    }
    if (tool.returns !== undefined) {
      if (listed.has(key)) problems.push(`${key} declares its returns and is still listed`)
      continue
    }
    const reason = listed.get(key)
    if (reason === undefined) {
      problems.push(
        `${key} declares no returns and no taint source, and is not listed with a reason`,
      )
    } else if (reason.trim().length === 0) {
      problems.push(`${key} is listed without a reason`)
    }
  }
  return problems
}

const NONE = "no field a person outside the org sets"

/**
 * The read tools of apps with outside fields that declare no `returns` and no taint source, each
 * with why. An entry for a tool that no longer exists, now declares its returns, or now declares a
 * taint source fails, so the list cannot go stale.
 */
const LISTED = new Map<string, string>([
  ["mail:listAccounts", `the person's own mailboxes and their sync state: ${NONE}`],
  ["mail:getAccount", `one connected mailbox's settings: ${NONE}`],
  ["mail:suppression_check", `whether addresses opted out, when and how: ${NONE}`],
  ["calendar:list_accounts", `the connected calendar accounts: ${NONE}`],
  ["api-connector:connector_adapter_reference", `a fixed reference document: ${NONE}`],
  ["api-connector:connector_adapter_get", `the adapter the org saved: ${NONE}`],
  ["api-connector:connector_adapter_versions", `who saved which adapter version: ${NONE}`],
  ["tickets:inboxCounts", `unread counts per inbox: ${NONE}`],
  ["tickets:teams.list", `team names and counts: ${NONE}`],
  ["tickets:categories.list", `the org's categories: ${NONE}`],
  ["tickets:templates.list", `reply templates the org wrote: ${NONE}`],
  ["tickets:csat.summary", `survey counts and averages: ${NONE}`],
  ["tickets:inboxes.list", `the org's inboxes: ${NONE}`],
  ["tickets:idSegment.get", `an org setting: ${NONE}`],
  ["tickets:approveFromHome.get", `an org setting: ${NONE}`],
  ["tickets:apiKeys.list", `key labels and dates: ${NONE}`],
  ["invoicing:einvoicing_settings_get", `org settings: ${NONE}`],
  ["invoicing:hs_codes_lookup", `the org's code library: ${NONE}`],
  ["invoicing:contact_relationships_get", `a classification the org set: ${NONE}`],
  ["invoicing:settings_issuer_profile_list", `the org's own legal entities: ${NONE}`],
  [
    "invoicing:recurring_list",
    `the org's own schedules: cadence, dates and the lines its people wrote, the free-text notes left out: ${NONE}`,
  ],
  ["invoicing:settings_tax_regime_list", `org settings: ${NONE}`],
  [
    "invoicing:issuer_stream_get",
    `who issues each stream and who confirmed the card processor's own emails, set by the org's people: ${NONE}`,
  ],
  ["invoicing:settings_hs_code_list", `the org's code library: ${NONE}`],
  ["invoicing:settings_shop_mapping_list", `org settings: ${NONE}`],
  [
    "invoicing:orders_invoiceability_check",
    `the caller's own order fields checked against the shop's issuer mapping: ${NONE}`,
  ],
  ["invoicing:documents_download_pdf", `a file id and a link: ${NONE}`],
  ["invoicing:legal_originals_verify", `checksums of stored files: ${NONE}`],
  ["social:connections_status", `connection states: ${NONE}`],
  ["social:quota_status", `API usage counts: ${NONE}`],
  ["social:monitor_terms_list", `terms the org typed: ${NONE}`],
  ["social:counts", `badge counts: ${NONE}`],
  ["shopify:analytics_query", `sales aggregates: ${NONE}`],
  ["shopify:orders_invoice_links", `ids of linked documents: ${NONE}`],
  ["shopify:products_short_codes", `codes the org set: ${NONE}`],
  ["shopify:locations_list", `the store's own locations: ${NONE}`],
  ["shopify:products_search", `the store's own catalog: ${NONE}`],
  ["shopify:products_get", `the store's own catalog: ${NONE}`],
  ["shopify:products_publication_targets", `the store's sales channels: ${NONE}`],
  ["shopify:markets_list", `the store's markets: ${NONE}`],
  ["shopify:markets_get", `the store's markets: ${NONE}`],
  ["shopify:variants_search", `the store's own catalog: ${NONE}`],
  ["shopify:variants_get", `the store's own catalog: ${NONE}`],
  ["shopify:variants_brief", `the store's own catalog: ${NONE}`],
  ["shopify:variants_market_price", `the store's prices: ${NONE}`],
  ["shopify:inventory_levels_list", `stock counts: ${NONE}`],
  ["shopify:inventory_value", `a stock value: ${NONE}`],
  ["shopify:repeat_rate", `an aggregate rate: ${NONE}`],
  ["shopify:fulfillments_get", `carrier and tracking numbers: ${NONE}`],
  [
    "shopify:fulfillment_orders_get",
    `line titles and SKUs of the store's own catalog, and its own locations: ${NONE}`,
  ],
  ["shopify:discounts_search", `codes the org created: ${NONE}`],
  ["shopify:settings_load", `connection and sync settings: ${NONE}`],
  ["boxtal:packages_list", `the org's own shipping profiles, packs and products: ${NONE}`],
  ["boxtal:settings_sender_address_get", `the org's own sender address: ${NONE}`],
  ["boxtal:quote", `carrier offers and prices from the shipping catalog: ${NONE}`],
  ["boxtal:get_documents", `document kinds and links: ${NONE}`],
  ["boxtal:list_content_categories", `the shipping catalog's content categories: ${NONE}`],
  ["boxtal:queue_counts", `badge counts: ${NONE}`],
  ["boxtal:attention_rules_list", `rules the org wrote: ${NONE}`],
  ["boxtal:settings_carrier_allowlist_get", `an org setting: ${NONE}`],
  ["boxtal:settings_label_format_get", `an org setting: ${NONE}`],
  ["boxtal:settings_product_codes_get", `codes the org set: ${NONE}`],
  ["boxtal:settings_packaging_policy_get", `an org setting: ${NONE}`],
  ["monitoring:incidents_summary", `counts per severity and per configured source: ${NONE}`],
  ["pennylane:pnl_summary", `amounts per class: ${NONE}`],
  ["pennylane:cash_position", `balances of the org's own bank accounts: ${NONE}`],
  ["pennylane:transactions_list", `amounts and currencies: ${NONE}`],
  ["pennylane:spend_by_category", `amounts per class: ${NONE}`],
  ["pennylane:runway_estimate", `a number of months: ${NONE}`],
  ["pennylane:home_load", `cached amounts: ${NONE}`],
  ["ads:insights_query", `spend and delivery metrics: ${NONE}`],
  ["ads:campaigns_list", `the org's own campaigns: ${NONE}`],
  ["ads:adsets_list", `the org's own ad sets and targeting: ${NONE}`],
  ["ads:ads_list", `the org's own ads: ${NONE}`],
  ["ads:targeting_search", `the ad platform's targeting catalog: ${NONE}`],
  ["ads:media_list", `images and videos the org uploaded: ${NONE}`],
  ["ads:audiences_list", `the org's own audiences and their sizes: ${NONE}`],
  ["ads:pages_list", `the Pages the org manages: ${NONE}`],
  ["ads:account_info", `the ad account's settings: ${NONE}`],
  ["ads:creative_get", `the org's own creatives: ${NONE}`],
  ["ads:ad_preview", `a preview of the org's own ad: ${NONE}`],
  ["ads:google_campaigns_list", `the org's own campaigns: ${NONE}`],
  ["ads:google_adgroups_list", `the org's own ad groups: ${NONE}`],
  ["ads:google_ads_list", `the org's own ads: ${NONE}`],
  ["ads:google_insights_query", `spend and delivery metrics: ${NONE}`],
  ["ads:google_account_info", `the account's settings and conversion actions: ${NONE}`],
  ["ads:google_recommendations_list", `the platform's recommendation types: ${NONE}`],
  ["ads:merchant_feed_status", `product counts per destination: ${NONE}`],
  [
    "ads:merchant_product_issues",
    `the platform's issue codes on the store's own products: ${NONE}`,
  ],
  ["ads:experiment_list", `experiments the org opened: ${NONE}`],
  ["ads:manual_spend_list", `spend entries the org recorded: ${NONE}`],
  ["ads:dealer_profiles_list", `dealer profiles the org keeps: ${NONE}`],
  ["ads:metrics_list", `the metric registry: ${NONE}`],
  ["ads:metrics_run", `a computed metric value: ${NONE}`],
  ["database:db_list_reads", `the read catalog the org configured: ${NONE}`],
  ["database:db_describe", `table and column names of the connected database's schema: ${NONE}`],
  ["database:db_probe", `grants and catalog drift of the connected role: ${NONE}`],
])

/**
 * The apps with read tools that declare no outside fields, each with why. A new app with a read
 * tool fails until it declares its outside fields or is listed here.
 */
const LISTED_APPS = new Map<string, string>([
  [
    "knowledge",
    "the host marks a turn per document read: a document synced from outside, or a remote source item, taints (taint-exemptions.ts)",
  ],
  ["projects", `projects, tasks, comments and labels the org's own members write: ${NONE}`],
  ["mcp-manager", `the MCP connections the org added: ${NONE}`],
])

describe("outside text is declared by data", () => {
  const manifests = loadManifests()

  it("every manifest read naming an outside field declares a taint source, and every other read is listed with a reason", () => {
    const problems = manifests.flatMap((m) => outsideFieldProblems(m, LISTED, LISTED_APPS))
    expect(problems).toEqual([])
  })

  it("every listed app still exists", () => {
    const names = new Set(manifests.map((m) => m.name))
    expect([...LISTED_APPS.keys()].filter((name) => !names.has(name))).toEqual([])
  })

  it("an app with read tools that declares no outside fields fails unless listed with a reason", () => {
    const manifest: Manifest = {
      name: "acme",
      tools: { rows_read: { readOnly: true }, write: { readOnly: false } },
    }
    expect(outsideFieldProblems(manifest, new Map())).toEqual([
      "acme has read tools, declares no outsideTextFields, and is not listed with a reason",
    ])
    expect(outsideFieldProblems(manifest, new Map(), new Map([["acme", " "]]))).toEqual([
      "acme is listed without a reason",
    ])
    expect(
      outsideFieldProblems(manifest, new Map(), new Map([["acme", "its own counts"]])),
    ).toEqual([])
    manifest.outsideTextFields = ["rows"]
    manifest.tools!.rows_read!.taintSource = true
    expect(
      outsideFieldProblems(manifest, new Map(), new Map([["acme", "its own counts"]])),
    ).toEqual(["acme declares outsideTextFields and is still listed"])
    expect(
      outsideFieldProblems(
        { name: "acme", tools: { write: {} } },
        new Map(),
        new Map([["acme", "x"]]),
      ),
    ).toEqual(["acme has no read tool and is still listed"])
  })

  it("every listed tool still exists in an app that declares outside fields", () => {
    const known = new Set(
      manifests
        .filter((m) => (m.outsideTextFields ?? []).length > 0)
        .flatMap((m) => Object.keys(m.tools ?? {}).map((n) => `${m.name}:${n}`)),
    )
    expect([...LISTED.keys()].filter((key) => !known.has(key))).toEqual([])
  })

  it("a read naming an outside field with no declaration fails naming it", () => {
    const manifest: Manifest = {
      name: "acme",
      outsideTextFields: ["subject"],
      tools: {
        inbox_read: { readOnly: true, returns: { schema: { id: "string", subject: "string" } } },
      },
    }
    expect(outsideFieldProblems(manifest, new Map())).toEqual([
      "acme:inbox_read returns the outside field subject and declares neither taintSource nor taintSourceWhen",
    ])
    manifest.tools!.inbox_read!.taintSource = true
    expect(outsideFieldProblems(manifest, new Map())).toEqual([])
    manifest.tools!.inbox_read!.taintSource = undefined
    manifest.tools!.inbox_read!.taintSourceWhen = { field: "origin", equals: "outside" }
    expect(outsideFieldProblems(manifest, new Map())).toEqual([])
  })

  it("a read without returns is neither allowed silently nor listed without a reason", () => {
    const manifest: Manifest = {
      name: "acme",
      outsideTextFields: ["subject"],
      tools: { counts: { readOnly: true }, hidden: { readOnly: true, agentVisible: false } },
    }
    expect(outsideFieldProblems(manifest, new Map())).toEqual([
      "acme:counts declares no returns and no taint source, and is not listed with a reason",
    ])
    expect(outsideFieldProblems(manifest, new Map([["acme:counts", " "]]))).toEqual([
      "acme:counts is listed without a reason",
    ])
    expect(outsideFieldProblems(manifest, new Map([["acme:counts", "a count"]]))).toEqual([])
  })

  it("an app reading outside text without declaring its fields fails naming the tools", () => {
    const manifest: Manifest = {
      name: "acme",
      tools: { read: { readOnly: true, taintSource: true } },
    }
    expect(outsideFieldProblems(manifest, new Map())).toEqual([
      "acme: read read outside text but the app declares no outsideTextFields",
    ])
  })

  // The count taken when this guard arrived: the taint sources the kernel routine templates (mail
  // and projects reads, under the Morning brief's scopes) and the ticket job's path (tickets) can
  // reach. A new undeclared-to-declared move raises it on purpose, with its own test; a narrowing
  // by `taintSourceWhen` lowers it. Tickets rose from 2 to 6 when the four reads that hand back
  // ticket subjects (backlogHealth, slaReport, listForContact, csat.list) declared them: a turn
  // that read a subject a customer wrote parks its later outbound calls like one that read the
  // ticket itself.
  it("the kernel routine templates and the ticket job's path park no more than before", () => {
    const FORK_COUNT: Record<string, number> = { mail: 2, projects: 0, tickets: 6 }
    const now: Record<string, number> = {}
    for (const m of manifests) {
      if (!(m.name in FORK_COUNT)) continue
      now[m.name] = Object.values(m.tools ?? {}).filter(
        (t) => isModelRead(t) && t.taintSource === true && t.taintSourceWhen === undefined,
      ).length
    }
    for (const [app, count] of Object.entries(FORK_COUNT)) {
      expect({ app, count: now[app] }).toEqual({ app, count: Math.min(now[app] ?? 0, count) })
    }
  })
})
