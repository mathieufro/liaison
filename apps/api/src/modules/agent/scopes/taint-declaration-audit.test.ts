// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeAll, describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { checkToolScopeTaint } from "~/modules/agent/scopes/scope-taint"
import { toolRegistry } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"
import { createTestOrg } from "~/tests/helpers/org"

// FULL-REGISTRY TAINT DECLARATION AUDIT (2026-09-25).
//
// A tool that declares neither `readOnly`, `writesToTable` nor `gated` is judged by the scope
// taint rule as a write to an UNKNOWN table (scope-taint.ts, UNDECLARED_WRITE_TARGET), so it is
// refused on every tainted turn, whatever it really writes. That is how `threads_create` came
// back E_SCOPE_TAINT_BLOCKED right after a `users_search` in production: the refusal was about
// the missing declaration, never about a real disclosure. `taintFree` does not count: it says
// the tool reads no org data, not that it writes nothing, and the rule still refuses it.
//
// This sweeps what an org actually registers: every kernel tool and every host app through
// createTestOrg, plus every bundled app registered from source (same pattern as
// required-scopes-registry-audit.test.ts). A new tool without a declaration fails here, before
// it can fail a user.

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..")
const BUNDLED_ROOT = join(REPO_ROOT, "bundled-apps")
// Test-harness apps (apps/api/test-support/apps) are registered into test orgs only and never
// ship in the image; they are fixtures, not tools a user's turn can reach.
const TEST_SUPPORT_APPS = new Set(
  readdirSync(join(REPO_ROOT, "apps", "api", "test-support", "apps"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name),
)

function bundledAppNames(): string[] {
  return readdirSync(BUNDLED_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => {
      try {
        readFileSync(join(BUNDLED_ROOT, name, "app.manifest.json"))
        return true
      } catch {
        return false
      }
    })
    .sort()
}

function bundledDescriptor(name: string): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(BUNDLED_ROOT, name, "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  const version = (manifest.version as string) ?? "0.1.0"
  return {
    ...manifest,
    trusted: false,
    // What init.ts stamps on a catalog install whose artifact is the image's own tarball: the
    // platform's voucher, which is what lets runtime.ts honour the manifest's `readOnly`.
    _firstParty: true,
    _format: "manifest",
    _bundlePath: join(BUNDLED_ROOT, name, version, "bundle.js"),
  }
}

// WRITES THAT LEAVE LIAISON, left undeclared on purpose. Each sends the turn's data, or data it
// lets the agent choose, to a system outside Liaison: directly (a fetch, a mail send, a Shopify
// or Google API call), through a cross-app call to such a tool, or through a job that later
// ships the written value out without a human decision (the calendar push, the social pollers).
// A `writesToTable` here would describe only the local half of the write. Undeclared, each is
// refused on any tainted turn. Adding a name means reading its handler and finding outbound
// traffic; removing one means proving there is none.
// READS OF A FIXED THIRD-PARTY API, declared readOnly on purpose: each sends only an id or a
// report query (account level, date range, fields) to the provider's own API host and writes
// back nothing a person did not already have (best-effort status refresh). An injected turn gains no channel to a host it
// chooses, so these run on a tainted turn. Moving one back means finding agent-chosen egress.
const FIXED_HOST_READS = new Set([
  "boxtal:track", // Boxtal tracking API, by tracking number
  "boxtal:get_shipment", // Boxtal order API, by shipment id
  "boxtal:prep_list", // Boxtal quote API, read
  "ads:insights_query", // Meta insights on the fixed Graph host (large pulls: a transient report run)
  "ads:metrics_run", // the formula's inputs through the ads/shopify reads; writes nothing
  "kernel:ai_models_get", // OpenRouter's whole model list, no query sent; searched locally
])

const EXTERNAL_WRITES = new Set([
  "kernel:web_fetch", // the URL itself is egress: a query string can carry what the turn read
  "kernel:web_search", // the query goes to the search provider (registered only with an Exa key)
  "kernel:web_watch", // fetches a URL of the agent's choosing each tick
  "shopify:order_note_set", // sets a Shopify order's staff note
  "shopify:webhooks_repair", // registers webhook subscriptions with Shopify
  "google-drive:upload", // creates a file in the connected Drive
  "ads:audience_erasure_sweep", // calls Meta to erase audience members
  "calendar:create_event", // queues calendar-push: the event goes to Google
  "calendar:update_event", // same
  "calendar:delete_event", // same
  "calendar:set_selected", // starts or stops the Google watch channel
  "calendar:retry_import", // queues calendar-import: lists the account's calendars at Google
  "knowledge:add_folder_source", // harvests a Drive folder / GitLab path it names
  "knowledge:source_link_create", // probes the remote document it names
  "mail:composeForApp", // sends mail
  "invoicing:quote_create_and_issue", // creates a Shopify draft order
  "social:monitor_terms_add", // the term is sent to the platforms by the discovery-sync job
  "social:watch_object", // the object is polled on the platform by the watch-poller job
  "boxtal:webhooks_repair", // registers Boxtal webhook subscriptions
  "boxtal:quote_batch", // Boxtal quote API
  "boxtal:prep_sync", // Boxtal quote API
  "boxtal:prep_set_category", // Boxtal quote API
  "boxtal:prep_add_shipment", // Boxtal quote API
  "boxtal:print_pack", // downloads Boxtal documents
  "boxtal:print_pack_batch", // same
  "boxtal:import_shipments", // Boxtal order API
  "boxtal:import_label_document", // Boxtal document API
  "boxtal:prep_set_note", // shopify:order_note_set
  "boxtal:settings_sender_address_set", // the address is sent on every later Boxtal quote and shipment
  "pennylane:einvoicing_submit", // sends the e-invoice to the Pennylane PA
  "pennylane:einvoicing_advance", // moves the e-invoice on at Pennylane
  "pennylane:einvoicing_book", // books the sale in Pennylane
  "pennylane:einvoicing_received_set_status", // refuses, disputes or approves a supplier invoice at Pennylane
])

// WRITES A MANIFEST MAY NOT NAME. These app tools write a KERNEL table, and runtime.ts drops a
// manifest `writesToTable` outside the app's own schema, so that no app can pose as a kernel sink
// (runtime-manifest.test.ts pins it). They stay undeclared and are refused on a tainted turn,
// exactly as a declared non-enforcing table would be. The one exception is a FIRST-PARTY app
// naming a kernel ENFORCING sink (the vouched kernel sink): projects:comment and
// projects:checklist_set_validation declare kernel.messages and are pinned below.
const KERNEL_TABLE_WRITES = new Set([
  "google-drive:import", // a kernel.files row
  "google-drive:drive_picker", // a one-time page link for the person
  "google-drive:picker_remove", // the account's metadata (picked items) and its Knowledge sync
  "google-drive:shared_drives_save", // the org account's metadata (chosen shared drives)
  "mail:export_conversations", // a kernel.files row
  "pennylane:einvoicing_received_file", // a kernel.files row (the received original or rendering)
  "example:resolve_contact", // may create a kernel.contacts row
  // Writes the call's knowledge document through a nested knowledge:update, which is judged
  // on its own dispatch; the tool itself stays undeclared and is refused on a tainted turn.
  "calls:calls_set_links",
  // Settings-page writes (agentVisible: false), refused on a tainted turn.
  "knowledge:synced_sources.archive", // archives a synced source (knowledge's own table)
  "knowledge:synced_sources.run_now", // a kernel job row (the forced harvest)
  "mail:providers.set", // kernel.apps (the mail app's provider config)
  "database:report_access_set", // the app's own store document (Report access rules)
  "mail:suppression_add", // a kernel.suppressions row (an opt-out)
])

let orgId: string
const bundled = bundledAppNames()

function orgTools() {
  return [...toolRegistry.entries()].filter(([[org]]) => org === orgId)
}

describe("taint declaration audit", () => {
  beforeAll(async () => {
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    const org = await createTestOrg()
    orgId = org.id
    await registerApps(bundled.map(bundledDescriptor) as never, orgId)
  })

  it("the sweep covers kernel tools and every bundled app (non-vacuous)", () => {
    const apps = new Set(orgTools().map(([[, app]]) => app))
    expect(bundled.length).toBeGreaterThanOrEqual(5)
    // An app that declares no tool (a connector whose tools come later) registers none.
    const withTools = bundled.filter(
      (name) => Object.keys((bundledDescriptor(name).tools as object | undefined) ?? {}).length > 0,
    )
    expect(withTools.length).toBeGreaterThanOrEqual(5)
    expect(withTools.filter((name) => !apps.has(name))).toEqual([])
    expect(apps.has("kernel")).toBe(true)
    expect(orgTools().length).toBeGreaterThan(100)
  })

  it("every registered tool declares readOnly, writesToTable or gated", () => {
    const offenders = orgTools()
      .filter(([[, app]]) => !TEST_SUPPORT_APPS.has(app))
      .filter(([[, app, name]]) => !EXTERNAL_WRITES.has(`${app}:${name}`))
      .filter(([[, app, name]]) => !KERNEL_TABLE_WRITES.has(`${app}:${name}`))
      .filter(
        ([, def]) =>
          def.readOnly !== true && typeof def.writesToTable !== "string" && def.gated !== true,
      )
      .map(([[, app, name]]) => `${app}:${name}`)
      .sort()
    expect(offenders).toEqual([])
  })

  it("the exceptions are still registered and still undeclared", () => {
    for (const key of [...EXTERNAL_WRITES, ...KERNEL_TABLE_WRITES]) {
      const [app, name] = key.split(":") as [string, string]
      const def = toolRegistry.get([orgId, app, name])
      // web_search exists only where an Exa key resolves; every other exception always does.
      if (def === undefined && key === "kernel:web_search") continue
      expect({ key, registered: def !== undefined }).toEqual({ key, registered: true })
      expect({ key, readOnly: def?.readOnly, writesToTable: def?.writesToTable }).toEqual({
        key,
        readOnly: undefined,
        writesToTable: undefined,
      })
    }
  })

  it("the fixed-host reads stay registered and declared readOnly", () => {
    for (const key of FIXED_HOST_READS) {
      const [app, name] = key.split(":") as [string, string]
      const def = toolRegistry.get([orgId, app, name])
      expect({ key, registered: def !== undefined, readOnly: def?.readOnly }).toEqual({
        key,
        registered: true,
        readOnly: true,
      })
    }
  })

  it("threads_create declares its real sink, kernel.messages", () => {
    const def = toolRegistry.get([orgId, "kernel", "threads_create"])
    expect(def?.writesToTable).toBe("kernel.messages")
  })

  it("projects' task comments declare the vouched kernel sink and pass a tainted turn", () => {
    for (const name of ["comment", "checklist_set_validation"]) {
      const def = toolRegistry.get([orgId, "projects", name])
      expect({ name, writesToTable: def?.writesToTable }).toEqual({
        name,
        writesToTable: "kernel.messages",
      })
      expect({ name, refused: checkToolScopeTaint(["a:b:read"], def ?? {}) }).toEqual({
        name,
        refused: null,
      })
    }
  })

  it("projects task writes are low sensitivity and pass a tainted turn; a project write does not", () => {
    for (const name of ["create", "update", "move", "add_dependency", "checklist_add_items"]) {
      const def = toolRegistry.get([orgId, "projects", name])
      expect({ name, refused: checkToolScopeTaint(["a:b:read"], def ?? {}) }).toEqual({
        name,
        refused: null,
      })
    }
    const createProject = toolRegistry.get([orgId, "projects", "createProject"])
    expect(checkToolScopeTaint(["a:b:read"], createProject ?? {})?.code).toBe(
      "E_SCOPE_TAINT_BLOCKED",
    )
  })
})
