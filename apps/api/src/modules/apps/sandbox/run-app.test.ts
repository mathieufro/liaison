// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import * as bundleLoader from "~/modules/apps/sandbox/bundle-loader"
import * as executor from "~/modules/apps/sandbox/executor"
import * as sandboxPool from "~/modules/apps/sandbox/pool"
import {
  clearInstalledIdentityCache,
  resolveInstalledIdentity,
  runApp,
  selectExecutor,
} from "~/modules/apps/sandbox/run-app"
import * as workerPool from "~/modules/apps/sandbox/worker-pool"

const fakeSandboxPool = { tag: "in-process" }

function spyBoundaries() {
  const inProcess = spyOn(executor, "executeInSandbox").mockResolvedValue("from-inprocess")
  spyOn(sandboxPool, "getSandboxPool").mockReturnValue(fakeSandboxPool as never)
  const execute = mock(async (_: unknown) => "from-pool")
  const init = spyOn(workerPool, "initWorkerPool").mockResolvedValue(undefined as never)
  spyOn(workerPool, "getWorkerPool").mockReturnValue({ execute } as never)
  return { inProcess, execute, init }
}

const bridge = { db_findMany: async () => [] }
const base = {
  appName: "kpi",
  orgId: "00000000-0000-0000-0000-000000000001",
  bundleSource: "globalThis.h = () => 1",
  exportName: "h",
  params: { a: 1 },
  bridge,
  holdsTx: false,
}

describe("runApp", () => {
  afterEach(() => mock.restore())

  it("selects in-process for trusted code and the worker pool otherwise", () => {
    expect(selectExecutor({ trusted: true })).toBe("inprocess")
    expect(selectExecutor({ trusted: false })).toBe("pool")
    // Workers only for untrusted code with a Worker bundle resolved.
    expect(selectExecutor({ trusted: false, workersBundleSha: "a".repeat(64) })).toBe("workers")
    expect(selectExecutor({ trusted: true, workersBundleSha: "a".repeat(64) })).toBe("inprocess")
  })

  it("runs trusted code in-process with exactly the executor's options", async () => {
    const { inProcess, execute, init } = spyBoundaries()
    const signal = new AbortController().signal
    const out = await runApp({
      ...base,
      trusted: true,
      extraArgs: [{ h: "1" }],
      timeoutMs: 9_000,
      signal,
      // Pool-only options never reach the in-process executor.
      priority: "background",
      appId: "kpi",
      nested: true,
    })
    expect(out).toBe("from-inprocess")
    expect(execute).not.toHaveBeenCalled()
    expect(init).not.toHaveBeenCalled()
    expect(inProcess.mock.calls[0]?.[0]).toEqual({
      pool: fakeSandboxPool as never,
      bundleSource: base.bundleSource,
      exportName: "h",
      params: { a: 1 },
      bridge,
      extraArgs: [{ h: "1" }],
      timeoutMs: 9_000,
      signal,
    })
  })

  it("runs untrusted code on the worker pool, initialised first, with every pool option", async () => {
    const { inProcess, execute, init } = spyBoundaries()
    const signal = new AbortController().signal
    const out = await runApp({
      ...base,
      trusted: false,
      timeoutMs: 60_000,
      signal,
      priority: "background",
      backgroundGroup: "job:kpi",
      appId: "kpi",
      toolName: "kpi_get",
      nested: true,
      nestedParentKey: "exec-1",
      syncContext: { approval: null },
      extraArgs: ["x"],
      holdsTx: true,
    })
    expect(out).toBe("from-pool")
    expect(inProcess).not.toHaveBeenCalled()
    expect(init).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]).toEqual({
      bundleSource: base.bundleSource,
      exportName: "h",
      params: { a: 1 },
      bridge,
      extraArgs: ["x"],
      timeoutMs: 60_000,
      syncContext: { approval: null },
      priority: "background",
      backgroundGroup: "job:kpi",
      nested: true,
      nestedParentKey: "exec-1",
      signal,
      appId: "kpi",
      toolName: "kpi_get",
    })
  })

  it("leaves unset options unset (the pool and executor defaults apply)", async () => {
    const { execute } = spyBoundaries()
    await runApp({ ...base, trusted: false })
    expect(Object.keys(execute.mock.calls[0]?.[0] as object).sort()).toEqual(
      ["bridge", "bundleSource", "exportName", "params"].sort(),
    )
  })

  it("loads the bundle from bundlePath when no source is given", async () => {
    const { execute } = spyBoundaries()
    const load = spyOn(bundleLoader, "loadBundle").mockResolvedValue("loaded-source")
    const { bundleSource: _drop, ...noSource } = base
    await runApp({ ...noSource, trusted: false, bundlePath: "/x/kpi/1.0.0/bundle.js" })
    expect(load).toHaveBeenCalledWith("/x/kpi/1.0.0/bundle.js")
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ bundleSource: "loaded-source" })
  })

  it("refuses a call with neither bundle source nor path", async () => {
    spyBoundaries()
    const { bundleSource: _drop, ...noSource } = base
    await expect(runApp({ ...noSource, trusted: false })).rejects.toThrow(/bundlePath/)
  })
})

describe("resolveInstalledIdentity", () => {
  it("answers null without a database read for a bundle outside the install layout", async () => {
    // An in-tree app's bundle: its directory is not `<app>/<version>`.
    expect(
      await resolveInstalledIdentity(
        "kpi",
        base.orgId,
        "/repo/apps/api/src/apps/tickets/handlers.ts",
      ),
    ).toBeNull()
  })

  const APP = "run-app-identity-probe"
  afterAll(async () => {
    clearInstalledIdentityCache()
    await withSystemDb("run-app-test-cleanup", async (db) => {
      await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, APP))
      await db.delete(appsInstalled).where(eq(appsInstalled.name, APP))
    })
  })

  it("reads the version directory's record, cached per version directory", async () => {
    const row = (version: string, sha256: string) => ({
      name: APP,
      version,
      sourceUrl: "file:///probe",
      sha256,
      installedBy: "00000000-0000-0000-0000-000000000000",
    })
    await withSystemDb("run-app-test-seed", async (db) => {
      await db
        .insert(appsInstalled)
        .values([row("1.0.0", "a".repeat(64)), row("1.1.0", "b".repeat(64))])
      await db.insert(appsActiveVersion).values({ name: APP, version: "1.1.0" })
    })
    const at = (v: string) => `/srv/apps/${APP}/${v}/bundle.js`
    expect(await resolveInstalledIdentity(APP, base.orgId, at("1.0.0"))).toEqual({
      version: "1.0.0",
      sha256: "a".repeat(64),
    })
    // Without a bundle path: the active version.
    expect(await resolveInstalledIdentity(APP, base.orgId)).toEqual({
      version: "1.1.0",
      sha256: "b".repeat(64),
    })
    // A version directory never changes: the second answer comes from the cache.
    await withSystemDb("run-app-test-drop", (db) =>
      db.delete(appsInstalled).where(eq(appsInstalled.version, "1.0.0")),
    )
    expect((await resolveInstalledIdentity(APP, base.orgId, at("1.0.0")))?.version).toBe("1.0.0")
    expect(await resolveInstalledIdentity(APP, base.orgId, at("9.9.9"))).toBeNull()
  })
})
