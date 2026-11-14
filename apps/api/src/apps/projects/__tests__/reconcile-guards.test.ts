// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Time spent is a person's own statement, so nothing the product ships asks for
// it, reads traces to work it out, or calls a reconcile tool on its own: a
// reconcile starts only from a person's turn. A guard over every manifest's
// routines, jobs and subscribers, the kernel's routine templates, and the files
// that name a reconcile tool.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Glob } from "bun"
import projectsManifest from "../app.manifest.json"

const REPO = path.resolve(import.meta.dir, "../../../../../..")
const API_SRC = path.join(REPO, "apps/api/src")

const reconcileTools = Object.keys(projectsManifest.tools).filter((t) => t.startsWith("reconcile_"))
const NAMES = new RegExp(`\\b(?:projects__)?(?:${reconcileTools.join("|")})\\b`)

function manifestFiles(): string[] {
  const out: string[] = []
  for (const pattern of [
    "apps/api/src/apps/*/app.manifest.json",
    "bundled-apps/*/app.manifest.json",
  ]) {
    for (const f of new Glob(pattern).scanSync({ cwd: REPO })) out.push(path.join(REPO, f))
  }
  return out
}

/** Every value under a key named like one of `keys`, at any depth. */
function collect(node: unknown, keys: ReadonlySet<string>, found: unknown[] = []): unknown[] {
  if (Array.isArray(node)) for (const v of node) collect(v, keys, found)
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (keys.has(k)) found.push(v)
      else collect(v, keys, found)
    }
  }
  return found
}

describe("nothing shipped calls a reconcile tool on its own", () => {
  it("the reconcile tools are known", () => {
    expect(reconcileTools).toContain("reconcile_facts")
    expect(reconcileTools).toContain("reconcile_propose")
  })

  it("no routine template, job or event subscriber of any app manifest names a reconcile tool", () => {
    const files = manifestFiles()
    expect(files.length).toBeGreaterThan(5)
    for (const file of files) {
      const manifest = JSON.parse(readFileSync(file, "utf8")) as unknown
      const text = JSON.stringify(collect(manifest, new Set(["routines", "jobs", "subscribes"])))
      expect(`${path.relative(REPO, file)}: ${NAMES.exec(text)?.[0] ?? ""}`).toBe(
        `${path.relative(REPO, file)}: `,
      )
    }
  })

  it("no kernel routine template names a reconcile tool", () => {
    const src = readFileSync(
      path.join(API_SRC, "modules/agent/routines/kernel-routine-templates.ts"),
      "utf8",
    )
    expect(NAMES.test(src)).toBe(false)
  })

  it("only the projects reconcile service and its seed name a reconcile tool outside tests", () => {
    const named: string[] = []
    for (const f of new Glob("**/*.ts").scanSync({ cwd: API_SRC })) {
      if (/\.(test|guard\.test|integration\.test)\.ts$/.test(f) || f.includes("tool-bench/"))
        continue
      if (NAMES.test(readFileSync(path.join(API_SRC, f), "utf8"))) named.push(f)
    }
    expect(named.sort()).toEqual([
      "apps/projects/service/reconcile.ts",
      "seed/factories/projects/reconcile.ts",
    ])
  })
})
