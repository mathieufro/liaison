// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SCOPE TAINT AT THE MCP SEAM: reads run, gated writes park, and a scope ages out.
//
// The agent-bound MCP turn taint is persisted per (org, agent) across stateless POSTs. On
// the Acme deployment that made a user's Claude Code session unusable after its first
// scoped read: every later kpi_run, db_read or projects.get POST was refused
// E_SCOPE_TAINT_BLOCKED for as long as the session kept talking, because the window slid on
// every call. Pinned here:
//
//   1. kpi_list_hubs then kpi_run, each in its own POST, both run (a kpi-shaped manifest's
//      marks: both tools read-only, both requiring kpi:metrics:read);
//   2. a gated call after a scoped read parks an approval for the connection's user, who holds
//      the scope, instead of being refused;
//   3. a scope leaves the persisted taint a full window after its LAST read, even while the
//      runtime keeps calling other tools, and an ungated write then runs; while it is fresh,
//      the same write is refused (the property);
//   4. a read whose manifest entry lacks `readOnly: true` is judged as a write to an unknown
//      table: on a tainted turn it parks for approval although its handler only reads (a live
//      turn parked four ungated shipment reads this way). With the mark the same read runs,
//      which is why every read-only manifest tool carries it (manifest-readonly-marks.test.ts).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { sql } from "~/db"
import { redis } from "~/lib/redis"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import {
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  mcpTurnTaintKey,
  mcpTurnTaintTouchedKey,
} from "~/modules/mcp/connection-service"
import {
  cleanupSeededOrg,
  gatedTicketTool,
  mutatingTicketTool,
  seedAgentForOrg,
  seedMcpConnection,
  seedOrgWithTicketsApp,
  userContextFor,
} from "~/modules/mcp/test-helpers"
import { handleToolCall, type ToolCallCtx } from "~/modules/mcp/tool-call"

const KPI_READ = "kpi:metrics:read"

// The marks a kpi app's manifest declares (the app is not bundled with this
// repository): what the registry would carry for its read tools.
const KPI_MANIFEST: {
  tools: Record<string, { requiredScopes: string[]; readOnly?: boolean }>
} = {
  tools: {
    kpi_list_hubs: { requiredScopes: [KPI_READ], readOnly: true },
    kpi_run: { requiredScopes: [KPI_READ], readOnly: true },
  },
}

const ran: string[] = []

/** A read registered twice: once without the readOnly mark, once with it. */
function registerPeek(orgId: string) {
  for (const [name, readOnly] of [
    ["peek_unmarked", false],
    ["peek_marked", true],
  ] as const) {
    // In the seeded app, whose approvers hold its read scope, so a parked call has a decider.
    toolRegistry.set([orgId, "test", name], {
      appName: "test",
      name,
      description: name,
      requiredScopes: ["test:items:read"],
      ...(readOnly ? { readOnly: true } : {}),
      params: z.object({}).passthrough(),
      handler: async () => {
        ran.push(name)
        return { ok: true }
      },
    } as never)
  }
}

// The shipment reads a live turn parked, with the mark exactly as the shipped manifest carries it.
const BOXTAL_MANIFEST = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "..",
      "bundled-apps",
      "boxtal",
      "app.manifest.json",
    ),
    "utf8",
  ),
) as { tools: Record<string, { readOnly?: boolean }> }
const BOXTAL_READS = ["track", "get_shipment", "prep_list"] as const

function registerBoxtalReads(orgId: string) {
  for (const name of BOXTAL_READS) {
    toolRegistry.set([orgId, "test", name], {
      appName: "test",
      name,
      description: name,
      requiredScopes: ["test:items:read"],
      ...(BOXTAL_MANIFEST.tools[name]?.readOnly === true ? { readOnly: true } : {}),
      params: z.object({}).passthrough(),
      handler: async () => {
        ran.push(name)
        return { ok: true }
      },
    } as never)
  }
}

function registerKpi(orgId: string) {
  for (const name of ["kpi_list_hubs", "kpi_run"]) {
    const m = KPI_MANIFEST.tools[name]!
    toolRegistry.set([orgId, "kpi", name], {
      appName: "kpi",
      name,
      description: name,
      requiredScopes: m.requiredScopes,
      ...(m.readOnly === true ? { readOnly: true } : {}),
      params: z.object({}).passthrough(),
      handler: async () => {
        ran.push(name)
        return { ok: true }
      },
    } as never)
  }
}

