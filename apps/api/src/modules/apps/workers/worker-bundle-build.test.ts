// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildWorkerBundle } from "../../../../../../scripts/apps-build-worker-bundle"

const scratch = mkdtempSync(join(tmpdir(), "worker-bundle-build-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const appDir = join(scratch, "app")
mkdirSync(appDir)
writeFileSync(
  join(appDir, "app.manifest.json"),
  JSON.stringify({ name: "wbfixture", version: "1.2.3" }),
)
writeFileSync(
  join(appDir, "handlers.ts"),
  `export async function listItems(params: { n: number }, ctx: any) {
  const rows = await ctx.db.findMany("items", { limit: params.n })
  return { rows, count: rows.length }
}
`,
)

describe("apps:build-worker-bundle", () => {
  it("builds worker.js and worker-core.js with a stable sha and no node: import", async () => {
    const a = await buildWorkerBundle({ appDir, outRoot: join(scratch, "a") })
    const b = await buildWorkerBundle({ appDir, outRoot: join(scratch, "b") })
    expect(a.app).toBe("wbfixture")
    expect(a.version).toBe("1.2.3")
    expect(a.workerPath).toBe(join(scratch, "a", "wbfixture", "1.2.3", "worker.js"))
    expect(a.corePath).toBe(join(scratch, "a", "wbfixture", "1.2.3", "worker-core.js"))
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(b.sha256).toBe(a.sha256)
    expect(JSON.parse(a.bundlesEntry)).toEqual({ "wbfixture@1.2.3": a.sha256 })

    const worker = readFileSync(a.workerPath, "utf8")
    const core = readFileSync(a.corePath, "utf8")
    for (const text of [worker, core]) expect(text).not.toMatch(/["']node:/)
    expect(worker).toContain('from "cloudflare:workers"')
    expect(core).not.toContain("cloudflare:workers")
  })

  it("worker-core.js runs an export over a Bridge", async () => {
    const r = await buildWorkerBundle({ appDir, outRoot: join(scratch, "c") })
    const core = (await import(r.corePath)) as {
      run: (
        req: unknown,
        bridge: { call: (m: string, a: unknown[]) => Promise<unknown> },
      ) => Promise<unknown>
    }
    const calls: unknown[] = []
    const out = await core.run(
      {
        exportName: "listItems",
        params: { n: 1 },
        bridgeMethods: ["db_findMany"],
        runToken: "unused",
      },
      {
        call: async (m, a) => {
          calls.push([m, a])
          return { data: [{ id: "x" }] }
        },
      },
    )
    expect(out).toMatchObject({
      ok: true,
      result: { rows: [{ id: "x" }], count: 1 },
      timings: { bridgeCalls: 1 },
    })
    expect(calls).toEqual([["db_findMany", ["items", JSON.stringify({ limit: 1 })]]])
    const missing = await core.run(
      { exportName: "nope", params: {}, bridgeMethods: [] },
      { call: async () => ({}) },
    )
    expect(missing).toMatchObject({
      ok: false,
      error: { message: 'Export "nope" not found (got undefined)' },
    })
  })

  it("refuses an app directory without handlers.ts", async () => {
    await expect(
      buildWorkerBundle({ appDir: scratch, outRoot: join(scratch, "d") }),
    ).rejects.toThrow("No handlers.ts")
  })
})
