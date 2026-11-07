// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Tool side effects are enforced by the host, enumerated at runtime.
//
// 1. A read-only run: every method of the sandbox host bridge is refused,
//    guards itself, or is a reviewed read. A new bridge method fails this file
//    until it is classified.
// 2. A tool that declares itself readOnly cannot write: the write is refused at
//    the boundary whatever run it is in, because the marker is a claim the tool
//    makes about itself.
// 3. Tools projected from a remote MCP server are gated by default, whatever
//    the server's own annotations say.
// 4. Every ungated tool with an outward channel (externalEffect, code on the
//    person's computer, or a name that says it sends, posts, submits, uploads,
//    pays...) is in one reviewed list with the control that holds it instead.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { sql } from "~/db"
import { threads } from "~/db/schema/kernel"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { ToolProjector } from "~/modules/mcp-client/projector"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { readManifests } from "../../../test-support/security/enumerate"

// ─── 1. read-only run: the bridge ───────────────────────────────────────────

/** Bridge methods that check the read-only mark themselves, naming their real write target. */
const SELF_GUARDING = new Set([
  "db_insert",
  "db_update",
  "db_updateMany",
  "db_delete",
  "messages_post",
  "executeTool",
  // Forwards the run's mark into the contract op's executeTool (bridge/contracts.ts:298).
  "contracts_call",
])

/**
 * Bridge methods a read-only run may still call, each reviewed as a read (or
 * as a known bound, with the reason). Anything not refused and not listed fails.
 */
const REVIEWED_NOT_REFUSED: Record<string, string> = {
  _approvalContext_get: "read",
  agent_awaitRun: "read",
  approvals_pendingFor: "read",
  approvals_statusOf: "read",
  bulk_iterateJsonl_next: "read",
  calendar_findCalendarsForPollFallback: "read",
  mail_providersGet: "read",
  calendar_findCalendarsForWatchRenewal: "read",
  calendar_findStalePendingPushes: "read",
  calendar_getAccount: "read",
  calendar_getCalendar: "read",
  calendar_getEvent: "read",
  calendar_listAccounts: "read",
  calendar_listCalendars: "read",
  calendar_listEvents: "read",
  calendar_searchEvents: "read",
  callerHasScope: "read",
  codec_base64EncodeUtf8: "read",
  codec_base64UrlEncodeUtf8: "read",
  codec_markdownToEmail: "read",
  config_get: "read",
  time_civil: "read",
  connections_describe: "read",
  connections_getAccounts: "read",
  connections_getCredentials: "read",
  connections_getToken: "read",
  contracts_binding: "read",
  contracts_providers: "read",
  db_count: "read",
  db_findMany: "read",
  db_findOne: "read",
  files_getAttachmentBytes: "read",
  files_listAttachments: "read",
  getCallerApp: "read",
  getIngestionCallerApp: "read",
  getOrgId: "read",
  getOrgSettings: "read",
  getUserId: "read",
  getUserSettings: "read",
  hasOnlineUsers: "read",
  hasScope: "read",
  kernel_findContactsByExternalId: "read",
  kernel_findOne: "read",
  kernel_listApprovals: "read",
  knowledge_attentionItems: "read",
  knowledge_create_validate: "read",
  knowledge_find_by_title: "read",
  knowledge_get: "read",
  knowledge_search: "read",
  knowledge_update_validate: "read",
  listContactsByExternalId: "read",
  log_debug: "read",
  log_error: "read",
  log_info: "read",
  log_warn: "read",
  mail_conversion_readConversation: "read",
  mail_buildSendGuard: "read (computes the send check value; stores nothing)",
  mail_checkSendGuard: "read (evaluates the send check at send; stores nothing)",
  mail_search: "read",
  mcp_checkConnectionWrite: "read",
  mcp_listConnections: "read",
  projects_attentionItems: "read",
  projects_checklistGet: "read",
  projects_get: "read",
  projects_labelsList: "read",
  projects_labelsTree: "read",
  projects_listComments: "read",
  projects_portfolioRollup: "read",
  projects_resolveAssignee: "read",
  projects_search: "read",
  projects_tasksByAssignee: "read",
  projects_tasksByProject: "read",
  pubsub_verifyGoogleOidcJwt: "read",
  resolveContact: "read",
  tickets_attentionItems: "read",
  tickets_conversion_readTicket: "read",
  tickets_get: "read",
  tickets_inboxCounts: "read",
  tickets_listForContact: "read",
  tickets_listSyncableAccounts: "read",
  tickets_search: "read",
  imap_fetch: "read of the connected mailbox (no flag or move op)",
  fetch: "KNOWN BOUND (rpc-bridge.ts:155-157): outbound HTTP stays callable on a read-only run",
}