/** A read the seeded person lacks, one that fails once it ran, one whose nested call is refused. */
function registerLocked(orgId: string) {
  const read = (name: string, requiredScopes: string[], handler: () => Promise<unknown>) =>
    toolRegistry.set([orgId, "test", name], {
      appName: "test",
      name,
      description: name,
      requiredScopes,
      readOnly: true,
      params: z.object({}).passthrough(),
      handler,
    } as never)
  read("locked_read", ["test:locked:read"], async () => {
    ran.push("locked_read")
    return { secret: true }
  })
  read("throwing_read", ["test:items:read"], async () => {
    throw new Error("boom after reading")
  })
  read("nesting_read", ["test:items:read"], async () => {
    ran.push("nesting_read")
    await executeTool({
      toolName: "test:locked_read",
      orgId,
      actor: userContextFor(orgId, crypto.randomUUID(), []),
      params: {},
      origin: "mcp",
    })
    return { ok: true }
  })
}

async function taintWindow(orgId: string, agentId: string): Promise<string[]> {
  return JSON.parse((await redis.get(mcpTurnTaintKey(orgId, agentId))) ?? "[]")
}

/** A fresh ctx per call: the streamable-HTTP transport rebuilds it on every POST. */
function postCtx(
  seed: { orgId: string; ownerId: string; scopes: string[] },
  agentId: string,
  connectionId: string,
): ToolCallCtx {
  return {
    orgId: seed.orgId,
    actor: userContextFor(seed.orgId, seed.ownerId, [...seed.scopes, KPI_READ]),
    connectionId,
    ownerUserId: seed.ownerId,
    agentId,
    connectionThreadId: null,
    discovered: new Set(),
  }
}

async function seedAgentBound() {
  const seed = await seedOrgWithTicketsApp()
  const { agentId } = await seedAgentForOrg(seed.orgId)
  const conn = await seedMcpConnection({
    orgId: seed.orgId,
    userId: seed.ownerId,
    clientId: "claude-code",
    label: "Claude Code",
  })
  registerKpi(seed.orgId)
  registerPeek(seed.orgId)
  registerBoxtalReads(seed.orgId)
  return { seed, agentId, connectionId: conn.id, post: () => postCtx(seed, agentId, conn.id) }
}

function codeOf(res: { structuredContent?: unknown }): string | undefined {
  return (res.structuredContent as { code?: string } | undefined)?.code
}

