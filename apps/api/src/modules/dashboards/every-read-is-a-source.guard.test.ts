// SPDX-License-Identifier: FSL-1.1-ALv2
//
// EVERY READ IS A DASHBOARD SOURCE. A tool any app declares as a read (`readOnly`, no write
// target), in-tree, bundled or kernel, is either a source a dashboard block can save and run
// on, or it sits on the reviewed exclusion list below with its reason. A new read that is
// neither fails here, so a feature cannot ship a list or a figure people can ask about in
// chat but never chart.
//
// A source is what `checkToolSource` (sources.ts) accepts at save and at every run: an app read
// that passes `dashboardSourceRefusal` and hands out no secret, or a kernel read on
// `KERNEL_DASHBOARD_SOURCES`. A source returns a list a block charts (the list itself, or
// items / rows / data / its only list, or one a block names by `rowsPath`) or one record or
// set of figures a metric reads by path (transform.ts `extractRows`); the reads made sources
// with this rule each have a test that a block saves and runs on them
// (every-read-sources.test.ts). A read whose answer is a set of figures, a keyed map or one
// figure carries them as a top-level `rows` list too, so a block charts it; each such read's
// stand-in (__fixtures__/read-rows.ts) must give a block rows, checked here.
//
// An exclusion names one of the reasons a read may stay off dashboards, and nothing else:
//   human turn        it acts on the turn or the window of the person asking (a picker, a guide)
//   DM only           private to one person or one conversation's participants
//   trust boundary    a secret, an agent's own machinery or memory, the person's own computer
//                     or accounts, outside text, or a tool that dispatches another tool
//   web read          it reads the public web
//   contract-only op  reached only through a provider contract another app or the kernel calls
//   spec rule         the dashboard spec keeps it off a page (a block never reads another
//                     block's output; a figure the spec keeps in chat)
// A flag set for convenience is not a reason: the read becomes a source instead. Every
// exclusion is also refused at run time (its declaration, the kernel list, SECRET_READS or
// DOCUMENT_TEXT_READS),
// so the list documents the refusals and cannot hide a source.
//
// The catalog is read where it lives: kernel and in-tree app tools from the registry of an
// initialised org (their registration sets flags a manifest does not), bundled apps from their
// manifests as registration copies them (runtime.ts).

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { defineAppBuilderTools } from "~/modules/app-builder/tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import { dashboardSourceRefusal } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { READ_ROWS_STAND_INS } from "~/modules/dashboards/__fixtures__/read-rows"
import {
  DOCUMENT_TEXT_READS,
  KERNEL_DASHBOARD_SOURCES,
  SECRET_READS,
} from "~/modules/dashboards/sources"
import { extractRows, unfenceSourceResult } from "~/modules/dashboards/transform"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

type Tool = NonNullable<ReturnType<typeof toolRegistry.get>>
type Reason =
  | "human turn"
  | "DM only"
  | "trust boundary"
  | "web read"
  | "contract-only op"
  | "spec rule"

const REASONS: ReadonlySet<Reason> = new Set([
  "human turn",
  "DM only",
  "trust boundary",
  "web read",
  "contract-only op",
  "spec rule",
])

