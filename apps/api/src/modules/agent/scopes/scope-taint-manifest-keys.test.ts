// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SCOPE-TAINT KEYS ON MANIFEST TOOLS: `sinkReadersSelf` and `contentParams`.
//
// A kernel tool can say that what it writes is read by the acting user alone (rule 6d) or that it
// carries the turn only through named parameters (rule 6f). A manifest tool can say the same, but
// only when the platform vouches for the app (an in-tree app or the image's own catalog artifact):
// both keys narrow a refusal, so a third-party manifest declaring either is not loaded.
//
// Pinned with a fictional first-party app registered through the real app runtime (a sandboxed
// bundle whose handlers report that they ran), driven through both doors: the in-app tool bridge
// (buildToolSet's execute closure, then executeToolCore) and the MCP gateway (handleToolCall).
// The turn is tainted by a read of another scope of the same app. A colleague who can read the
// notes table but not that scope makes the plain write a disclosure: it parks, or is refused in a
// conversation that colleague is a member of. The keyed write lands, because its only reader is
// the acting user, who holds what the turn read.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "~/db/connection"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { resetAppRegistries, toolRegistry } from "~/modules/apps/app-registries"
import { validateAppManifest } from "~/modules/apps/contract"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import {
  cleanupSeededOrg,
  grantScope,
  seedAgentForOrg,
  seedMcpConnection,
  userContextFor,
} from "~/modules/mcp/test-helpers"
import { handleToolCall, type ToolCallCtx } from "~/modules/mcp/tool-call"
import { seedOrgRow, seedUserRows } from "~/seed/factories/org/rows"
import { insertSql } from "~/seed/factories/org/test-rows"

const ORG = "00000000-0000-4000-8000-0000000d5e01"
const OWNER = "00000000-0000-4000-8000-0000000d5e02"
const COLLEAGUE = "00000000-0000-4000-8000-0000000d5e03"
const DM = "00000000-0000-4000-8000-0000000d5e04"
const SHARED = "00000000-0000-4000-8000-0000000d5e05"
const VALIDATION_ORG = "00000000-0000-4000-8000-0000000d5e06"

const APP = "selfnote"
const LEDGER_READ = "selfnote:ledger:read"
const NOTES_READ = "selfnote:notes:read"
const NOTES_WRITE = "selfnote:notes:write"
const OWNER_SCOPES = [LEDGER_READ, NOTES_READ, NOTES_WRITE]
const NOTES = "app_selfnote.notes"
/** What a handler returns, so a run is told apart from a park or a refusal. */
const RAN = "selfnoteHandlerRan"

const BODY_PARAMS = {
  type: "object",
  properties: { noteId: { type: "string" }, body: { type: "string" } },
}

function selfnoteTools(): Record<string, Record<string, unknown>> {
  const write = (handler: string, keys: Record<string, unknown>) => ({
    description: `Write a note (${handler})`,
    requiredScopes: [NOTES_WRITE],
    handler,
    params: BODY_PARAMS,
    writesToTable: NOTES,
    ...keys,
  })
  return {
    ledger_read: {
      description: "Read the ledger",
      requiredScopes: [LEDGER_READ],
      handler: "ledgerRead",
      params: { type: "object", properties: {} },
      readOnly: true,
    },
    note_save: write("noteSave", { sinkReadersSelf: true }),
    note_save_plain: write("noteSavePlain", {}),
    note_flag: write("noteFlag", { contentParams: ["body"] }),
  }
}

function selfnoteManifest(tools = selfnoteTools()) {
  return {
    name: APP,
    version: "1.0.0",
    scopes: OWNER_SCOPES,
    schema: { notes: { fields: { body: "string?" } } },
    tools,
  }
}

let bundleDir = ""
let bundlePath = ""

function descriptor(voucher: Record<string, unknown>, tools = selfnoteTools()) {
  return { ...selfnoteManifest(tools), _format: "manifest", _bundlePath: bundlePath, ...voucher }
}

/** What init.ts stamps on an in-tree app or the image's own catalog artifact. */
const FIRST_PARTY = { trusted: false, _firstParty: true }

type Outcome = "ran" | "parked" | "E_SCOPE_TAINT_BLOCKED" | string

function outcomeOf(r: Record<string, unknown>): Outcome {
  const text = JSON.stringify(r)
  if (text.includes("E_SCOPE_TAINT_BLOCKED")) return "E_SCOPE_TAINT_BLOCKED"
  if (r.blocked === true || typeof r.approvalRequestId === "string") return "parked"
  if (text.includes(RAN)) return "ran"
  return `other: ${text.slice(0, 300)}`
}

function frame(): RunContext {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator: createTurnScopeAccumulator({ orgId: ORG }),
  }
}