/**
 * Bridge writes that were once missing from the refusal list (neither refused nor checking the
 * mark themselves). Kept as a named regression: each must stay a refusal on a read-only run.
 */
const READ_ONLY_GAPS = [
  "config_setSecret",
  "contracts_setBinding",
  "contracts_grant",
  "files_importAttachment",
  "projects_addComment",
  "projects_checklistAddItems",
  "projects_checklistRemoveItem",
  "projects_checklistSetValidation",
  "projects_checklistUpdateItem",
]

const POISON = new Proxy(
  {},
  {
    get(_t, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined
      throw new Error(`poison tx: ${String(prop)}`)
    },
  },
)

function bridgeFor(readOnlyRun: boolean): Record<string, any> {
  return createRpcBridge(
    "inv_app",
    "00000000-0000-4000-8000-0000000000aa",
    "00000000-0000-4000-8000-0000000000bb",
    POISON as any,
    { name: "inv_app", schema: {}, events: { emits: [] } },
    ["inv_app:read"],
    "user",
    undefined,
    { readOnlyRunOverride: readOnlyRun, callChain: [] } as any,
  )
}

/** The refusal wrapper createRpcBridge installs on a read-only run. */
function isRefusalWrapper(fn: unknown): boolean {
  return typeof fn === "function" && /readOnlyRunBlockedError\(/.test(String(fn))
}

describe("S3f-1: a read-only run refuses every bridge write", () => {
  it("every bridge method is refused, guards itself, or is a reviewed read", () => {
    const ordinary = bridgeFor(false)
    const ro = bridgeFor(true)
    expect(Object.keys(ro).sort()).toEqual(Object.keys(ordinary).sort())
    const unclassified: string[] = []
    for (const name of Object.keys(ro).sort()) {
      if (isRefusalWrapper(ro[name])) continue
      if (SELF_GUARDING.has(name)) continue
      if (name in REVIEWED_NOT_REFUSED) continue
      if (READ_ONLY_GAPS.includes(name)) continue
      unclassified.push(name)
    }
    expect(unclassified).toEqual([])
    // No stale review entry.
    expect(Object.keys(REVIEWED_NOT_REFUSED).filter((n) => !(n in ro))).toEqual([])
  })

  it("a self-guarding write refuses on a read-only run", async () => {
    const ro = bridgeFor(true)
    for (const name of ["db_insert", "db_update", "db_delete"]) {
      let msg = ""
      try {
        await ro[name](JSON.stringify({ entity: "items", data: { a: 1 }, where: { id: "x" } }))
      } catch (err) {
        msg = String((err as Error).message)
      }
      expect(`${name}: ${msg}`.toLowerCase()).toContain("read_only_run")
    }
  })

  it("every bridge write refuses on a read-only run (no write left out of the list)", async () => {
    const ro = bridgeFor(true)
    const notRefused = READ_ONLY_GAPS.filter((n) => !isRefusalWrapper(ro[n]))
    expect(notRefused).toEqual([])
  })
})

// ─── 2/4. the tool registry ─────────────────────────────────────────────────

let owner: minimal.Session
let threadId: string

beforeAll(async () => {
  await acquireTestLock()
  owner = await minimal.adminSession((await createTestOrg()).id)
  threadId = await minimal.thread(owner.orgId, owner.userId)
  await ensureAppsForOrg(owner.orgId)
})

afterAll(async () => {
  await releaseTestLock()
})

// The enforceable boundary: `readOnly` is a self-declaration. It can shield a
// tool from running on a read-only run, but it does NOT let a tool that declares
// a write target skip the write boundaries — `isReadOnlyTool` is false the moment
// `writesToTable` is present (read-only-run.ts), so the scope-taint check and the
// read-only-run check both still apply. (A tool claiming readOnly with no declared
// target is honoured only for kernel/first-party/publisher-signed code; a
// third-party manifest's claim is dropped at registration, runtime.ts:2182.)
describe("S3f-2: a readOnly declaration does not shield a declared write", () => {
  async function runWritingTool(toolDef: Record<string, unknown>): Promise<{
    written: boolean
    ran: boolean
  }> {
    let ran = false
    toolRegistry.set([owner.orgId, "kernel", "t_marked_write"], {
      appName: "kernel",
      name: "t_marked_write",
      description: "writes a thread row (test stand-in)",
      requiredScopes: ["kernel:threads:read"],
      writesToTable: "kernel.threads",
      params: z.object({}),
      handler: async (_p: unknown, ctx: any) => {
        await ctx.db
          .update(threads)
          .set({ title: "written by t_marked_write" })
          .where(eq(threads.id, threadId))
        ran = true
        return { ok: true }
      },
      ...toolDef,
    } as never)
    const runId = crypto.randomUUID()
    const acc = createTurnScopeAccumulator()
    // The turn has read confidential data the conversation's readers may not hold.
    acc.recordInjected(["invoicing:documents:read"])
    const frame: RunContext = {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      turnScopeAccumulator: acc,
    } as RunContext
    const actor = {
      actorType: "user" as const,
      userId: owner.userId,
      orgId: owner.orgId,
      scopes: ["*"],
      dimensionGrants: {},
    }
    try {
      await runContextStore.run(frame, () =>
        executeTool({
          toolName: "kernel:t_marked_write",
          orgId: owner.orgId,
          actor,
          params: {},
          threadId,
          origin: "in-app-agent",
          stepBundleId: null,
        }),
      )
    } catch {
      /* refused */
    }
    const [row] = await sql`SELECT title FROM kernel.threads WHERE id = ${threadId}`
    await sql`UPDATE kernel.threads SET title = NULL WHERE id = ${threadId}`
    toolRegistry.delete([owner.orgId, "kernel", "t_marked_write"])
    return { written: row?.title === "written by t_marked_write", ran }
  }

  it("a declared write after outside text is scope-taint-held even when the tool claims readOnly", async () => {
    // readOnly + a declared write target: isReadOnlyTool is false, so the taint boundary stands.
    const claims = await runWritingTool({ readOnly: true })
    // The plain write (no readOnly claim) is held the same way: the claim bought nothing.
    const plain = await runWritingTool({})
    expect({ claims, plain }).toEqual({
      claims: { written: false, ran: false },
      plain: { written: false, ran: false },
    })
  })
})

describe("S3f-3: MCP-projected tools are gated by default unless the server marks them read-only", () => {
  it("the default connection runs only non-destructive read-only tools without approval", async () => {
    const projector = new ToolProjector({ executeMcpCall: async () => ({}) })
    const annotations = [
      { readOnlyHint: true, destructiveHint: false },
      { readOnlyHint: true },
      { destructiveHint: false, idempotentHint: true, openWorldHint: false },
      {},
      { readOnlyHint: true, destructiveHint: true },
      { readOnlyHint: false },
    ]
    // Owner rule (2026-10-25): under gate_writes a readOnlyHint tool that is not destructive runs
    // without approval; everything else parks. A mislabelled write is the residual risk.
    const expectedGated = [false, false, true, true, true, true]
    await projector.registerTools({
      orgId: owner.orgId,
      connectionId: crypto.randomUUID(),
      slug: "inv-remote",
      tools: annotations.map((a, i) => ({
        name: `t${i}`,
        description: "remote",
        inputSchema: { type: "object" },
        annotations: a,
      })),
    })
    for (let i = 0; i < annotations.length; i++) {
      const entry = toolRegistry.get([owner.orgId, "mcp", `inv-remote:t${i}`])
      expect({ i, gated: entry?.gated, externalEffect: entry?.externalEffect }).toEqual({
        i,
        gated: expectedGated[i],
        externalEffect: true,
      })
    }
  })
})

/** Names that say the tool acts outside Liaison or on a person's machine. */
const OUTWARD_NAME =
  /(send|post|publish|upload|email|mail(?!box)|notify|submit|transmit|issue|refund|fulfil|ship|pay|purchase|invite|share|export|webhook|reply|forward|compose|deactivate|disconnect|run_on|computer_session|delete_event|create_event|update_event|book|advance)/i

/** Ungated outward tools, each with the control that holds it instead of a per-call approval. */
const REVIEWED_UNGATED_OUTWARD: Record<string, string> = {
  "boxtal:import_shipments":
    "local import of shipments already booked at the provider; no booking or purchase",
  "boxtal:prep_add_shipment": "local prep row; buying a label is the gated ship tools",
  "boxtal:shipment_draft_create": "local draft; buying a label is the gated ship tools",
  "boxtal:shipment_draft_set_customs": "local draft field",
  "boxtal:shipment_draft_set_package": "local draft field",
  "boxtal:webhooks_repair":
    "re-registers the org's own provider webhooks; admin config scope boxtal:catalog:write, no data out",
  "calendar:create_event":
    "host gate: approval when inviting an address nobody in the org knows (owner verdict; scopes/host-approval-gates.ts), sendUpdates=none",
  "calendar:delete_event":
    "own calendar write, sendUpdates=none; no new recipient (owner verdict scope)",
  "calendar:update_event": "same host gate as create_event",
  "google-drive:upload":
    "externalEffect: parks after outside text (execute-tool.ts:4352-4470) unless Agent Safety off (owner verdict)",
  "invoicing:contact_relationships_set": "local relationship row",
  "invoicing:credit_note_create_and_issue":
    "gated: parks via the handler's ctx.requestApproval (conditionalGate; execute-tool.ts:2767-2900), person shortcut only for origin human-ui (:2879)",
  "invoicing:credit_note_issue":
    "gated: parks via the handler's ctx.requestApproval (conditionalGate; execute-tool.ts:2767-2900), person shortcut only for origin human-ui (:2879)",
  "invoicing:einvoice_send_request":
    "stages the send approval (einvoicing/transmit.ts einvoiceSendRequest); the PA submit needs the approval's dispatch grant",
  "invoicing:po_create_and_issue":
    "gated: parks via the handler's ctx.requestApproval (conditionalGate; execute-tool.ts:2767-2900), person shortcut only for origin human-ui (:2879)",
  "invoicing:po_issue":
    "gated: parks via the handler's ctx.requestApproval (conditionalGate; execute-tool.ts:2767-2900), person shortcut only for origin human-ui (:2879)",
  "invoicing:quote_create_and_issue":
    "gated: parks via the handler's ctx.requestApproval (conditionalGate; execute-tool.ts:2767-2900), person shortcut only for origin human-ui (:2879)",
  "kernel:approval_update_payload":
    "edits a pending approval; the decision is bound to the payload hash the person saw (decide.ts:262-275, cascade lock)",
  "kernel:bulkDeactivateUsers":
    "bulk wrapper: each account dispatches through kernel:deactivateUser, which is gated (kernel-bulk-untrusted.test.ts)",
  "kernel:computer_session_answer":
    "requiresHumanTurn + refuseBeforeGate (kernel-tools.ts); replayed outside text keeps the mark (untrusted-text-across-turns.test.ts)",
  "kernel:computer_session_send":
    "requiresHumanTurn + refuseBeforeGate (kernel-tools.ts); replayed outside text keeps the mark",
  "kernel:computer_session_settings":
    "autonomy change is requiresHumanTurn; level raises are confirmed on the node",
  "kernel:computer_session_stop": "stops the person's own session; no code runs",
  "kernel:files_upload_confirm": "internal",
  "kernel:files_upload_url": "internal upload slot for the person",
  "kernel:notify_user": "internal notification to an org member; scope-taint sinkReadersSelf",
  "kernel:report_bug":
    "externalEffect: parks after outside text; team-only it only prepares a draft the reporter sends from their own card (bug-reports/tool.ts)",
  "kernel:run_on_my_computer":
    "requiresHumanTurn: parks unless a typed, unmarked turn (execute-tool.ts); replayed outside text keeps the mark (untrusted-text-across-turns.test.ts)",
  "kernel:set_away":
    "conditionalGate + requiresHumanTurn + noAutoApprove (kernel-tools.ts): runs at once only on the person's own untainted turn, or a holder of kernel:users:admin or projects:capacity:write for someone else; any other call parks to the requester alone (requesterAlways); it writes dates and person ids only (set-away.test.ts)",
  "kernel:threads_reply": "internal thread post; scope-taint judged on the room's readers",
  "kernel:web_fetch":
    "a read that never parks (outboundWebRead, scope-taint.ts rule 9): its URL is bounded inline by the web-read guardrails (length, query string, userinfo, opaque or personal data on a turn that read org data, per-turn and per-thread rate; web-read-guardrails.ts), plus the org allow/blocklist and the SSRF guard",
  "mail:disconnectAccount": "internal, the person's own account row",
  "mail:export_conversations": "file for the requester from rows they can read; nothing sent",
  "shopify:webhooks_repair":
    "re-registers the org's own Shopify webhooks; admin identity-map scope",
  "tickets:convertToMail": "internal conversion; sending is the gated mail compose",
  "tickets:csat.request": "externalEffect: parks after outside text (owner verdict AGM-2)",
  "tickets:inboxes.disconnect": "admin-scoped, internal",
}

interface ToolFacts {
  gated: boolean
  conditionalGate: boolean
  externalEffect: boolean
  requiresHumanTurn: boolean
  agentVisible: boolean
  contractOnly: boolean
  readOnly: boolean
}

function collectTools(orgId: string): Map<string, ToolFacts> {
  const out = new Map<string, ToolFacts>()
  for (const [[o, app, name], def] of toolRegistry.entries()) {
    if (o !== orgId && o !== "*") continue
    if (app === "mcp") continue
    const d = def as Record<string, any>
    out.set(`${app}:${name}`, {
      gated: d.gated === true,
      conditionalGate: d.conditionalGate === true,
      externalEffect: d.externalEffect === true,
      requiresHumanTurn: d.requiresHumanTurn !== undefined && d.requiresHumanTurn !== false,
      agentVisible: d.agentVisible !== false,
      contractOnly: d.contractOnly === true,
      readOnly: d.readOnly === true,
    })
  }
  // Bundled apps are not installed in this org: their declarations, as shipped.
  for (const m of readManifests()) {
    const tools = m.manifest.tools ?? {}
    const entries = Array.isArray(tools)
      ? tools.map((t: any) => [t.name, t] as [string, any])
      : (Object.entries(tools) as Array<[string, any]>)
    for (const [name, d] of entries) {
      const id = `${m.manifest.name ?? m.app}:${name}`
      if (out.has(id)) continue
      out.set(id, {
        gated: d.gated === true,
        conditionalGate: d.conditionalGate === true,
        externalEffect: d.externalEffect === true,
        requiresHumanTurn: false,
        agentVisible: d.agentVisible !== false,
        contractOnly: d.contractOnly === true,
        readOnly: d.readOnly === true,
      })
    }
  }
  return out
}

describe("S3f-4: ungated tools with an outward channel are reviewed", () => {
  it("every one is in the reviewed list, and the list has no stale entry", () => {
    const all = collectTools(owner.orgId)
    expect(all.size).toBeGreaterThan(400)
    const unreviewed: string[] = []
    const ungatedOutward = new Set<string>()
    for (const [id, f] of [...all.entries()].sort()) {
      if (f.gated || !f.agentVisible || f.contractOnly) continue
      // A declared read with no outward channel (the marker is enforced by S3f-2).
      if (f.readOnly && !f.externalEffect && !f.requiresHumanTurn) continue
      const outward =
        f.externalEffect ||
        f.requiresHumanTurn ||
        OUTWARD_NAME.test(id.split(":").slice(1).join(":"))
      if (!outward) continue
      ungatedOutward.add(id)
      if (id in REVIEWED_UNGATED_OUTWARD) continue
      unreviewed.push(id)
    }
    expect(unreviewed).toEqual([])
    // Stale: the tool is gone, or it is gated (or hidden, or a read) now, so its reviewed
    // reason no longer describes it. Drop the entry; the gate has its own regression test.
    expect(Object.keys(REVIEWED_UNGATED_OUTWARD).filter((id) => !ungatedOutward.has(id))).toEqual(
      [],
    )
  })
})
