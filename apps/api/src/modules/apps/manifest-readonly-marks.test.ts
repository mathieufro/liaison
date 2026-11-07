// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Scope taint (modules/agent/scopes/scope-taint.ts) refuses, on a turn that has read scoped data,
// every tool that is neither `readOnly` nor writing an enforcing sink. Reads must never be
// refused, so every genuinely read-only manifest tool carries `readOnly: true`.
//
// The sets below are the audit: each tool was marked only after reading its handler down to
// the storage and network calls and finding no insert, update or delete, no outbound send and
// no state save. A tool whose "read" writes something (a read-state row, a lazy seed, a
// self-heal insert, a cross-app call into such a tool) is deliberately absent. Changing a set
// means re-auditing that handler.
//
// PLATFORM BOOKKEEPING IS NOT A WRITE (2026-09-22, scope-taint.ts consequence 1). A row the
// platform writes AROUND a read, carrying none of the turn's data, does not make the read a
// sink: the database connector's audit row (read name, row count, SQL hash, never the rows or
// the raw SQL), the viewer's own participant row on a task thread they may already read, a
// compute service's result cache. Pinning those as writes refused every read after the first
// one of a conversation (the live QA walk of 2026-09-22: kpi_run, db_read, projects.get).

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { validateAppManifest } from "~/modules/apps/contract"

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..")
const BUNDLED_DIR = join(REPO, "bundled-apps")
const IN_TREE_DIR = join(REPO, "apps", "api", "src", "apps")

