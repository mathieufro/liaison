// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A GATED TOOL CALL MUST NOT BE ACCEPTED WHEN THE DATA IT NEEDS IS MISSING.
 *
 * A gated tool does not execute when the agent calls it: it parks a pending
 * approval that a human decides later. So any validation that lives only in the
 * handler runs AFTER the human has clicked approve, and the approver is the one
 * who meets an error that only the agent could have fixed. It happened in the
 * field: an approver was handed a Knowledge document card, approved it, and got
 * "Organization Knowledge documents must be explicitly access-classified".
 *
 * The platform's answer is the stage-time `preflight` (execute-tool.ts), which
 * runs BEFORE the approval row is created for any tool that is `gated` or
 * `conditionalGate`. This guard keeps that honest: every gated tool in every
 * manifest either declares a preflight, or is listed below with the reason it
 * needs none. A new gated tool fails this test until its author makes that
 * choice deliberately.
 */
import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..", "..")
const MANIFEST_ROOTS = [
  path.join(repoRoot, "apps", "api", "src", "apps"),
  path.join(repoRoot, "bundled-apps"),
]

/**
 * Gated tools that legitimately carry no manifest `preflight`. Every entry
 * states WHY. Removing a tool's preflight without adding it here fails the
 * guard; so does adding a new gated tool without deciding either way.
 */
const NO_PREFLIGHT_NEEDED: Record<string, string> = {
  // Validated at stage time through a dedicated read-only bridge validator
  // (knowledge_create_validate / knowledge_update_validate) rather than a
  // manifest preflight: these tools gate from INSIDE their handler, and the
  // handler refuses before it parks. See apps/knowledge/handlers.ts.
  "knowledge:create": "stage-time guard via knowledge_create_validate",
  "knowledge:update": "stage-time guard via knowledge_update_validate",
  // Only post-approval failure is a document deleted between staging and the
  // decision: a genuine race, not knowable at staging.
  "knowledge:archive": "only genuine races",

  // The authoritative outbound-URL guard needs node:dns and undici, which a
  // sandboxed app cannot reach; the manifest params pattern enforces a strict
  // subset (https, no loopback or private literals) before gating.
  "mcp-manager:add_connection": "params schema pattern enforces the knowable subset",

  // Validate before they call ctx.requestApproval, so an incomplete call never
  // reaches a human in the first place.
  "invoicing:drafts_create": "validates before parking",
  "invoicing:drafts_update": "validates before parking",
  "invoicing:drafts_discard": "validates before parking",
  "invoicing:quote_issue": "validates before parking",
  "invoicing:quote_create_and_issue": "validates before parking",
  "invoicing:credit_note_issue": "validates before parking",
  "invoicing:credit_note_create_and_issue": "validates before parking",
  // conditionalGate since the scope-taint declaration sweep: the handler parks an
  // approval only above issuer.po_approval_threshold_minor, and runs the same
  // issue preflight as quote_issue (preflightIssueFromDraft /
  // preflightCreateAndIssueParams) before it calls requestApproval.
  "invoicing:po_issue": "validates before parking",
  "invoicing:po_create_and_issue": "validates before parking",

  // Params schema covers everything knowable (required fields, enums, ranges).
  "ads:create_campaign": "params schema covers it",
  "ads:create_ad": "params schema covers it",
  "ads:create_creative": "params schema covers it",
  "ads:upload_image": "params schema covers it",
  "ads:set_status": "params schema covers it",
  "ads:create_lookalike_audience": "params schema covers it",
  "ads:google_create_adgroup": "params schema covers it",
  "ads:google_create_ad": "params schema covers it",
  "ads:google_update_budget": "params schema covers it",
  "ads:google_create_conversion_action": "params schema covers it",
  "ads:manual_spend_add": "params schema covers it",
  "shopify:products_create": "params schema covers it",
  "shopify:variants_create": "params schema covers it",
  "shopify:discounts_create": "params schema covers it",
  "shopify:discounts_bulk_create": "params schema covers it",
  "shopify:returns_request": "params schema covers it",
  "shopify:metafields_set": "params schema covers it",
  "shopify:metafields_delete": "params schema covers it",
  "shopify:fulfillments_update_tracking": "params schema covers it",
  "shopify:draft_orders_update": "params schema covers it",
  "shopify:customers_email_marketing_consent_update": "params schema covers it",
  "shopify:customers_sms_marketing_consent_update": "params schema covers it",
  "pennylane:supplier_invoice_upload": "params schema covers it",

  // Idempotent no-ops: a missing target is a silent success, not an error, so
  // there is nothing a preflight could usefully refuse.
  "shopify:staff_overrides_delete": "idempotent no-op on a missing row",
  "shopify:connection_disconnect": "idempotent no-op when not installed",

  // Only genuine races: the state can legitimately change between staging and
  // the approval decision, so the handler guard is the right and only place.
  "shopify:draft_orders_send": "only genuine races",
  "shopify:apply_seed_suggestion": "only genuine races",

  // Never refuses after approval: it saves what it is given and reports the
  // address fields still missing in its result.
  "boxtal:settings_sender_address_set": "reports missing fields, never refuses",

  // Recorded gaps, not a clean bill of health: admin settings writes gated by
  // the security pass whose handlers still refuse knowable input only at
  // execution (a mailbox inbox without emailAddress or connectedAccountId, an
  // unknown inbox id, an empty key label, a document that does not exist or is
  // already issued). Each needs a stage-time preflight running those checks.
  "tickets:inboxes.create": "recorded gap: kind-dependent required fields checked in the handler",
  "tickets:inboxes.update": "recorded gap: inbox existence and routing checked in the handler",
  "tickets:apiKeys.create": "recorded gap: label checked in the handler",
  "invoicing:documents_update": "recorded gap: existence and frozen status checked in the handler",
  // E-invoicing. The send and the booking are never staged by an agent's call
  // to the gated tool: einvoice_send_request (and the issue flow) runs the
  // readiness checks and parks the send only for a sendable document, binding
  // its legal original's fingerprint, buyer SIREN and routing address; the
  // daily booking job parks a batch it just built. What can still fail after
  // approval is a change in between (einvoice_approval_stale).
  "invoicing:einvoice_send": "staged by einvoice_send_request after its checks; only genuine races",
  "invoicing:einvoice_book_batch":
    "staged by the booking job for a batch it built; only genuine races",
  "invoicing:einvoice_send_batch":
    "staged by the daily send job for a batch of sendable documents it built; only genuine races",
  // conditionalGate: checksum, SIRET-of-SIREN and registry checks run in the
  // handler before it calls requestApproval.
  "invoicing:counterparty_identity_set": "validates before parking",
  // Batch backfills: every field optional with a default, dry_run first; a
  // document that cannot be processed is reported in the result, never refused.
  "invoicing:einvoicing_backfill_identities": "params schema covers it; reports, never refuses",
  "invoicing:einvoicing_backfill_legacy_originals":
    "params schema covers it; per-document failures are reported, never refused",
  "invoicing:counterparty_territory_set":
    "recorded gap: contact existence and a non-blank reason checked in the handler",
  "invoicing:einvoicing_settings_set":
    "recorded gap: date formats and at-least-one-setting checked in the handler",
  "pennylane:webhooks_setup":
    "recorded gap: a missing callback_base_url (none recorded) is refused in the handler",
  "google-drive:choose_shared_drives":
    "recorded gap: the org account's existence and its membership of each named drive are checked in the handler",
}