describe("mcp scope taint: reads, gated writes and the per-scope window", () => {
  const orgs: string[] = []

  beforeAll(async () => {
    await initSandboxPool()
  })

  afterEach(async () => {
    for (const o of orgs.splice(0)) {
      toolRegistry.deleteByPrefix([o])
      await cleanupSeededOrg(o)
    }
  })

  afterAll(async () => {
    await shutdownSandboxPool()
  })

  it("kpi_list_hubs then kpi_run, one POST each: both run", async () => {
    const { seed, agentId, post } = await seedAgentBound()
    orgs.push(seed.orgId)
    ran.length = 0

    const hubs = await handleToolCall(post(), "kpi__kpi_list_hubs", {})
    expect(hubs.isError).toBeFalsy()
    const persisted = JSON.parse((await redis.get(mcpTurnTaintKey(seed.orgId, agentId))) ?? "[]")
    expect(persisted).toContain(KPI_READ)

    const run = await handleToolCall(post(), "kpi__kpi_run", {})
    expect(codeOf(run)).not.toBe("E_SCOPE_TAINT_BLOCKED")
    expect(run.isError).toBeFalsy()
    const again = await handleToolCall(post(), "kpi__kpi_run", {})
    expect(again.isError).toBeFalsy()
    expect(ran).toEqual(["kpi_list_hubs", "kpi_run", "kpi_run"])
  }, 30_000)

  it("a gated call after a scoped read parks an approval for a user holding the scope", async () => {
    const { seed, post } = await seedAgentBound()
    orgs.push(seed.orgId)

    const read = await handleToolCall(post(), "test__listItems", {})
    expect(read.isError).toBeFalsy()
    const gated = await handleToolCall(post(), "test__gatedEcho", gatedTicketTool.validParams)
    expect(codeOf(gated)).not.toBe("E_SCOPE_TAINT_BLOCKED")
    expect(gated.isError).toBeFalsy()
    const out = gated.structuredContent as { gated?: boolean; executed?: boolean }
    expect(out.gated).toBe(true)
    expect(out.executed).toBe(false)
  }, 30_000)

  // Walk N5: a read refused for a missing scope, then a write. Nothing had been read, yet the
  // session was tainted with scopes the person lacks, and the write was refused for good.
  it("a read refused for a missing scope adds no taint, and later writes run", async () => {
    const { seed, agentId, post } = await seedAgentBound()
    orgs.push(seed.orgId)
    ran.length = 0
    registerLocked(seed.orgId)

    const refused = await handleToolCall(post(), "test__locked_read", {})
    expect(codeOf(refused)).toBe("forbidden")
    expect(ran).toEqual([])
    expect(await taintWindow(seed.orgId, agentId)).toEqual([])

    const write = await handleToolCall(post(), "test__createItem", mutatingTicketTool.validParams)
    expect(codeOf(write)).not.toBe("E_SCOPE_TAINT_BLOCKED")
    expect(write.isError).toBeFalsy()
    expect(await taintWindow(seed.orgId, agentId)).not.toContain("test:locked:read")
  }, 30_000)

  it("a call refused for bad parameters adds no taint", async () => {
    const { seed, agentId, post } = await seedAgentBound()
    orgs.push(seed.orgId)
    const refused = await handleToolCall(post(), "test__createItem", { nope: true })
    expect(codeOf(refused)).toBe("invalid_params")
    expect(await taintWindow(seed.orgId, agentId)).toEqual([])
  }, 30_000)

  it("a refused read keeps the taint already there: nothing is dropped, nothing is added", async () => {
    const { seed, agentId, post } = await seedAgentBound()
    orgs.push(seed.orgId)
    registerLocked(seed.orgId)
    await handleToolCall(post(), "test__listItems", {})
    const before = await taintWindow(seed.orgId, agentId)
    expect(before).toContain("test:items:read")
    await handleToolCall(post(), "test__locked_read", {})
    expect(await taintWindow(seed.orgId, agentId)).toEqual(before)
    // And the earlier read still parks the write.
    const write = await handleToolCall(post(), "test__createItem", mutatingTicketTool.validParams)
    expect((write.structuredContent as { gated?: boolean }).gated).toBe(true)
  }, 30_000)

  it("a read whose handler ran and threw still taints: it may have read before it failed", async () => {
    const { seed, agentId, post } = await seedAgentBound()
    orgs.push(seed.orgId)
    registerLocked(seed.orgId)
    const failed = await handleToolCall(post(), "test__throwing_read", {})
    expect(failed.isError).toBe(true)
    expect(await taintWindow(seed.orgId, agentId)).toContain("test:items:read")
  }, 30_000)

  it("a handler that ran does not escape taint by passing on a nested call's refusal", async () => {
    const { seed, agentId, post } = await seedAgentBound()
    orgs.push(seed.orgId)
    registerLocked(seed.orgId)
    const failed = await handleToolCall(post(), "test__nesting_read", {})
    expect(failed.isError).toBe(true)
    expect(ran).toContain("nesting_read")
    expect(await taintWindow(seed.orgId, agentId)).toContain("test:items:read")
  }, 30_000)

  it("a scope ages out a window after its last read; until then an ungated write parks for approval", async () => {
    const { seed, agentId, connectionId, post } = await seedAgentBound()
    orgs.push(seed.orgId)

    await handleToolCall(post(), "test__listItems", {})
    // Still fresh: the write does not run; it parks for a person holding what was read (rule 8).
    const fresh = await handleToolCall(post(), "test__createItem", mutatingTicketTool.validParams)
    expect(codeOf(fresh)).not.toBe("E_SCOPE_TAINT_BLOCKED")
    const parked = fresh.structuredContent as { gated?: boolean; executed?: boolean }
    expect(parked.gated).toBe(true)
    expect(parked.executed).toBe(false)
    // It parks on the connection's own thread, the one the agent watches, never on an
    // auto-created surface nobody on the MCP side sees.
    const [conn] = await sql<{ thread_id: string | null }[]>`
      SELECT thread_id FROM kernel.mcp_connections WHERE id = ${connectionId}`
    expect(conn?.thread_id).toBeTruthy()
    const approvals = await sql<{ thread_id: string | null }[]>`
      SELECT thread_id FROM kernel.approval_requests WHERE org_id = ${seed.orgId} AND status = 'pending'`
    expect(approvals.length).toBe(1)
    expect(approvals[0]?.thread_id).toBe(conn?.thread_id ?? null)

    // The runtime may have kept calling other tools meanwhile, which slides the set's own
    // window; what ages a scope out is that its last READ is now more than a window old. The
    // parked write never ran, so its own scope is not in the set: recording it renewed the
    // block on every retry (the third QA walk).
    const touchedKey = mcpTurnTaintTouchedKey(seed.orgId, agentId)
    const stamps = await redis.hgetall(touchedKey)
    expect(Object.keys(stamps).sort()).toEqual(["test:items:read"])
    const stale = String(Date.now() - (MCP_ACCESS_TOKEN_TTL_SECONDS + 60) * 1000)
    for (const scope of Object.keys(stamps)) await redis.hset(touchedKey, scope, stale)

    const write = await handleToolCall(post(), "test__createItem", mutatingTicketTool.validParams)
    expect(codeOf(write)).not.toBe("E_SCOPE_TAINT_BLOCKED")
    expect(write.isError).toBeFalsy()
    // The aged read no longer blocks (the write above ran). The write's own scope is recorded
    // projected onto its read sibling (scope-taint.ts, rule 5), never as a write scope.
    const persisted = JSON.parse((await redis.get(mcpTurnTaintKey(seed.orgId, agentId))) ?? "[]")
    expect(persisted).not.toContain("test:items:write")
    expect(persisted).toEqual(["test:items:read"])
  }, 30_000)

  it("a scope a read's result carried is stamped too, so it ages out like the read's own", async () => {
    const { seed, agentId, post } = await seedAgentBound()
    orgs.push(seed.orgId)
    // A read whose result holds a part classified by a narrower scope (`resultTaintWhen`).
    toolRegistry.set([seed.orgId, "test", "priced_read"], {
      appName: "test",
      name: "priced_read",
      description: "priced_read",
      requiredScopes: ["test:items:read"],
      readOnly: true,
      resultTaintWhen: { fields: ["amount"], scopes: ["test:money:read"] },
      params: z.object({}).passthrough(),
      handler: async () => ({ amount: 5 }),
    } as never)

    await handleToolCall(post(), "test__priced_read", {})
    expect(await taintWindow(seed.orgId, agentId)).toContain("test:money:read")
    const touchedKey = mcpTurnTaintTouchedKey(seed.orgId, agentId)
    const stamps = await redis.hgetall(touchedKey)
    expect(Object.keys(stamps).sort()).toEqual(["test:items:read", "test:money:read"])

    // A window after its last read, while the runtime keeps calling other tools, it is gone.
    const stale = String(Date.now() - (MCP_ACCESS_TOKEN_TTL_SECONDS + 60) * 1000)
    for (const scope of Object.keys(stamps)) await redis.hset(touchedKey, scope, stale)
    await handleToolCall(post(), "kpi__kpi_list_hubs", {})
    expect(await taintWindow(seed.orgId, agentId)).not.toContain("test:money:read")
  }, 30_000)

  it("a read without the readOnly mark parks on a tainted turn; with the mark it runs", async () => {
    const { seed, post } = await seedAgentBound()
    orgs.push(seed.orgId)
    ran.length = 0

    const read = await handleToolCall(post(), "test__listItems", {})
    expect(read.isError).toBeFalsy()

    const unmarked = await handleToolCall(post(), "test__peek_unmarked", {})
    const parked = unmarked.structuredContent as { gated?: boolean; executed?: boolean }
    expect(parked.gated).toBe(true)
    expect(parked.executed).toBe(false)
    const pending = await sql<{ tool_name: string }[]>`
      SELECT tool_name FROM kernel.approval_requests
      WHERE org_id = ${seed.orgId} AND status = 'pending'`
    expect(pending.map((r) => r.tool_name)).toEqual(["test:peek_unmarked"])

    const marked = await handleToolCall(post(), "test__peek_marked", {})
    expect(marked.isError).toBeFalsy()
    expect((marked.structuredContent as { gated?: boolean } | undefined)?.gated).not.toBe(true)
    expect(ran).toEqual(["peek_marked"])
  }, 30_000)

  it("boxtal track, get_shipment and prep_list run on a tainted turn instead of parking", async () => {
    const { seed, post } = await seedAgentBound()
    orgs.push(seed.orgId)
    ran.length = 0

    expect((await handleToolCall(post(), "test__listItems", {})).isError).toBeFalsy()
    for (const name of BOXTAL_READS) {
      const res = await handleToolCall(post(), `test__${name}`, {})
      expect(res.isError).toBeFalsy()
      expect((res.structuredContent as { gated?: boolean } | undefined)?.gated).not.toBe(true)
    }
    expect(ran).toEqual([...BOXTAL_READS])
    const pending = await sql`
      SELECT 1 FROM kernel.approval_requests WHERE org_id = ${seed.orgId} AND status = 'pending'`
    expect(pending.length).toBe(0)
  }, 30_000)
})