/** Reads that stay off dashboards, each with its reviewed reason. */
const EXCLUDED: ReadonlyArray<{ tool: string; reason: Reason; why: string }> = [
  // ── App reads ──
  ...["calls", "monitoring", "projects"].map((app) => ({
    tool: `${app}:webhook_info`,
    reason: "trust boundary" as const,
    why: "returns the webhook signing secret to the operator setting up the sender; a secret never goes on a page or into the dashboard cache",
  })),
  ...[
    "einvoicing_find",
    "einvoicing_find_booking",
    "einvoicing_received_get",
    "einvoicing_received_list",
    "einvoicing_registration_status",
    "einvoicing_status",
  ].map((op) => ({
    tool: `pennylane:${op}`,
    reason: "contract-only op" as const,
    why: "an e-invoicing provider op the invoicing app calls through its contract; marked contractOnly and internal",
  })),
  {
    tool: "github:github_read_file",
    reason: "trust boundary",
    why: "one repository file's text: outside text, fenced for the agent that asked for it, with no rows a block can chart",
  },
  {
    tool: "gitlab:gitlab_read_file",
    reason: "trust boundary",
    why: "one repository file's text: outside text, fenced for the agent that asked for it, with no rows a block can chart",
  },
  {
    tool: "google-drive:read",
    reason: "trust boundary",
    why: "one Drive file's text (a sheet as CSV, a doc as plain text): outside text, fenced for the agent that asked for it",
  },
  {
    tool: "api-connector:connector_adapter_reference",
    reason: "human turn",
    why: "the connector authoring guide, one section of reference text the adapter's author reads in their own turn; a guide, not records",
  },
  {
    tool: "example:items_count_on_turn",
    reason: "human turn",
    why: "the sample app's tool that runs only on a person's own turn; a dashboard is no one's turn",
  },
  {
    tool: "example:items_count_in_dm",
    reason: "DM only",
    why: "the sample app's tool an agent runs only in its DM with the person",
  },
  {
    tool: "projects:reconcile_facts",
    reason: "human turn",
    why: "a reconcile starts only on a person's own turn in their DM or coding agent; a dashboard would read the period's work on a schedule, which no surface does",
  },
  ...["timesheet_get", "timesheet_export"].map((name) => ({
    tool: `projects:${name}`,
    reason: "DM only" as const,
    why: "the dated sheet holds each person's hours by day; it is read only by the project's owner, lead or finance, on their own turn in a DM",
  })),
  {
    tool: "projects:reconcile_get",
    reason: "DM only",
    why: "a reconcile card is read in the DM it was proposed in, by its creator or a holder of the reconcile scope",
  },
  {
    tool: "projects:margin_get",
    reason: "spec rule",
    why: "margin is finance's figure and stays in chat, in a DM: the spec counts any page or dashboard showing it as a finding",
  },
  {
    tool: "projects:cost_rates_list",
    reason: "DM only",
    why: "each person's cost rate, for finance in a DM only; never shown on a board, a page or a task",
  },
  {
    tool: "invoicing:project_invoiced_get",
    reason: "trust boundary",
    why: "an internal read the projects app reaches through its declared cross-app call; people read invoices through documents_search",
  },
  // ── Kernel reads ──
  {
    tool: "kernel:contacts_identity",
    reason: "contract-only op",
    why: "an app's internal identity check (id, email, company id) other apps call; kernel contacts_search is the source",
  },
  {
    tool: "kernel:suggest_next_steps",
    reason: "human turn",
    why: "adds reply chips to the turn it runs in and reads no records",
  },
  {
    tool: "kernel:call_tool",
    reason: "trust boundary",
    why: "dispatches another tool by name; a block names its own source so the source check sees the real tool",
  },
  {
    tool: "kernel:tool_search",
    reason: "trust boundary",
    why: "loads tools into the running agent's turn; agent machinery that reads no records",
  },
  {
    tool: "kernel:data_query",
    reason: "trust boundary",
    why: "the agent store's read; a block reads a collection through the store source, which applies the collection's declared readability, read scope and taint",
  },
  {
    tool: "kernel:data_get",
    reason: "trust boundary",
    why: "the agent store's read of one document; a block reads a collection through the store source",
  },
  ...["memory_view", "memory_search", "memory_open", "memory_episode"].map((name) => ({
    tool: `kernel:${name}`,
    reason: "trust boundary" as const,
    why: "an agent's own memory, read inside that agent's run",
  })),
  {
    tool: "kernel:user_memory_get",
    reason: "DM only",
    why: "what the agent remembers about one person, private to that person",
  },
  {
    tool: "kernel:threads_read",
    reason: "DM only",
    why: "the messages of one conversation, private to its participants; threads_list and threads_search are the sources",
  },
  {
    tool: "kernel:mail_attachment_read",
    reason: "trust boundary",
    why: "the content of a received mail's attachment: outside text, fenced for the agent",
  },
  {
    tool: "kernel:outside_text_sources",
    reason: "trust boundary",
    why: "fenced excerpts of the outside text one conversation read, for that conversation's approvals",
  },
  {
    tool: "kernel:analyze_media",
    reason: "trust boundary",
    why: "sends a file to a model provider to describe it",
  },
  {
    tool: "kernel:export",
    reason: "trust boundary",
    why: "builds a downloadable archive of the org's data; a page shows records, not a bulk export",
  },
  ...[
    "computer_session_list",
    "computer_session_read",
    "computer_session_import_list",
    "find_repos_on_my_computer",
    "list_my_remote_repos",
  ].map((name) => ({
    tool: `kernel:${name}`,
    reason: "trust boundary" as const,
    why: "reads the person's own computer or the accounts it holds, for that person's session",
  })),
  {
    tool: "kernel:open_app",
    reason: "human turn",
    why: "opens a view in the asking person's window",
  },
  ...["google_setup", "mailbox_setup", "shopify_setup"].map((name) => ({
    tool: `kernel:${name}`,
    reason: "human turn" as const,
    why: "setup steps for the person connecting an account, in their own turn; reads no records",
  })),
  {
    tool: "kernel:dashboards_sources",
    reason: "spec rule",
    why: "the catalog of reads a block may name, for the author building a block; a page shows records, never its own source catalog",
  },
  ...["dashboards_preview_block", "dashboards_snapshot"].map((name) => ({
    tool: `kernel:${name}`,
    reason: "spec rule" as const,
    why: "computes dashboard blocks; a block reads a source, never another block's output",
  })),
]

