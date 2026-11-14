// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who a reconcile reads for and where it may run: the projects app reaches into no trace app and
// opens no privileged handle for it, the two tools run only on a person's own turn and in a DM
// (or the person's own coding agent), a turn that read elsewhere can still save its own card, and
// what the agent did not see is said on the card.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { projectsAppManifest } from "~/apps/projects/manifest-descriptor"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { NOT_EVERYTHING_SEEN } from "./reconcile-lines"
import { awaitTimeFeatureSync } from "./time-feature"
import { awaitTimeRowWrites } from "./time-rows"

let orgId = ""
let owner: minimal.Session
let projectId = ""
let taskId = ""
let dmThread = ""
let sharedThread = ""
let colleague = ""

const TRACE_APPS = ["gitlab", "github", "calendar", "knowledge", "mail", "tickets", "threads"]
const SRC = join(import.meta.dir, "..", "..", "..")

function actorOf(userId: string, scopes: string[] = ["*"]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

async function call<T = Record<string, any>>(method: string, input: unknown): Promise<T> {
  const a = actorOf(owner.userId)
  const out = await withRlsContext(a, async (tx) => {
    const bridge = createRpcBridge(
      "projects",
      a.userId,
      orgId,
      tx,
      { name: "projects" },
      a.scopes,
      "user",
      undefined,
      { origin: "human-ui" } as never,
    )
    return JSON.parse(await bridge[method](JSON.stringify(input))) as T
  })
  await awaitTimeRowWrites()
  return out
}

const proposal = (why = "The export.") => ({
  project: "ORBIT",
  lines: [{ name: "Export", why, taskIds: [taskId], proofs: [] }],
  notSeen: [{ source: "GitHub", why: "not connected" }],
})

type Outcome = { error?: { code?: string }; data?: unknown; [k: string]: unknown }

async function viaTool(
  name: "reconcile_facts" | "reconcile_propose" | "reconcile_get" | "reconcile_line_update",
  params: Record<string, unknown>,
  opts: {
    origin: "in-app-agent" | "mcp"
    threadId?: string
    frame?: Record<string, unknown>
    turnTaintScopes?: string[]
  },
): Promise<Outcome> {
  const run = () =>
    executeToolCore({
      toolName: `projects:${name}`,
      orgId,
      actor: actorOf(owner.userId),
      params,
      origin: opts.origin,
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
      ...(opts.turnTaintScopes ? { turnTaintScopes: opts.turnTaintScopes } : {}),
    } as never) as Promise<Outcome>
  if (!opts.frame) return run()
  const runId = crypto.randomUUID()
  const frame = {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator: createTurnScopeAccumulator({ orgId }),
    ...opts.frame,
  }
  return runContextStore.run(frame as never, run)
}

async function proposedCount(): Promise<number> {
  return (
    extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM app_projects.reconciliations WHERE org_id = ${orgId}::uuid`),
    )[0]?.n ?? 0
  )
}

/** The person's DM with their own agent, or a shared conversation with a colleague. */
async function thread(type: "agent_chat" | "thread"): Promise<string> {
  if (type === "agent_chat") return minimal.agentDm(orgId, owner.userId)
  return minimal.thread(orgId, owner.userId, { participantIds: [colleague] })
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  owner = await minimal.adminSession(orgId)
  colleague = (await minimal.session(orgId, { role: "member" })).userId
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
  const made = await call<{ id: string }>("projects_createProject", {
    name: "Orbit",
    key: "ORBIT",
    timeBudgets: true,
  })
  projectId = made.id
  await awaitTimeFeatureSync(orgId)
  const t = await call<{ id: string }>("projects_createTask", {
    projectId,
    title: "Export",
    statusLabel: "done",
    timebox: "2 h",
  })
  taskId = t.id
  dmThread = await thread("agent_chat")
  sharedThread = await thread("thread")
}, 120_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await releaseTestLock()
})

/** The first argument of every tool call in a source: direct, optional (`?.(`), any
 *  `executeTool*` variant, and by bracket access (`ctx["executeTool"](`). */
function toolCallArgs(text: string): string[] {
  const forms = [
    /\b(?:executeTool\w*|callTool)\s*(?:\?\.)?\s*\(\s*([^,)]*)/g,
    /\[\s*["'`](?:executeTool\w*|callTool)["'`]\s*\]\s*(?:\?\.)?\s*\(\s*([^,)]*)/g,
  ]
  return forms.flatMap((re) => [...text.matchAll(re)].map((m) => m[1]!.trim()))
}

/** Does a source import the kernel's tool dispatcher, statically or dynamically? */
function importsExecuteTool(text: string): boolean {
  return /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'`][^"'`]*modules\/apps\/execute-tool(?:\.ts)?["'`]/.test(
    text,
  )
}

describe("the tool-call guard", () => {
  it("catches each way of calling another app's tool", () => {
    const forms = [
      'ctx.executeTool("calendar:list_events", "{}")',
      'ctx.executeTool?.("calendar:list_events", "{}")',
      'ctx.executeTool ?.("calendar:list_events", "{}")',
      'ctx["executeTool"]("calendar:list_events", "{}")',
      'ctx[\'executeTool\']?.("calendar:list_events", "{}")',
      'executeToolCore({ toolName: "calendar:list_events" })',
      'ctx.callTool("calendar:list_events")',
    ]
    for (const form of forms) expect(toolCallArgs(form)).toHaveLength(1)
    expect(toolCallArgs("executeTool: (name: string) => Promise<string>")).toEqual([])
    for (const form of [
      'import { executeToolCore } from "~/modules/apps/execute-tool"',
      'const { executeTool } = await import("~/modules/apps/execute-tool")',
      'import type { X } from "../../modules/apps/execute-tool.ts"',
    ])
      expect(importsExecuteTool(form)).toBe(true)
    expect(importsExecuteTool('import { x } from "~/modules/apps/execute-tool-helpers"')).toBe(
      false,
    )
  })
})

describe("what a reconcile reads through", () => {
  it("the projects app declares no cross-app call into a trace app and reconcile code reads nothing privileged", () => {
    const calls = JSON.stringify(
      (projectsAppManifest as Record<string, unknown>).cross_app_calls ?? [],
    )
    for (const app of TRACE_APPS) expect(calls).not.toContain(`"${app}:`)
    const files = [
      ...readdirSync(join(SRC, "apps/projects/service"))
        .filter((f) => f === "reconcile.ts" || f === "reconcile-lines.ts")
        .map((f) => join(SRC, "apps/projects/service", f)),
    ]
    expect(files.length).toBe(2)
    for (const f of files) {
      const text = readFileSync(f, "utf8")
      expect(text).not.toMatch(/withPrivilegedDb|withSystemDb|__privileged_db__/)
      expect(text).not.toMatch(/executeTool|callTool|ctx\.call/)
    }
    // Anywhere in the projects app and its bridge, the one tool of another app it calls is the
    // invoiced amount its money half reads, named as a literal.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(dir, e.name))
          : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)
            ? [join(dir, e.name)]
            : [],
      )
    const sources = [
      ...walk(join(SRC, "apps/projects")),
      join(SRC, "modules/apps/sandbox/bridge/projects.ts"),
    ]
    expect(sources.length).toBeGreaterThan(20)
    const toolCalls: string[] = []
    for (const f of sources) {
      const text = readFileSync(f, "utf8")
      for (const arg of toolCallArgs(text)) toolCalls.push(`${f.slice(SRC.length + 1)}: ${arg}`)
      expect(text).not.toMatch(/\bctx\.call\s*\(/)
      if (f.includes("/apps/projects/")) expect(importsExecuteTool(text)).toBe(false)
    }
    expect(toolCalls).toEqual(['apps/projects/handlers.ts: "invoicing:project_invoiced_get"'])
    // The bridge methods of the two tools call the service alone.
    const bridge = readFileSync(join(SRC, "modules/apps/sandbox/bridge/projects.ts"), "utf8")
    for (const method of ["projects_reconcileFacts", "projects_reconcilePropose"]) {
      const start = bridge.indexOf(`${method}: async`)
      expect(start).toBeGreaterThan(0)
      const body = bridge.slice(start, bridge.indexOf("\n    },\n", start))
      expect(body).not.toMatch(/withPrivilegedDb|withSystemDb|executeTool/)
    }
  })

  it("both tools run only on a person's turn and in a DM, refused from a routine, a sub-run or a shared thread", async () => {
    const facts = { project: "ORBIT" }
    for (const frame of [
      { routineId: "00000000-0000-4000-8000-000000000001" },
      { background: true },
    ]) {
      for (const name of ["reconcile_facts", "reconcile_propose"] as const) {
        const out = await viaTool(name, name === "reconcile_facts" ? facts : proposal(), {
          origin: "in-app-agent",
          threadId: dmThread,
          frame,
        })
        expect(out.error?.code).toBe("human_turn_only")
      }
    }
    for (const name of ["reconcile_facts", "reconcile_propose"] as const) {
      const out = await viaTool(name, name === "reconcile_facts" ? facts : proposal(), {
        origin: "in-app-agent",
        threadId: sharedThread,
        frame: { humanTurn: true },
      })
      expect(out.error?.code).toBe("dm_only")
    }
    expect(await proposedCount()).toBe(0)
    const inDm = await viaTool("reconcile_facts", facts, {
      origin: "in-app-agent",
      threadId: dmThread,
      frame: { humanTurn: true },
    })
    expect(inDm.error).toBeUndefined()
  })

  it("the same proposal through the coding agent and through chat stores equal lines", async () => {
    const chat = await viaTool("reconcile_propose", proposal(), {
      origin: "in-app-agent",
      threadId: dmThread,
      frame: { humanTurn: true },
    })
    const viaChat = (chat.data ?? chat) as Record<string, any>
    expect(viaChat.error).toBeUndefined()
    const mcp = await viaTool("reconcile_propose", proposal(), {
      origin: "mcp",
      frame: { mcpGateway: true },
    })
    const viaMcp = (mcp.data ?? mcp) as Record<string, any>
    expect(viaMcp.error).toBeUndefined()
    expect(viaMcp.reconciliationId).toBe(viaChat.reconciliationId)
    expect(viaMcp.revision).toBe(viaChat.revision)
    expect(viaMcp.lines).toEqual(viaChat.lines)
  })

  it("the saved card is read and edited only in a DM, refused in a shared thread", async () => {
    const saved = await viaTool("reconcile_propose", proposal(), {
      origin: "in-app-agent",
      threadId: dmThread,
      frame: { humanTurn: true },
    })
    const card = (saved.data ?? saved) as Record<string, any>
    expect(card.reconciliationId).toBeString()
    const line = (card.groups as Array<{ lines: Array<{ lineId: string }> }>)
      .flatMap((g) => g.lines)
      .at(0)
    const update = {
      reconciliationId: card.reconciliationId,
      revision: card.revision,
      lineId: line?.lineId,
      wording: "Export, reworded",
    }
    const shared = {
      origin: "in-app-agent" as const,
      threadId: sharedThread,
      frame: { humanTurn: true },
    }
    const get = await viaTool("reconcile_get", { reconciliationId: card.reconciliationId }, shared)
    expect(get.error?.code).toBe("dm_only")
    const edit = await viaTool("reconcile_line_update", update, shared)
    expect(edit.error?.code).toBe("dm_only")
    const inDm = { origin: "in-app-agent" as const, threadId: dmThread, frame: { humanTurn: true } }
    const read = await viaTool("reconcile_get", { reconciliationId: card.reconciliationId }, inDm)
    expect(read.error).toBeUndefined()
    expect(JSON.stringify(read)).not.toContain("Export, reworded")
  })

  it("what was not seen is kept on the card, with the sentence that someone else may see more", async () => {
    const out = await call("projects_reconcilePropose", proposal())
    expect(out.notSeen).toEqual([{ source: "GitHub", why: "not connected" }])
    expect(out.notes).toContain(NOT_EVERYTHING_SEEN)
  })
})

describe("a turn that read another app's records", () => {
  it("a turn that read another app's records can still save its card; without the self-readers declaration the same save does not run", async () => {
    const taint = ["calendar:events:read"]
    const saved = await viaTool("reconcile_propose", proposal("Saved after a read."), {
      origin: "in-app-agent",
      threadId: dmThread,
      frame: { humanTurn: true },
      turnTaintScopes: taint,
    })
    const card = (saved.data ?? saved) as Record<string, any>
    expect(card.error).toBeUndefined()
    expect(card.lines?.[0]?.why).toBe("Saved after a read.")
    const key: [string, string, string] = [orgId, "projects", "reconcile_propose"]
    const entry = toolRegistry.get(key)
    expect(entry?.sinkReadersSelf).toBe(true)
    if (!entry) return
    toolRegistry.set(key, { ...entry, sinkReadersSelf: false })
    try {
      const plain = await viaTool("reconcile_propose", proposal("Saved without the key."), {
        origin: "in-app-agent",
        threadId: dmThread,
        frame: { humanTurn: true },
        turnTaintScopes: taint,
      })
      const text = JSON.stringify(plain)
      expect(text).not.toContain("Saved without the key.")
      expect(text).toMatch(/E_SCOPE_TAINT_BLOCKED|approvalRequestId|"blocked":true/)
    } finally {
      toolRegistry.set(key, entry)
    }
  })
})

describe("changing a line from outside a person's turn", () => {
  it("a routine or a sub-run cannot change what a line bills", async () => {
    const out = await viaTool("reconcile_propose", proposal(), {
      origin: "in-app-agent",
      threadId: dmThread,
      frame: { humanTurn: true },
    })
    const card = (out.data ?? out) as Record<string, any>
    expect(card.error).toBeUndefined()
    const line = (card.lines as Array<{ lineId: string }>)[0]
    for (const frame of [
      { routineId: "00000000-0000-4000-8000-000000000001" },
      { background: true },
    ]) {
      const out = await viaTool(
        "reconcile_line_update",
        {
          reconciliationId: card.reconciliationId,
          revision: card.revision,
          lineId: line?.lineId,
          bill: 9,
        },
        { origin: "in-app-agent", threadId: dmThread, frame },
      )
      expect(out.error?.code).toBe("human_turn_only")
    }
    const onTurn = await viaTool(
      "reconcile_line_update",
      {
        reconciliationId: card.reconciliationId,
        revision: card.revision,
        lineId: line?.lineId,
        bill: 1,
      },
      { origin: "in-app-agent", threadId: dmThread, frame: { humanTurn: true } },
    )
    expect(((onTurn.data ?? onTurn) as Record<string, any>).error).toBeUndefined()
  })
})