/** Fixture apps used to exercise the runtime itself, not real product surface. */
const FIXTURE_APPS = new Set(["test", "test-bridge-a", "test-bridge-b", "example"])

type GatedTool = { app: string; tool: string; hasPreflight: boolean }

function collectGatedTools(): GatedTool[] {
  const found: GatedTool[] = []
  for (const root of MANIFEST_ROOTS) {
    if (!fs.existsSync(root)) continue
    for (const app of fs.readdirSync(root)) {
      const manifestPath = path.join(root, app, "app.manifest.json")
      if (!fs.existsSync(manifestPath)) continue
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        tools?: Record<string, { gated?: boolean; conditionalGate?: boolean; preflight?: string }>
      }
      for (const [tool, def] of Object.entries(manifest.tools ?? {})) {
        if (def.gated !== true && def.conditionalGate !== true) continue
        found.push({ app, tool, hasPreflight: typeof def.preflight === "string" })
      }
    }
  }
  return found
}

describe("gated tools validate at staging, not in the approver's hands", () => {
  const gated = collectGatedTools().filter((t) => !FIXTURE_APPS.has(t.app))

  it("finds the gated surface (the scan itself is not silently empty)", () => {
    expect(gated.length).toBeGreaterThan(50)
  })

  it("every gated tool declares a preflight or an explicit reason it needs none", () => {
    const unexplained = gated
      .filter((t) => !t.hasPreflight && !(`${t.app}:${t.tool}` in NO_PREFLIGHT_NEEDED))
      .map((t) => `${t.app}:${t.tool}`)
    expect(unexplained).toEqual([])
  })

  it("the allowlist has no stale entries (each named tool still exists and is still gated)", () => {
    const live = new Set(gated.map((t) => `${t.app}:${t.tool}`))
    const stale = Object.keys(NO_PREFLIGHT_NEEDED).filter((k) => !live.has(k))
    expect(stale).toEqual([])
  })

  it("no allowlist entry is blank: every exemption states a reason", () => {
    const blank = Object.entries(NO_PREFLIGHT_NEEDED)
      .filter(([, reason]) => reason.trim().length < 10)
      .map(([k]) => k)
    expect(blank).toEqual([])
  })
})