/** A manifest tool as registration keeps it (runtime.ts), for the fields the source rule reads. */
function asRegistered(app: string, name: string, t: Record<string, unknown>): Tool {
  const entry: Record<string, unknown> = {
    appName: app,
    name,
    description: String(t.description ?? ""),
    requiredScopes: (t.requiredScopes as string[]) ?? [],
    handler: async () => null,
  }
  for (const k of ["gated", "conditionalGate", "externalEffect", "contractOnly", "agentVisible"]) {
    if (typeof t[k] === "boolean") entry[k] = t[k]
  }
  if (typeof t.trustBoundary === "string") entry.trustBoundary = t.trustBoundary
  if (typeof t.writesToTable === "string") entry.writesToTable = t.writesToTable
  // Bundled apps are first-party: registration honours their readOnly claim.
  if (t.readOnly === true) entry.readOnly = true
  return entry as unknown as Tool
}

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..")

function bundledReads(): Map<string, Tool> {
  const out = new Map<string, Tool>()
  const root = join(REPO, "bundled-apps")
  for (const dir of readdirSync(root)) {
    const file = join(root, dir, "app.manifest.json")
    if (!existsSync(file)) continue
    const m = JSON.parse(readFileSync(file, "utf8")) as {
      name: string
      tools?: Record<string, Record<string, unknown>>
    }
    for (const [name, t] of Object.entries(m.tools ?? {})) {
      out.set(`${m.name}:${name}`, asRegistered(m.name, name, t))
    }
  }
  return out
}

const isRead = (t: Tool) => t.readOnly === true && typeof t.writesToTable !== "string"

/** Every read of the catalog, by `app:tool`. */
const reads = new Map<string, Tool>()
/** Every kernel tool the registry holds, read or not. */
const kernelTools = new Set<string>()

beforeAll(async () => {
  await acquireTestLock()
  const { orgId } = await minimal.secondOrg({ name: "Every Read Guard Org" })
  await ensureAppsForOrg(orgId)
  // The app builder's tools exist only while custom apps are on; list them either way.
  defineAppBuilderTools(orgId)
  for (const [[, app, name], tool] of toolRegistry.entriesOf(orgId)) {
    if (app === "kernel") kernelTools.add(name)
    if (isRead(tool)) reads.set(`${app}:${name}`, tool)
  }
  for (const [full, tool] of bundledReads()) if (isRead(tool)) reads.set(full, tool)
})

