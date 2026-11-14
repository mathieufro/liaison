// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A restricted (device-flow) session's REST call to a tool is a program's call,
// never a person's click: gates, outside-text taint and host rules apply as they
// do for an MCP client. A normal session's call stays a person's click.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { approvalRequests, threads } from "~/db/schema/kernel"
import { SINK_KERNEL_AGENT_MEMORY } from "~/modules/agent/scopes/scope-taint"
import { manifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { registerBulkAgentTools } from "~/modules/apps/bulk-agent-tools"
import { createSession, refreshSession } from "~/modules/auth/auth"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const APP = "resttoolcall_test"
// A scope an admin holds and a capped client can declare, so the tools below are
// about origin only: every call here is authorized on its scope.
const SCOPE = "kernel:threads:read"

let orgId: string
let userId: string
const runs = new Map<string, number>()
let callSeq = 0

function register(name: string, extra: Record<string, unknown> = {}) {
  toolRegistry.set([orgId, APP, name], {
    appName: APP,
    name,
    description: name,
    requiredScopes: [SCOPE],
    gated: false,
    handler: async () => {
      runs.set(name, (runs.get(name) ?? 0) + 1)
      return { ok: true }
    },
    ...extra,
  })
}

const ranCount = (name: string) => runs.get(name) ?? 0

const post = (path: string, token: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

/** Every REST form of "run this tool". Params differ per call so nothing dedupes. */
const ROUTES: Record<
  string,
  (token: string, tool: string, extra?: object) => Response | Promise<Response>
> = {
  "POST /api/apps/run-tool": (token, tool, extra = {}) =>
    post("/api/apps/run-tool", token, {
      toolName: `${APP}:${tool}`,
      params: { n: ++callSeq },
      ...extra,
    }),
  "POST /api/apps/tools/:toolName": (token, tool, extra = {}) =>
    post(`/api/apps/tools/${encodeURIComponent(`${APP}:${tool}`)}`, token, {
      params: { n: ++callSeq },
      ...extra,
    }),
  "POST /api/apps/:appName/tools/:toolName": (token, tool, extra = {}) =>
    post(`/api/apps/${APP}/tools/${tool}`, token, { params: { n: ++callSeq }, ...extra }),
}

async function runTool(token: string, tool: string, extra: object = {}) {
  const res = await ROUTES["POST /api/apps/run-tool"]?.(token, tool, extra)
  if (!res) throw new Error("no route")
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: { blocked?: { approvalRequestId?: string } } }).data
}

/** A fresh device sign-in: its own session family, so its own outside-text mark. */
const restrictedLogin = () => createSession(userId, orgId, [SCOPE])
/** A fresh normal sign-in: a person's sessions are capped, so an old one here would be evicted. */
const browserLogin = async () => (await createSession(userId, orgId)).accessToken

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  userId = (await minimal.session(orgId, { role: "admin" })).userId

  register("gatedWrite", { gated: true })
  register("readOutside", { taintSource: true, readOnly: true })
  register("sendOut", { externalEffect: true })
  register("noteToMemory", { writesToTable: SINK_KERNEL_AGENT_MEMORY })
  register("runOnComputer", { requiresHumanTurn: true })

  const bulk = {
    close: {
      label: "Close",
      underlyingTool: "gatedWrite",
      dispatchMode: "perItem" as const,
      perItemParam: "itemId",
      sharedFields: [],
      agentTool: "bulkClose",
    },
    send: {
      label: "Send",
      underlyingTool: "sendOut",
      dispatchMode: "perItem" as const,
      perItemParam: "itemId",
      sharedFields: [],
      agentTool: "bulkSend",
    },
  }
  manifestRegistry.set([orgId, APP], { name: APP, bulk, uiBundleUrl: null })
  registerBulkAgentTools({
    orgId,
    appName: APP,
    bulk,
    tools: {
      gatedWrite: { requiredScopes: [SCOPE], params: { properties: {} } },
      sendOut: { requiredScopes: [SCOPE], params: { properties: {} } },
    },
  })
}, 60_000)

afterAll(async () => {
  toolRegistry.deleteByPrefix([orgId, APP])
  manifestRegistry.delete([orgId, APP])
  await clearRedisPatterns([`bulk:${orgId}:*`])
  await releaseTestLock()
})

