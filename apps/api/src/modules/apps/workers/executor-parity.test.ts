// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Executor parity: the same fixture apps, installed through the real install
// path, called through the real tool route / webhook route / runApp, on the
// QuickJS worker pool and on the Workers executor (a local loader that behaves
// like the real one, module caching included: __fixtures__/fake-loader.ts).
// Results, errors and database effects must be equal, and nothing secret may
// cross the bridge route to the isolate.
//
// Plus the Workers-only properties: concurrent runs of one org each reach
// their own run, a nested hop under a breadth cap of 1 completes, a replayed
// /run body drives no second effect, and every fallback to QuickJS is tagged.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server } from "bun"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import { reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball, uninstallApp } from "~/modules/apps/install-service"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { clearInstalledIdentityCache, runApp } from "~/modules/apps/sandbox/run-app"
import { shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { buildWorkerBundle } from "../../../../../../scripts/apps-build-worker-bundle"
import { freezeApp } from "../../../../../../scripts/freeze-app"
import { type FakeLoader, startFakeLoader } from "./__fixtures__/fake-loader"
import { workersAdmission } from "./admission"
import { runRegistry } from "./run-registry"
import { assertNoSecretsIn } from "./secret-scan"
import { clearBridgeTimings, recentBridgeTimings, recentRunTimings } from "./timings"

const REPO = join(import.meta.dir, "../../../../../..")
const FIXTURES = join(import.meta.dir, "__fixtures__", "apps")
const FIXTURE_APPS = ["wparityb", "wparity"]
const CELL_ID = "cell-parity"
const CELL_KEY = "parity-cell-key-0123456789abcdef"
const CARRIER_KEY = "carrier-api-key-7f3e9a1c55d2"
const SECRETS = { carrierKey: CARRIER_KEY, cellKey: CELL_KEY }
const APP_SECRET = "carrier-app-held-secret-4b8d1e"

const ENV_KEYS = [
  "LIAISON_WORKERS_APPS",
  "LIAISON_APP_LOADER_URL",
  "LIAISON_APP_LOADER_CELL_ID",
  "LIAISON_APP_LOADER_KEY",
  "LIAISON_APP_BRIDGE_BASE_URL",
  "LIAISON_WORKERS_BUNDLES",
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, env[k]]))
const savedRole = env.LIAISON_ROLE
const savedAppsDir = process.env.LIAISON_APPS_DIR

let scratch = ""
let orgId = ""
let userA: minimal.Person
let userB: minimal.Person
let bearerA = ""
let bearerB = ""
let cell: Server<undefined> | null = null
/** The bulk download's host (the bulk fetch resolves its host before the stub answers). */
let files: Server<undefined> | null = null
let cellOrigin = ""
let loader: FakeLoader
const bundles: Record<string, string> = {}
/** The credential values the carrier stub received (host-side injection). */
const injectedKeys: string[] = []
const loaderFiles: Record<string, { workerPath: string; corePath: string }> = {}

type Mutable = Record<string, unknown>

function workersOn(over: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  const e = env as unknown as Mutable
  e.LIAISON_WORKERS_APPS = "wparity,wparityb"
  e.LIAISON_APP_LOADER_URL = loader.url
  e.LIAISON_APP_LOADER_CELL_ID = CELL_ID
  e.LIAISON_APP_LOADER_KEY = CELL_KEY
  e.LIAISON_APP_BRIDGE_BASE_URL = cellOrigin
  e.LIAISON_WORKERS_BUNDLES = JSON.stringify(bundles)
  Object.assign(e, over)
}

/** QuickJS, with the apps still listed (so their runs are timed and tagged). */
function workersOff() {
  const e = env as unknown as Mutable
  for (const k of ENV_KEYS) e[k] = undefined
  e.LIAISON_WORKERS_APPS = "wparity,wparityb"
}

const bearerOf = (who: "A" | "B") => (who === "A" ? bearerA : bearerB)