afterAll(async () => {
  await releaseTestLock()
})

/** Is `full` a source by the rule checkToolSource applies (the viewer's scopes aside)? */
function isSource(full: string, tool: Tool): boolean {
  if (SECRET_READS.has(full) || DOCUMENT_TEXT_READS.has(full)) return false
  if (full.startsWith("kernel:") && !KERNEL_DASHBOARD_SOURCES.has(full.slice("kernel:".length)))
    return false
  return dashboardSourceRefusal(tool) === null
}

describe("every read is a dashboard source", () => {
  const excluded = new Map(EXCLUDED.map((e) => [e.tool, e]))

  it("finds the catalog's reads: kernel, in-tree and bundled", () => {
    expect(reads.has("kernel:users_list")).toBe(true)
    expect(reads.has("tickets:search")).toBe(true)
    expect(reads.has("invoicing:documents_search")).toBe(true)
    expect(reads.size).toBeGreaterThan(250)
  })

  it("each read is a source or a reviewed exclusion, never both, never neither", () => {
    const neither: string[] = []
    const both: string[] = []
    for (const [full, tool] of reads) {
      const source = isSource(full, tool)
      if (!source && !excluded.has(full)) neither.push(full)
      if (source && excluded.has(full)) both.push(full)
    }
    expect({ neither: neither.sort(), both: both.sort() }).toEqual({ neither: [], both: [] })
  })

  it("names only reads that exist", () => {
    expect(EXCLUDED.map((e) => e.tool).filter((t) => !reads.has(t))).toEqual([])
    expect(excluded.size).toBe(EXCLUDED.length)
    // The kernel list names kernel reads only: never a write, never a tool that is gone.
    expect([...KERNEL_DASHBOARD_SOURCES].filter((n) => !reads.has(`kernel:${n}`))).toEqual([])
    expect([...SECRET_READS].filter((t) => !reads.has(t))).toEqual([])
    expect([...DOCUMENT_TEXT_READS.keys()].filter((t) => !reads.has(t))).toEqual([])
  })

  it("an exclusion names an allowed reason and says why", () => {
    for (const e of EXCLUDED) {
      expect(REASONS.has(e.reason)).toBe(true)
      expect(e.why.length).toBeGreaterThan(20)
    }
  })

  it("a read hidden from agents is still a source: hiding is a catalog choice", () => {
    const hidden = [...reads].filter(([full, t]) => t.agentVisible === false && !excluded.has(full))
    expect(hidden.length).toBeGreaterThan(0)
    for (const [full, t] of hidden)
      expect({ full, source: isSource(full, t) }).toEqual({ full, source: true })
  })

  it("a contract op or a trust-boundary read is excluded with that reason", () => {
    for (const [full, t] of reads) {
      if (!t.contractOnly && t.trustBoundary !== "internal" && t.trustBoundary !== "agent") continue
      expect({ full, reason: excluded.get(full)?.reason }).toEqual({
        full,
        reason: t.contractOnly ? "contract-only op" : "trust boundary",
      })
    }
  })
})

describe("a source's answer has rows a block can use", () => {
  it("each stand-in names a read that is a source", () => {
    for (const st of READ_ROWS_STAND_INS) {
      const full = `${st.app}:${st.tool}`
      const tool = reads.get(full)
      expect({ full, read: tool !== undefined }).toEqual({ full, read: true })
      if (tool) expect({ full, source: isSource(full, tool) }).toEqual({ full, source: true })
    }
  })

  it("each stand-in gives a block its rows, read the way a block reads them", () => {
    for (const st of READ_ROWS_STAND_INS) {
      const { rows } = extractRows(unfenceSourceResult(st.result))
      expect({
        read: `${st.app}:${st.tool}`,
        variant: st.variant,
        rows: rows?.length ?? null,
      }).toEqual({ read: `${st.app}:${st.tool}`, variant: st.variant, rows: st.rows })
      expect(st.rows).toBeGreaterThan(0)
    }
  })
})