describe("the gate", () => {
  for (const [route, call] of Object.entries(ROUTES)) {
    it(`${route}: a restricted session's gated call parks an approval and does not run`, async () => {
      const { accessToken } = await restrictedLogin()
      const before = ranCount("gatedWrite")
      const res = await call(accessToken, "gatedWrite")
      expect(res.status).toBe(200)
      const { data } = (await res.json()) as {
        data: { blocked?: { approvalRequestId?: string } }
      }
      expect(typeof data.blocked?.approvalRequestId).toBe("string")
      expect(ranCount("gatedWrite")).toBe(before)
    })

    it(`${route}: a normal session's gated call runs, its click is the decision`, async () => {
      const before = ranCount("gatedWrite")
      const res = await call(await browserLogin(), "gatedWrite")
      expect(res.status).toBe(200)
      const { data } = (await res.json()) as { data: { blocked?: unknown; ok?: boolean } }
      expect(data.blocked).toBeUndefined()
      expect(data.ok).toBe(true)
      expect(ranCount("gatedWrite")).toBe(before + 1)
    })
  }

  it("the approval hangs off a thread hidden from every list, in the caller's name", async () => {
    const { accessToken } = await restrictedLogin()
    const { blocked } = await runTool(accessToken, "gatedWrite")
    const id = blocked?.approvalRequestId as string
    const [row] = await withSystemDb("rest-tool-call-approval", (db) =>
      db
        .select({ threadId: approvalRequests.threadId, requestedBy: approvalRequests.requestedBy })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, id)),
    )
    expect(row?.requestedBy).toBe(userId)
    const [thread] = await withSystemDb("rest-tool-call-thread", (db) =>
      db
        .select({ hidden: threads.hiddenFromList, type: threads.type })
        .from(threads)
        .where(eq(threads.id, row?.threadId as string)),
    )
    expect(thread).toEqual({ hidden: true, type: "approval" })
  })

  it("a bulk action by a restricted session parks each item; a normal session's runs", async () => {
    const { accessToken } = await restrictedLogin()
    const ids = [crypto.randomUUID(), crypto.randomUUID()]
    const before = ranCount("gatedWrite")
    const parked = await post(`/api/apps/${APP}/bulk/close`, accessToken, {
      ids,
      params: {},
      idempotencyKey: crypto.randomUUID(),
    })
    expect(parked.status).toBe(200)
    const { data } = (await parked.json()) as { data: { approvalsCreated?: number } }
    expect(data.approvalsCreated).toBe(2)
    expect(ranCount("gatedWrite")).toBe(before)

    const clicked = await post(`/api/apps/${APP}/bulk/close`, await browserLogin(), {
      ids,
      params: {},
      idempotencyKey: crypto.randomUUID(),
    })
    expect(clicked.status).toBe(200)
    expect(ranCount("gatedWrite")).toBe(before + 2)
  })
})

describe("outside-text taint and host rules", () => {
  it("a bulk outward action after outside text parks each item", async () => {
    const { accessToken } = await restrictedLogin()
    await runTool(accessToken, "readOutside")
    const before = ranCount("sendOut")
    const res = await post(`/api/apps/${APP}/bulk/send`, accessToken, {
      ids: [crypto.randomUUID()],
      params: {},
      idempotencyKey: crypto.randomUUID(),
    })
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { approvalsCreated?: number } }
    expect(data.approvalsCreated).toBe(1)
    expect(ranCount("sendOut")).toBe(before)
  })

  it("what a restricted session read marks its next outward call, with no thread named", async () => {
    const { accessToken } = await restrictedLogin()
    const before = ranCount("sendOut")
    expect((await runTool(accessToken, "sendOut")).blocked).toBeUndefined()
    expect(ranCount("sendOut")).toBe(before + 1)

    await runTool(accessToken, "readOutside")
    const { blocked } = await runTool(accessToken, "sendOut")
    expect(typeof blocked?.approvalRequestId).toBe("string")
    expect(ranCount("sendOut")).toBe(before + 1)
  })

  it("naming a clean thread does not shed the mark", async () => {
    const { accessToken } = await restrictedLogin()
    const clean = await minimal.thread(orgId, userId)
    await runTool(accessToken, "readOutside")
    const before = ranCount("sendOut")
    const { blocked } = await runTool(accessToken, "sendOut", { threadId: clean })
    expect(typeof blocked?.approvalRequestId).toBe("string")
    expect(ranCount("sendOut")).toBe(before)
  })

  it("the mark survives a token refresh: it belongs to the sign-in, not the token", async () => {
    const { accessToken, refreshToken } = await restrictedLogin()
    await runTool(accessToken, "readOutside")
    const { accessToken: next } = await refreshSession(refreshToken, {})
    expect(next).not.toBe(accessToken)
    const before = ranCount("sendOut")
    const { blocked } = await runTool(next, "sendOut")
    expect(typeof blocked?.approvalRequestId).toBe("string")
    expect(ranCount("sendOut")).toBe(before)
  })

  it("another device sign-in starts unmarked", async () => {
    const first = await restrictedLogin()
    await runTool(first.accessToken, "readOutside")
    const second = await restrictedLogin()
    const { blocked } = await runTool(second.accessToken, "sendOut")
    expect(blocked).toBeUndefined()
  })

  it("host rule: a write to the agent's memory after outside text parks", async () => {
    const { accessToken } = await restrictedLogin()
    await runTool(accessToken, "readOutside")
    const before = ranCount("noteToMemory")
    const { blocked } = await runTool(accessToken, "noteToMemory")
    expect(typeof blocked?.approvalRequestId).toBe("string")
    expect(ranCount("noteToMemory")).toBe(before)
  })

  it("a tool that needs a person's typed turn never reads a restricted call as one", async () => {
    const { accessToken } = await restrictedLogin()
    const before = ranCount("runOnComputer")
    const { blocked } = await runTool(accessToken, "runOnComputer")
    expect(typeof blocked?.approvalRequestId).toBe("string")
    expect(ranCount("runOnComputer")).toBe(before)
  })

  it("a normal session is judged on none of this: its read marks nothing and its calls run", async () => {
    const beforeSend = ranCount("sendOut")
    const beforeMemory = ranCount("noteToMemory")
    const browserToken = await browserLogin()
    await runTool(browserToken, "readOutside")
    expect((await runTool(browserToken, "sendOut")).blocked).toBeUndefined()
    expect((await runTool(browserToken, "noteToMemory")).blocked).toBeUndefined()
    expect(ranCount("sendOut")).toBe(beforeSend + 1)
    expect(ranCount("noteToMemory")).toBe(beforeMemory + 1)
  })
})