async function callTool(tool: string, params: unknown = {}, who: "A" | "B" = "A") {
  const res = await app.request(`http://localhost/api/apps/wparity/tools/${tool}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearerOf(who)}`, "content-type": "application/json" },
    body: JSON.stringify({ params }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

async function countTitled(title: string): Promise<number> {
  const rows = await sql.unsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM app_wparity.items WHERE org_id = $1 AND title = $2`,
    [orgId, title],
  )
  return rows[0]?.n ?? 0
}

async function eventsMarked(markers: string[]) {
  return sql<{ marker: string; actor: string }[]>`
    SELECT payload->'data'->>'marker' AS marker, payload->>'actorId' AS actor
    FROM kernel.pending_events
    WHERE org_id = ${orgId} AND payload->'data'->>'marker' IN ${sql(markers)}`
}

function lastRun(entry: string) {
  const runs = recentRunTimings().filter((r) => r.app === "wparity" && r.entry === entry)
  return runs[runs.length - 1]
}

/** Run `fn` on QuickJS then on Workers; return both, and check the executor tags. */
async function both<T>(entry: string, fn: (mode: "quickjs" | "workers") => Promise<T>) {
  workersOff()
  const quickjs = await fn("quickjs")
  expect(lastRun(entry)?.executor).toBe("quickjs")
  workersOn()
  const before = loader.bridgeResponses.length
  const workers = await fn("workers")
  expect(lastRun(entry)?.executor).toBe("workers")
  for (const text of loader.bridgeResponses.slice(before)) assertNoSecretsIn(text, SECRETS)
  assertNoSecretsIn(workers, SECRETS)
  return { quickjs, workers }
}

beforeAll(async () => {
  await acquireTestLock()
  scratch = mkdtempSync(join(tmpdir(), "executor-parity-"))
  process.env.LIAISON_APPS_DIR = join(scratch, "installed")
  ;(env as unknown as Mutable).LIAISON_ROLE = "all"
  orgId = (await createTestOrg()).id
  userA = await minimal.orgAdmin(orgId)
  userB = await minimal.person(orgId, { role: "admin" })
  bearerA = await minimal.token(userA.id)
  bearerB = await minimal.token(userB.id)
  // A previous run's records (the namespace database outlives the install root).
  for (const name of FIXTURE_APPS) await uninstallApp({ name }).catch(() => undefined)

  for (const name of FIXTURE_APPS) {
    const appDir = join(FIXTURES, name)
    const { tarballPath, manifest } = await freezeApp({
      appName: name,
      appDir,
      repoRoot: REPO,
      outDir: join(scratch, "tarballs"),
    })
    await installAppFromTarball({
      tarballPath,
      installedBy: userA.id,
      grantedScopes: manifest.scopes ?? [],
      grantedConnections: Object.keys(manifest.connections ?? {}),
      grantedCapabilities: (manifest as { capabilities?: string[] }).capabilities ?? [],
      grantedCrossAppCalls: name === "wparity" ? ["wparityb:echo"] : [],
      requireSignature: false,
      approveUiFullAccess: true,
    })
    const built = await buildWorkerBundle({ appDir, outRoot: join(scratch, "dist-worker") })
    bundles[`${built.app}@${built.version}`] = built.sha256
    loaderFiles[`${built.app}/${built.version}/${built.sha256}.js`] = {
      workerPath: built.workerPath,
      corePath: built.corePath,
    }
  }
  await reloadInstalledApps(orgId)

  await withPrivilegedDb(orgId, "parity-carrier-connection", (tx) =>
    createCredentialConnection(tx as never, orgId, userA.id, "wparity", "carrier", {
      identifier: "carrier-1",
      credentials: { key: CARRIER_KEY },
      displayName: "Carrier",
      ownerType: "org",
    }),
  )

  // The carrier's API, for both executors (egress happens host-side either way).
  SandboxBridgeTestAccess.setFetchInterceptsHost((h) => h === "api.carrier.test")
  SandboxBridgeTestAccess.setFetch((async (url: string, init?: RequestInit) => {
    const u = new URL(String(url))
    if (u.pathname === "/bulk.jsonl") {
      return new Response('{"n":1}\n{"n":2}\n{"n":3}\n', {
        headers: { "content-type": "application/x-ndjson" },
      })
    }
    const headers = new Headers(init?.headers)
    if (headers.get("x-api-key")) injectedKeys.push(headers.get("x-api-key") as string)
    // Echo the credential back: the host must redact it from the answer.
    return Response.json({ path: u.pathname, sawKey: headers.get("x-api-key") })
  }) as unknown as typeof fetch)

  files = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response('{"n":1}\n{"n":2}\n{"n":3}\n', {
        headers: { "content-type": "application/x-ndjson" },
      }),
  })
  cell = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => app.fetch(req) })
  cellOrigin = `http://127.0.0.1:${cell.port}`
  loader = startFakeLoader({
    cells: { [CELL_ID]: { key: CELL_KEY, bridgeOrigin: cellOrigin } },
    bundles: loaderFiles,
  })
  workersOff()
}, 600_000)

afterAll(async () => {
  const e = env as unknown as Mutable
  for (const k of ENV_KEYS) e[k] = savedEnv[k]
  e.LIAISON_ROLE = savedRole
  SandboxBridgeTestAccess.setFetch(null)
  SandboxBridgeTestAccess.setFetchInterceptsHost(null)
  loader?.stop()
  cell?.stop(true)
  files?.stop(true)
  await shutdownWorkerPool()
  for (const name of FIXTURE_APPS) await uninstallApp({ name }).catch(() => undefined)
  clearInstalledIdentityCache()
  if (savedAppsDir === undefined) delete process.env.LIAISON_APPS_DIR
  else process.env.LIAISON_APPS_DIR = savedAppsDir
  rmSync(scratch, { recursive: true, force: true })
  await releaseTestLock()
}, 120_000)

describe("Workers executor parity with the QuickJS pool", () => {
  it("db write then read: same answers, same rows", async () => {
    const r = await both("tool:create", (mode) => callTool("create", { title: `w-${mode}` }))
    expect(r.quickjs.status).toBe(200)
    expect(r.workers.status).toBe(r.quickjs.status)
    expect(r.workers.body.data).toEqual({ ...r.quickjs.body.data, title: "w-workers" })
    expect(await countTitled("w-quickjs")).toBe(1)
    expect(await countTitled("w-workers")).toBe(1)
    const l = await both("tool:list", () => callTool("list"))
    expect(l.workers).toEqual(l.quickjs)
    expect(l.quickjs.body.data.titles).toEqual(expect.arrayContaining(["w-quickjs", "w-workers"]))
  })

  it("an atomic tool that writes then throws: the same error and the same rows on both", async () => {
    // Installed apps are never trusted, so the runtime ignores their `atomic`
    // flag (runtime.ts, tool registration) and each bridge call commits on its
    // own: the write survives the throw, identically on both executors.
    const r = await both("tool:atomicFail", (mode) =>
      callTool("atomicFail", { title: `atomic-${mode}` }),
    )
    expect(r.quickjs.status).toBeGreaterThanOrEqual(400)
    expect(r.workers).toEqual(r.quickjs)
    expect(await countTitled("atomic-workers")).toBe(await countTitled("atomic-quickjs"))
  })

  it("a nested cross-app call into a second Workers app", async () => {
    const r = await both("tool:hop", () => callTool("hop", { v: "x1" }))
    expect(r.quickjs.status).toBe(200)
    expect(r.workers).toEqual(r.quickjs)
    const hop = lastRun("tool:hop")
    const nested = recentRunTimings().filter((t) => t.app === "wparityb" && t.at >= (hop?.at ?? 0))
    expect(nested.at(-1)).toMatchObject({
      executor: "workers",
      nested: true,
      parentApp: "wparity",
      entry: "tool:echo",
    })
  })

  it("ctx.fetch outside allowedDomains is refused the same way", async () => {
    const r = await both("tool:fetchOutside", () => callTool("fetchOutside"))
    expect(r.quickjs.body.data.refused).toBe(true)
    expect(r.workers).toEqual(r.quickjs)
  })

  it("ctx.fetch auth: the credential is added host-side and never reaches the isolate", async () => {
    injectedKeys.length = 0
    const r = await both("tool:fetchAuth", () => callTool("fetchAuth"))
    expect(r.quickjs.status).toBe(200)
    expect(injectedKeys).toEqual([CARRIER_KEY, CARRIER_KEY])
    expect(r.workers).toEqual(r.quickjs)
    assertNoSecretsIn(r.quickjs, SECRETS)
  })

  it("ctx.config.get of a declared secret: QuickJS reads it, Workers refuses it, even with the registry cleared", async () => {
    // The refusal must come from the bridge's own manifest (what config_get
    // decrypts), never the in-memory connection registry, which can be empty.
    const registered = connectionConfigRegistry.snapshotUnder([orgId, "wparity"])
    connectionConfigRegistry.deleteByPrefix([orgId, "wparity"])
    try {
      workersOff()
      const quickjs = await callTool("configSecret", { value: APP_SECRET })
      expect(lastRun("tool:configSecret")?.executor).toBe("quickjs")
      expect(quickjs.status).toBe(200)
      expect(quickjs.body.data).toEqual({ read: APP_SECRET })
      workersOn()
      const before = loader.bridgeResponses.length
      const workers = await callTool("configSecret", { value: APP_SECRET })
      expect(lastRun("tool:configSecret")?.executor).toBe("workers")
      expect(workers.status).toBe(200)
      expect(workers.body.data).toEqual({
        refused: true,
        code: "secret_not_available_on_workers",
        status: 403,
      })
      for (const text of loader.bridgeResponses.slice(before)) {
        assertNoSecretsIn(text, { ...SECRETS, app: APP_SECRET })
      }
    } finally {
      connectionConfigRegistry.restoreUnder([orgId, "wparity"], registered)
    }
  })

  it("emit and logger", async () => {
    const r = await both("tool:stamp", (mode) => callTool("stamp", { marker: `m-${mode}` }))
    expect(r.workers.body.data).toEqual({ stamped: "m-workers" })
    expect(r.quickjs.body.data).toEqual({ stamped: "m-quickjs" })
    const events = await eventsMarked(["m-quickjs", "m-workers"])
    expect(events.map((e) => e.marker).sort()).toEqual(["m-quickjs", "m-workers"])
    expect(new Set(events.map((e) => e.actor))).toEqual(new Set([userA.id]))
  })

  it("the bulk iterator over a downloaded blob", async () => {
    const r = await both("tool:bulk", () => callTool("bulk", { url: `${files?.url}bulk.jsonl` }))
    expect(r.quickjs.body.data?.rows).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    expect(r.workers).toEqual(r.quickjs)
  })

  it("the approval literal", async () => {
    const approval = {
      approvalRequestId: "00000000-0000-4000-8000-0000000a0001",
      approvalDeciderId: userA.id,
      toolName: "wparity:approvalEcho",
    }
    const bundlePath = join(process.env.LIAISON_APPS_DIR ?? "", "wparity", "1.0.0", "bundle.js")
    const r = await both("handler:approvalEcho", () =>
      runApp({
        trusted: false,
        appName: "wparity",
        orgId,
        bundlePath,
        exportName: "approvalEcho",
        params: {},
        bridge: { log_info: async () => null },
        holdsTx: false,
        syncContext: { approval },
      }),
    )
    expect(r.quickjs).toEqual({ approval, truthy: true })
    expect(r.workers).toEqual(r.quickjs)
  })

  it("thrown errors: a typed error and a ToolError keep message, status and code", async () => {
    const typed = await both("tool:fail", () => callTool("fail"))
    expect(typed.quickjs.status).toBe(422)
    expect(typed.workers).toEqual(typed.quickjs)
    const tool = await both("tool:toolFail", () => callTool("toolFail"))
    expect(tool.quickjs.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(tool.quickjs.body)).toContain("the carrier refused the parcel")
    expect(tool.workers).toEqual(tool.quickjs)
  })

  it("a timeout answers the same error, and the run's token dies with it", async () => {
    // The tool declares 1.5 s; the sandbox floor (60 s outside production) is lowered under it.
    const savedFloor = process.env.LIAISON_SANDBOX_TIMEOUT_MS
    process.env.LIAISON_SANDBOX_TIMEOUT_MS = "1000"
    let r: Awaited<ReturnType<typeof both<{ status: number; body: Record<string, any> }>>>
    try {
      r = await both("tool:slow", () => callTool("slow", { ms: 4_000 }))
    } finally {
      if (savedFloor === undefined) delete process.env.LIAISON_SANDBOX_TIMEOUT_MS
      else process.env.LIAISON_SANDBOX_TIMEOUT_MS = savedFloor
    }
    expect(JSON.stringify(r.quickjs.body)).toContain("timed out")
    expect(r.workers).toEqual(r.quickjs)
    const run = lastRun("tool:slow")
    expect(run?.runId).toBeDefined()
    expect(runRegistry.authenticate(run?.runId as string, "x", "n").kind).toBe("bad_token")
  }, 30_000)

  it("a webhook delivery inside its transaction", async () => {
    const post = (title: string) =>
      app.request(`http://localhost/webhooks/${orgId}/wparity/ping`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      })
    const r = await both("webhook:onPing", async (mode) => {
      const res = await post(`hook-${mode}`)
      return { status: res.status, body: await res.text() }
    })
    expect(r.quickjs.status).toBe(200)
    expect(r.workers).toEqual(r.quickjs)
    expect(await countTitled("hook-quickjs")).toBe(1)
    expect(await countTitled("hook-workers")).toBe(1)
    expect(lastRun("webhook-verify:verifyPing")?.executor).toBe("workers")
  })
})