const READ_ONLY: Record<string, string[]> = {
  // In-tree first-party apps.
  tickets: [
    "search",
    "get",
    "inboxCounts",
    "backlogHealth",
    "slaReport",
    "listForContact",
    "teams.list",
    "categories.list",
    "categories.tree", // the settings page's tree read (rows + version)
    "approval_route_read", // the ticket's assignee, through get, for who an approval is for
    "templates.list",
    "csat.summary",
    "csat.list",
    "inboxes.list",
    "apiKeys.list",
    "idSegment.get",
    "approveFromHome.get",
  ],
  projects: [
    "approval_route_read", // the task's assignee, through get, for who an approval is for
    "search",
    // Enrols the caller on the task's discussion thread, exactly as opening the task does.
    "get",
    "comments",
    "tasks_byAssignee",
    "attentionItems",
    "tasks_byProject",
    "portfolio_rollup",
    "webhook_info",
    // listChecklist in its own read: no write, no gate.
    "checklist_get",
    "labels.list", // taxonomy read, no write
    "labels.tree", // the settings page's tree read (rows + version), no write
  ],
  knowledge: ["search", "review_queue", "get", "find_by_title", "synced_sources.list"],
  mail: ["listAccounts", "getAccount", "getSyncStatus", "search", "read", "providers.get"],
  calendar: ["list_calendars", "list_events", "search_events", "list_accounts"],
  "mcp-manager": ["list_connections"],
  // items_list is one findMany; external_fetch is a fixed GET to the example API with no
  // caller data in it (2026-09-25).
  example: ["items_list", "external_fetch", "item_notes_count", "item_context"], // count: one findMany; item_context: two findMany
  gitlab: [
    "gitlab_list_projects",
    "gitlab_list_commits",
    "gitlab_get_commit",
    "gitlab_list_merge_requests",
    "gitlab_get_merge_request",
    "gitlab_list_issues",
    "gitlab_list_milestones",
    "gitlab_list_labels",
    "gitlab_list_releases",
    "gitlab_list_tags",
    "gitlab_read_file",
    "gitlab_list_tree",
    "gitlab_search",
  ],
  // shared_drives lists the org Drive connections and (for an admin) the Shared Drives the
  // connecting account is a member of (drives.list); only the token cache is touched.
  "google-drive": ["search", "read", "shared_drives"],
  // Every call writes one audit row (read name, outcome, row count, SQL hash); the target is
  // reached through a read-only role, so nothing else is written anywhere.
  database: ["db_list_reads", "db_read", "db_describe", "db_probe", "db_query"],
  // The API connector's reads: an adapter row read, then the upstream GET (or
  // readOnlyPost search) through the host transport. Around them only platform
  // bookkeeping: the audit row (connection, operation name, status, ms) and the
  // oauth2 token / customer caches, none of which carries the turn's data.
  "api-connector": [
    "connector_list_operations",
    "connector_read",
    // The adapter authoring reads: the stored adapter, its versions, the guide, and one page
    // of one READ operation (connector_adapter_test refuses a write before any request).
    "connector_adapter_get",
    "connector_adapter_versions",
    "connector_adapter_reference",
    "connector_adapter_test",
  ],
  // Bundled (catalog) first-party apps.
  ads: [
    "campaigns_list",
    "adsets_list",
    "ads_list",
    "targeting_search",
    "media_list",
    "audiences_list",
    "pages_list",
    "account_info",
    "graph_get",
    "creative_get",
    "ad_preview",
    "counts",
    "pending_approvals_list",
    "google_campaigns_list",
    "google_adgroups_list",
    "google_ads_list",
    "google_insights_query",
    "google_account_info",
    "google_search_terms",
    "google_recommendations_list",
    "merchant_feed_status",
    "merchant_product_issues",
    "experiment_list",
    "manual_spend_list",
    "dealer_profiles_list",
    // A transient Meta async report run on the fixed Meta host for large pulls,
    // otherwise a plain GET; read back by this call alone.
    "insights_query",
    // Deterministic formulas over the reads above; they write nothing.
    "metrics_list",
    "metrics_run",
  ],
  boxtal: [
    // Reads its rules out of app config and returns them with the rule
    // vocabulary; it touches no table and calls nothing outside the process.
    "attention_rules_list",
    "packages_list",
    "settings_sender_address_get",
    "settings_carrier_allowlist_get",
    "settings_label_format_get",
    "settings_product_codes_get",
    "settings_packaging_policy_get",
    // The settings page's own reads of the settings above.
    "settings_sender_form_get",
    "settings_form_get",
    "ready_list",
    "returns_list",
    "exceptions_list",
    "stuck_list",
    "get_documents",
    "list_content_categories",
    "search",
    // Cross-call only readOnly reads (shopify orders_search/orders_get, invoicing
    // documents_get/documents_search/documents_for_orders, kernel contacts_read).
    "quote",
    "shipment_draft_get",
    "prep_unlinked_list",
    "prep_order_prefill",
    // A shipment's print record, the data document templates fill.
    "print_record_get",
    // Write back only Boxtal's or the invoicing app's own state (the shipment snapshot, a settled
    // proforma, the resolved-draft cache), best effort: a failed write never fails the read.
    "track",
    "get_shipment",
    "prep_list",
    // 0.14.27-0.14.28 (#145, #152): same, the proforma settle and the draft cache refresh.
    "queue_counts",
    "to_prepare_list",
  ],
  calls: ["calls_segments_since", "calls_list", "webhook_info"],
  invoicing: [
    "documents_search",
    "documents_get",
    "documents_for_orders",
    "hs_codes_lookup",
    "pending_approvals_list",
    "vat_validate",
    // Reads the web and VIES for a buyer's number; writes nothing.
    "vat_lookup",
    "viewer_access",
    "contact_relationships_get",
    "deferred_list",
    "settings_issuer_profile_list",
    "settings_tax_regime_list",
    "settings_hs_code_list",
    "settings_shop_mapping_list",
    "documents_preview_pdf",
    "documents_download_pdf",
    // The approval cards' reads: issuer profiles and the buyer's VAT
    // status (a VIES lookup), written nowhere.
    "documents_issue_preview",
    "documents_update_preview",
    // A saved draft's card read: the document and the total issuing it would write, written nowhere.
    "draft_issue_preview",
    "counterparty_identity_get",
    "counterparty_identity_lookup",
    "einvoicing_classify",
    "einvoicing_readiness",
    "legal_originals_verify",
    "einvoice_transmission_get",
    "einvoicing_settings_get",
    // The settings page's own reads of the same settings and of the installed platforms.
    "einvoicing_settings_values",
    "einvoicing_provider_options",
    // The Received tab's reads: list and one received e-invoice, from the app's own rows.
    "received_einvoices_list",
    "received_einvoices_get",
    // A customer's earlier sales, lines and Shopify orders (cross-calls only reads).
    "customer_history",
  ],
  monitoring: ["incidents_list", "incidents_get", "incidents_summary", "webhook_info"],
  pennylane: [
    "supplier_invoices_list",
    "supplier_invoice_get",
    "customer_invoices_list",
    "trial_balance_get",
    "pnl_summary",
    "cash_position",
    "transactions_list",
    "spend_by_category",
    "runway_estimate",
    "home_load",
    // The e-invoicing platform (PA) provider ops that only read Pennylane: an existing
    // deposit or booking, a deposit's status, the registration, received e-invoices.
    "einvoicing_find",
    "einvoicing_find_booking",
    "einvoicing_status",
    "einvoicing_registration_status",
    "einvoicing_received_list",
    "einvoicing_received_get",
  ],
  // A missing install_metadata row is derived in memory on the read path, never inserted.
  shopify: [
    "orders_invoice_links",
    "home_load",
    "analytics_query",
    "orders_search",
    "orders_get",
    "customers_search",
    "customers_segment_search",
    "customers_get",
    "customers_get_by_external_id",
    "draft_orders_list",
    "draft_orders_get",
    "locations_list",
    "products_search",
    // The short display code per SKU, read from the kernel product attributes.
    "products_short_codes",
    "products_get",
    // The channels a publish/unpublish would act on (the approval card's context); a GraphQL read.
    "products_publication_targets",
    "markets_list",
    "markets_get",
    "variants_search",
    "variants_get",
    "variants_brief",
    "variants_market_price",
    "inventory_levels_list",
    "inventory_value",
    "repeat_rate",
    "abandoned_checkouts_list",
    "fulfillments_get",
    "fulfillment_orders_get",
    "returns_search",
    "refunds_get",
    "discounts_search",
    "metafields_list",
    "settings_load",
  ],
  social: [
    "findings_list",
    "findings_get",
    "dm_list",
    "dm_get",
    "watched_list",
    "monitor_terms_list",
    "counts",
    "connections_status",
    "quota_status",
  ],
}