async function inApp(
  f: RunContext,
  thread: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<Outcome> {
  const actor = userContextFor(ORG, OWNER, OWNER_SCOPES)
  const tools = buildToolSet(ORG, actor, thread, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", f)
  const t = tools[`${APP}__${tool}`]
  if (!t) throw new Error(`${APP}__${tool} is not in the in-app catalog`)
  const r = (await runContextStore.run(f, () =>
    (t as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {}),
  )) as Record<string, unknown>
  return outcomeOf(r)
}

/** A read of another scope, then the write, in one turn. */
async function inAppAfterRead(thread: string, tool: string, args: Record<string, unknown> = {}) {
  const f = frame()
  const read = await inApp(f, thread, "ledger_read")
  return [read, await inApp(f, thread, tool, args)]
}

let agentCount = 0

/** A fresh MCP connection per sequence, so each starts with a clean per-agent taint window. */
async function mcpSequence(calls: Array<[string, Record<string, unknown>]>): Promise<Outcome[]> {
  agentCount += 1
  const { agentId } = await seedAgentForOrg(ORG)
  const conn = await seedMcpConnection({
    orgId: ORG,
    userId: OWNER,
    clientId: "claude-code",
    label: `Selfnote ${agentCount}`,
  })
  const out: Outcome[] = []
  for (const [tool, args] of calls) {
    // A fresh ctx per call: the streamable-HTTP transport rebuilds it on every POST.
    const ctx: ToolCallCtx = {
      orgId: ORG,
      actor: userContextFor(ORG, OWNER, OWNER_SCOPES),
      connectionId: conn.id,
      ownerUserId: OWNER,
      agentId,
      connectionThreadId: null,
      discovered: new Set(),
    }
    const res = await handleToolCall(ctx, `${APP}__${tool}`, args)
    out.push(outcomeOf({ ...(res.structuredContent as Record<string, unknown>), res }))
  }
  return out
}

async function cleanupSchema() {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "app_${APP}" CASCADE`)
}

describe("scope-taint keys on a first-party manifest tool", () => {
  beforeAll(async () => {
    await initSandboxPool()
    bundleDir = mkdtempSync(join(tmpdir(), "selfnote-taint-keys-"))
    bundlePath = join(bundleDir, "handler-bundle.js")
    // A sandboxed bundle: each handler is a global function the runtime calls by name.
    writeFileSync(
      bundlePath,
      ["ledgerRead", "noteSave", "noteSavePlain", "noteFlag"]
        .map((h) => `async function ${h}() { return { ${RAN}: "${h}" } }\n`)
        .join(""),
    )
    await cleanupSeededOrg(ORG)
    await seedOrgRow(
      { id: ORG, name: "Selfnote Taint Keys Org", slug: "selfnote-taint-keys-org" },
      { onConflict: "skip" },
    )
    await seedUserRows(
      [
        [OWNER, "selfnote-owner@test.com"],
        [COLLEAGUE, "selfnote-colleague@test.com"],
      ].map(([id, email]) => ({
        id,
        orgId: ORG,
        email,
        name: email,
        status: "active",
        passwordHash: "x",
      })),
      { onConflict: "skip" },
    )
    for (const scope of OWNER_SCOPES) await grantScope(ORG, OWNER, scope)
    // Reads the notes table, not the ledger the turn read.
    await grantScope(ORG, COLLEAGUE, NOTES_READ)
    // The DM with the agent, and a team conversation the colleague is a member of.
    for (const [id, handle, type, members] of [
      [DM, "selfnote-dm", "agent_chat", [OWNER]],
      [SHARED, "selfnote-shared", "thread", [OWNER, COLLEAGUE]],
    ] as const) {
      await sql.unsafe(
        insertSql(
          "kernel.threads",
          { id, org_id: ORG, handle, type, created_by: OWNER },
          { onConflictDoNothing: true },
        ),
      )
      for (const user of members) {
        await sql.unsafe(
          insertSql(
            "kernel.thread_participants",
            { thread_id: id, user_id: user, org_id: ORG, role: "admin" },
            { onConflictDoNothing: true },
          ),
        )
        await sql.unsafe(
          insertSql(
            "kernel.user_thread_state",
            { user_id: user, thread_id: id, org_id: ORG },
            { onConflictDoNothing: true },
          ),
        )
      }
    }
    const { failedApps } = await registerApps([descriptor(FIRST_PARTY) as never], ORG)
    expect(failedApps).toEqual([])
  }, 120_000)

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    toolRegistry.deleteByPrefix([VALIDATION_ORG])
    await cleanupSeededOrg(ORG)
    await cleanupSeededOrg(VALIDATION_ORG)
    await cleanupSchema()
    rmSync(bundleDir, { recursive: true, force: true })
    await shutdownSandboxPool()
  })

  it("a first-party manifest declaring sinkReadersSelf and contentParams is accepted", () => {
    const judged = validateAppManifest(JSON.parse(JSON.stringify(selfnoteManifest())))
    expect(judged.success ? "" : judged.error).toBe("")
    const entry = toolRegistry.get([ORG, APP, "note_save"])
    expect(entry?.sinkReadersSelf).toBe(true)
    expect(toolRegistry.get([ORG, APP, "note_flag"])?.contentParams).toEqual(["body"])
  })

  it("a turn tainted by another scope writes to a sinkReadersSelf tool", async () => {
    expect(await inAppAfterRead(DM, "note_save", { body: "call the printer" })).toEqual([
      "ran",
      "ran",
    ])
    // In a conversation whose member lacks the taint, too: the note is read by its writer alone.
    expect(await inAppAfterRead(SHARED, "note_save", { body: "call the printer" })).toEqual([
      "ran",
      "ran",
    ])
  }, 30_000)

  it("same tool without the keys refused E_SCOPE_TAINT_BLOCKED", async () => {
    // In a conversation whose member lacks the taint, its card cannot be shown: refused.
    expect(await inAppAfterRead(SHARED, "note_save_plain", { body: "call the printer" })).toEqual([
      "ran",
      "E_SCOPE_TAINT_BLOCKED",
    ])
    // Elsewhere it does not run either: it parks for a holder of the taint (rule 8).
    expect(await inAppAfterRead(DM, "note_save_plain", { body: "call the printer" })).toEqual([
      "ran",
      "parked",
    ])
  }, 30_000)

  it("a contentParams write with its content params blank runs on a tainted turn, filled it does not", async () => {
    expect(await inAppAfterRead(DM, "note_flag", { noteId: "n1" })).toEqual(["ran", "ran"])
    expect(await inAppAfterRead(DM, "note_flag", { noteId: "n1", body: "  " })).toEqual([
      "ran",
      "ran",
    ])
    expect(await inAppAfterRead(SHARED, "note_flag", { noteId: "n1", body: "x" })).toEqual([
      "ran",
      "E_SCOPE_TAINT_BLOCKED",
    ])
  }, 30_000)

  it("MCP door same", async () => {
    const write = { body: "call the printer" }
    expect(
      await mcpSequence([
        ["ledger_read", {}],
        ["note_save", write],
      ]),
    ).toEqual(["ran", "ran"])
    expect(
      await mcpSequence([
        ["ledger_read", {}],
        ["note_save_plain", write],
      ]),
    ).toEqual(["ran", "parked"])
    expect(
      await mcpSequence([
        ["ledger_read", {}],
        ["note_flag", { noteId: "n1" }],
      ]),
    ).toEqual(["ran", "ran"])
  }, 60_000)
})

describe("scope-taint keys: first-party only", () => {
  async function problemOf(voucher: Record<string, unknown>, tools: Record<string, unknown>) {
    await seedOrgRow(
      { id: VALIDATION_ORG, name: "Selfnote Validation Org", slug: "selfnote-validation-org" },
      { onConflict: "skip" },
    )
    const { failedApps } = await registerApps(
      [descriptor(voucher, tools as never) as never],
      VALIDATION_ORG,
    )
    const [row] = await sql<{ status: string; problem_message: string | null }[]>`
      SELECT status, problem_message FROM kernel.apps WHERE org_id = ${VALIDATION_ORG} AND name = ${APP}`
    const entries = (["note_save", "note_flag"] as const).map((n) =>
      toolRegistry.get([VALIDATION_ORG, APP, n]),
    )
    resetAppRegistries()
    await sql`DELETE FROM kernel.apps WHERE org_id = ${VALIDATION_ORG}`
    return { failedApps, row, entries }
  }

  it("third-party manifest declaring either fails validation", async () => {
    const tools = selfnoteTools()
    for (const [voucher, label] of [
      [{ trusted: false }, "unsigned install"],
      [{ trusted: false, _installed: true, _publisherSigned: true }, "publisher-signed install"],
    ] as const) {
      for (const key of ["sinkReadersSelf", "contentParams"] as const) {
        const only = key === "sinkReadersSelf" ? "note_save" : "note_flag"
        const { failedApps, row, entries } = await problemOf(voucher, {
          ledger_read: tools.ledger_read,
          [only]: tools[only],
        })
        expect({ label, key, failedApps }).toEqual({ label, key, failedApps: [APP] })
        expect(row?.status).toBe("error")
        expect(row?.problem_message ?? "").toContain(`tools.${only}.${key}`)
        expect(entries).toEqual([undefined, undefined])
      }
    }
  }, 60_000)

  it("contentParams naming a parameter the tool does not take fails validation", () => {
    const tools = selfnoteTools()
    tools.note_flag = { ...tools.note_flag, contentParams: ["comment"] }
    const judged = validateAppManifest(JSON.parse(JSON.stringify(selfnoteManifest(tools))))
    expect(judged.success).toBe(false)
    expect(judged.error ?? "").toContain('tools.note_flag.contentParams: "comment"')
  })
})