describe("Workers-only properties", () => {
  it("two concurrent runs of one org, by two users, each reach their own run (module cached)", async () => {
    workersOn()
    clearBridgeTimings()
    const cold = loader.coldLoads
    const [a, b] = await Promise.all([
      callTool("stamp", { marker: "conc-A" }, "A"),
      callTool("stamp", { marker: "conc-B" }, "B"),
    ])
    expect(a.body.data).toEqual({ stamped: "conc-A" })
    expect(b.body.data).toEqual({ stamped: "conc-B" })
    expect(loader.coldLoads).toBe(cold) // the cached module served both
    const runs = recentRunTimings().filter((t) => t.entry === "tool:stamp")
    const runIds = new Set(runs.map((t) => t.runId))
    expect(runIds.size).toBe(2)
    for (const id of runIds) {
      expect(recentBridgeTimings().filter((t) => t.runId === id).length).toBeGreaterThan(0)
    }
    const events = await eventsMarked(["conc-A", "conc-B"])
    expect(Object.fromEntries(events.map((e) => [e.marker, e.actor]))).toEqual({
      "conc-A": userA.id,
      "conc-B": userB.id,
    })
  })

  it("a nested hop under a breadth cap of 1 and an org cap of 1 completes (no deadlock)", async () => {
    workersOn()
    const limits = workersAdmission.getLimits()
    workersAdmission.setLimits({ perOrg: 1, nestedBreadthPerParent: 1, holdsTxGlobal: 1 })
    try {
      const r = await callTool("hop", { v: "capped" })
      expect(r.status).toBe(200)
      expect(JSON.stringify(r.body)).toContain("capped")
    } finally {
      workersAdmission.setLimits(limits)
    }
  }, 30_000)

  it("a replayed /run body drives no second effect (nonce pinned, then settled)", async () => {
    workersOn()
    const from = loader.runs.length
    const pending = callTool("slowCreate", { ms: 800, title: "replay-1" })
    let recorded: (typeof loader.runs)[number] | undefined
    for (let i = 0; i < 100 && !recorded; i++) {
      recorded = loader.runs.slice(from).find((r) => r.body.includes('"slowCreate"'))
      if (!recorded) await new Promise((r) => setTimeout(r, 20))
    }
    expect(recorded).toBeDefined()
    const replay = () =>
      fetch(`${loader.url}/run`, {
        method: "POST",
        headers: recorded?.headers ?? {},
        body: recorded?.body ?? "",
      }).then(async (res) => ({ status: res.status, body: (await res.json()) as any }))
    const during = await replay()
    expect((await pending).status).toBe(200)
    const after = await replay()
    // The replays ran the module, but every bridge call was refused, so the
    // handler failed before its insert.
    expect(during.body.ok).toBe(false)
    expect(after.body.ok).toBe(false)
    expect(await countTitled("replay-1")).toBe(1)
  }, 30_000)

  it("a listed app with no bundle for its installed version runs on QuickJS, tagged", async () => {
    const only = Object.fromEntries(
      Object.entries(bundles).filter(([k]) => k.startsWith("wparityb@")),
    )
    workersOn({ LIAISON_WORKERS_BUNDLES: JSON.stringify(only) })
    const r = await callTool("list")
    expect(r.status).toBe(200)
    expect(lastRun("tool:list")?.executor).toBe("quickjs")
  })

  it("a bad loader signature surfaces as an error and revokes the run's token", async () => {
    workersOn({ LIAISON_APP_LOADER_KEY: "not-the-cell-key-at-all-000000" })
    const live = runRegistry.size()
    const from = loader.runs.length
    const r = await callTool("list")
    expect(r.status).toBeGreaterThanOrEqual(500)
    expect(lastRun("tool:list")).toMatchObject({ executor: "workers", ok: false })
    expect(runRegistry.size()).toBe(live)
    const sent = JSON.parse(loader.runs[from]?.body ?? "{}") as { runId: string; runToken: string }
    const res = await fetch(`${cellOrigin}/api/app-bridge/${sent.runId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sent.runToken}`,
        "x-exec-nonce": "n",
        "content-type": "application/json",
      },
      body: JSON.stringify({ callId: 1, method: "db_findMany", args: ["items", "{}"] }),
    })
    expect(res.status).toBe(410)
  })

  it('role "worker" runs every app on QuickJS', async () => {
    workersOn()
    ;(env as unknown as Mutable).LIAISON_ROLE = "worker"
    try {
      const r = await callTool("list")
      expect(r.status).toBe(200)
      expect(lastRun("tool:list")?.executor).toBe("quickjs")
    } finally {
      ;(env as unknown as Mutable).LIAISON_ROLE = "all"
    }
  })
})