// Reads that write, pinned so a future mark cannot slip in unaudited. It is also the reviewed
// exception list of the read-shaped-name check below: a tool named like a read that carries no
// readOnly mark (and declares no writesToTable) must be listed here, with what it writes.
const READS_THAT_WRITE: Record<string, string[]> = {
  tickets: ["markRead", "ensureSummary", "regenerateSummary"], // read-state upsert; summary UPDATE plus job
  mail: ["export_conversations"], // imports attachments into kernel.files
  "google-drive": ["import"], // inserts kernel.files rows
  shopify: ["webhooks_repair"], // registers webhook subscriptions with Shopify
  boxtal: [
    // Lists through to_prepare_list, which refreshes prep_draft_cache.
    "quote_batch",
    // Imports the label PDF into kernel.files.
    "import_label_document",
  ],
  example: ["resolve_contact"], // resolves or CREATES the contact
}

// A tool whose name says it reads: one of these words and none of the write words. Only a
// net for review, never a verdict: what it catches is either marked readOnly after reading the
// handler, or listed in READS_THAT_WRITE.
const READ_WORDS = new Set(
  "get list search track quote describe status read find count counts lookup history summary query info load brief preview".split(
    " ",
  ),
)
const WRITE_WORDS = new Set(
  "set add create update upsert delete remove issue refresh send submit import sync apply ensure regenerate mark repair".split(
    " ",
  ),
)