describe("the one place a REST request becomes a person's click", () => {
  it('no other module passes origin "human-ui" to a tool', () => {
    const root = join(import.meta.dir, "..", "..")
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) {
          if (entry !== "tests" && entry !== "__fixtures__") walk(path)
        } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
          if (path.endsWith(join("apps", "rest-tool-call.ts"))) continue
          // The one reviewed exemption: the seed engine (`src/seed/**`, its tests are skipped
          // above anyway). It acts out seeded people entering their own time through the
          // product's own writer, so their rows are recorded exactly as a person's entry is.
          // Its arguments are fixed world data, never a request's, and it runs from the CLI,
          // the tests and the demo-mode signup only (the test below proves no other route
          // reaches it).
          if (path.startsWith(join(root, "seed") + sep)) continue
          if (/\borigin: "human-ui"/.test(readFileSync(path, "utf8"))) offenders.push(path)
        }
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })

  it("the seed engine is entered only through the demo module and the CLI, never by a route", () => {
    const root = join(import.meta.dir, "..", "..")
    const seedDir = join(root, "seed") + sep
    // The demo module runs only in demo mode (app.ts mounts its routes, and its jobs and
    // boot hooks start, behind that flag); the CLI is not a server path.
    const allowed = [seedDir, join(root, "modules", "demo") + sep, join(root, "cli") + sep]
    const ts = new Bun.Transpiler({ loader: "ts" })
    const tsx = new Bun.Transpiler({ loader: "tsx" })
    const resolveImport = (from: string, spec: string): string | null => {
      let base: string
      if (spec.startsWith("~/")) base = join(root, spec.slice(2))
      else if (spec.startsWith(".")) base = resolve(dirname(from), spec)
      else return null
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
        if (/\.tsx?$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) {
          return candidate
        }
      }
      return null
    }
    const offenders: string[] = []
    let scanned = 0
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) {
          if (entry !== "tests" && entry !== "__fixtures__") walk(path)
          continue
        }
        if (!/\.tsx?$/.test(entry) || entry.endsWith(".test.ts") || entry.endsWith(".test.tsx"))
          continue
        if (allowed.some((prefix) => path.startsWith(prefix))) continue
        scanned++
        // A script's shebang line is not TypeScript.
        const source = readFileSync(path, "utf8").replace(/^#!.*\n/, "\n")
        for (const imported of (entry.endsWith(".tsx") ? tsx : ts).scanImports(source)) {
          const target = resolveImport(path, imported.path)
          if (target?.startsWith(seedDir))
            offenders.push(`${relative(root, path)} -> ${relative(root, target)}`)
        }
      }
    }
    walk(root)
    expect(scanned).toBeGreaterThan(500)
    expect(offenders).toEqual([])
  })
})