function nameWords(tool: string): string[] {
  return tool
    .split(/[_.\s]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter((w) => w !== "")
    .map((w) => w.toLowerCase())
}

function readsByName(tool: string): boolean {
  const words = nameWords(tool)
  return words.some((w) => READ_WORDS.has(w)) && !words.some((w) => WRITE_WORDS.has(w))
}

type Tool = {
  readOnly?: boolean
  writesToTable?: string
  gated?: boolean
  conditionalGate?: boolean
}
type Manifest = { name: string; tools?: Record<string, Tool> }

function manifestPath(app: string): string {
  const bundled = join(BUNDLED_DIR, app, "app.manifest.json")
  try {
    readFileSync(bundled)
    return bundled
  } catch {
    return join(IN_TREE_DIR, app, "app.manifest.json")
  }
}

function load(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest
}

function allManifestPaths(): string[] {
  const out: string[] = []
  for (const root of [BUNDLED_DIR, IN_TREE_DIR]) {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const p = join(root, e.name, "app.manifest.json")
      try {
        readFileSync(p)
        out.push(p)
      } catch {
        // not an app directory
      }
    }
  }
  return out.sort()
}

describe("manifest readOnly marks", () => {
  const paths = allManifestPaths()

  it("finds the bundled and in-tree manifests at all", () => {
    expect(paths.some((p) => p.includes("bundled-apps/invoicing/"))).toBe(true)
    expect(paths.some((p) => p.includes("apps/tickets/"))).toBe(true)
  })

  for (const path of paths) {
    const rel = path.slice(REPO.length + 1)
    it(`${rel}: parses and validates against the runtime manifest schema`, () => {
      const manifest = load(path)
      expect(validateAppManifest(manifest).error ?? null).toBeNull()
    })

    it(`${rel}: no readOnly tool is gated or declares a write target`, () => {
      const offenders = Object.entries(load(path).tools ?? {})
        .filter(([, t]) => t.readOnly === true)
        .filter(([, t]) => t.gated === true || t.conditionalGate === true || !!t.writesToTable)
        .map(([name]) => name)
      expect(offenders).toEqual([])
    })
  }

  for (const [app, expected] of Object.entries(READ_ONLY)) {
    it(`${app}: exactly the audited read-only tools carry readOnly`, () => {
      const tools = load(manifestPath(app)).tools ?? {}
      for (const name of expected) expect(Object.keys(tools)).toContain(name)
      const marked = Object.entries(tools)
        .filter(([, t]) => t.readOnly === true)
        .map(([name]) => name)
        .sort()
      expect(marked).toEqual([...expected].sort())
    })
  }

  for (const [app, writers] of Object.entries(READS_THAT_WRITE)) {
    it(`${app}: reads that write stay unmarked`, () => {
      const tools = load(manifestPath(app)).tools ?? {}
      for (const name of writers) {
        expect(Object.keys(tools)).toContain(name)
        expect(tools[name].readOnly).toBeUndefined()
      }
    })
  }

  it("a tool named like a read is marked readOnly or listed as a reviewed read that writes", () => {
    const unreviewed = paths.map(load).flatMap((m) =>
      Object.entries(m.tools ?? {})
        .filter(([name, t]) => readsByName(name) && t.readOnly !== true && !t.writesToTable)
        .filter(([name]) => !(READS_THAT_WRITE[m.name] ?? []).includes(name))
        .map(([name]) => `${m.name}:${name}`),
    )
    expect(unreviewed).toEqual([])
  })

  it("the read-name net catches what it should", () => {
    expect(readsByName("get_shipment")).toBe(true)
    expect(readsByName("track")).toBe(true)
    expect(readsByName("listForContact")).toBe(true)
    expect(readsByName("settings_sender_address_set")).toBe(false)
    expect(readsByName("set_status")).toBe(false)
    expect(readsByName("ensureSummary")).toBe(false)
  })

  it("apps outside the audit carry no readOnly mark", () => {
    const audited = new Set(Object.keys(READ_ONLY))
    const stray = paths
      .map(load)
      .filter((m) => !audited.has(m.name))
      .flatMap((m) =>
        Object.entries(m.tools ?? {})
          .filter(([, t]) => t.readOnly === true)
          .map(([name]) => `${m.name}:${name}`),
      )
    expect(stray).toEqual([])
  })
})
