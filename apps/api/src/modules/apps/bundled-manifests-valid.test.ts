// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every bundled app's manifest must pass the SAME validator the runtime uses at
// registration time.
//
// Without this, an invalid manifest is caught only by the running server, and
// the failure mode is quiet and bad: `registerApp` logs "Invalid app
// descriptor" at error level and returns, so the app is INSTALLED (the catalog
// row is written and `apps_active_version` advances) but never REGISTERED --
// no tools, no event subscriptions, and no job workers. Its BullMQ schedulers
// keep enqueueing on time and nothing consumes them, so the crons look
// scheduled and silently stop running.
//
// That is not hypothetical. invoicing 0.9.3 shipped a tool with
// `timeoutMs: 120000`, copied from the jobs block where 120000 is legal; tools
// cap at 60000. The deploy reported success, the version bumped, and every
// invoicing cron -- payment reconciliation, deferred retry, the overdue scan --
// stopped dead until someone read the boot log. The app's own manifest.test.ts
// checked its version and its tool list, but nothing checked it against the
// schema that decides whether it runs at all.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { runsForErrors } from "~/infra/jobs/fanout-runs-for"
import { appIconErrors, validateAppManifest } from "~/modules/apps/contract"

const BUNDLED_DIR = join(import.meta.dir, "..", "..", "..", "..", "..", "bundled-apps")

function bundledApps(): string[] {
  return readdirSync(BUNDLED_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => {
      try {
        readFileSync(join(BUNDLED_DIR, name, "app.manifest.json"))
        return true
      } catch {
        return false
      }
    })
    .sort()
}

/** Every non-test source file of a bundled app (handlers entrypoint + src/), skipping build output. */
function appSources(app: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && statSync(p).isFile())
        out.push(p)
    }
  }
  walk(join(BUNDLED_DIR, app))
  return out
}

/** The first argument of every `enqueueJob(` / `enqueueJob?.(` call in an app's sources. */
function enqueuedJobArgs(app: string): Array<{ file: string; arg: string }> {
  const out: Array<{ file: string; arg: string }> = []
  for (const file of appSources(app)) {
    const text = readFileSync(file, "utf8")
    for (const m of text.matchAll(/\benqueueJob\s*(?:\?\.)?\s*\(\s*([^,)]*)/g)) {
      out.push({ file: file.slice(BUNDLED_DIR.length + 1), arg: m[1]!.trim() })
    }
  }
  return out
}

describe("bundled app manifests", () => {
  const apps = bundledApps()

  it("finds the bundled apps at all", () => {
    // A path typo here would make every assertion below vacuous.
    expect(apps.length).toBeGreaterThan(3)
    expect(apps).toContain("invoicing")
  })

  for (const app of apps) {
    it(`${app}: validates against the runtime's own manifest schema`, () => {
      const manifest = JSON.parse(readFileSync(join(BUNDLED_DIR, app, "app.manifest.json"), "utf8"))
      const result = validateAppManifest(manifest)
      // Print the actual error: "invalid" alone sends you hunting through a
      // 2 600-line manifest.
      expect(result.error ?? null).toBeNull()
      expect(result.success).toBe(true)
    })
  }

  // A framed app (the desktop or phone shell, or a browser tab, when its UI cannot run in the
  // page) is drawn by the host from its manifest's icon data, never from its icon component
  // (isolated-app.tsx `isolatedAppIcon`). Without `iconName`/`iconSvg` it shows a tile with its
  // initial instead of the icon it has in the page.
  for (const app of apps) {
    it(`${app}: declares its icon as data (iconName or iconSvg), and a clean one`, () => {
      const manifest = JSON.parse(readFileSync(join(BUNDLED_DIR, app, "app.manifest.json"), "utf8"))
      expect(manifest.iconName !== undefined || manifest.iconSvg !== undefined).toBe(true)
      expect(appIconErrors(manifest)).toEqual([])
    })
  }

  // The kernel opens an entity's discussion only when the kind has a page: a `views.tabTypes`
  // entry named for the entity (entity-discussion.ts `isDiscussionEntity`). A kind that declares
  // `discussion: true` with no such page passes the schema, and every open of its discussion is
  // refused as `discussion_not_declared`, so the page shows "The discussion could not be opened"
  // for every record.
  for (const app of apps) {
    it(`${app}: every entity with a discussion has a page named for it`, () => {
      const manifest = JSON.parse(readFileSync(join(BUNDLED_DIR, app, "app.manifest.json"), "utf8"))
      const entities = (manifest.entities ?? {}) as Record<string, { discussion?: unknown }>
      const tabTypes = (manifest.views?.tabTypes ?? {}) as Record<string, unknown>
      const pageless = Object.entries(entities)
        .filter(([type, decl]) => decl?.discussion === true && !(type in tabTypes))
        .map(([type]) => type)
      expect(pageless).toEqual([])
    })
  }

  // The scope-taint gate reads a declared `writesToTable` FIRST: a tool that declares one is a
  // writer, whatever its `readOnly` says (read-only-run.ts `isReadOnlyTool`, scope-taint.ts
  // `checkToolScopeTaint`). A tool marked readOnly beside a write target is therefore gated as a
  // write in every conversation that holds outside content, and its readOnly mark does nothing
  // (boxtal 0.14.27: to_prepare_list and queue_counts landed as approvals).
  for (const app of apps) {
    it(`${app}: no readOnly tool also declares a write target`, () => {
      const manifest = JSON.parse(readFileSync(join(BUNDLED_DIR, app, "app.manifest.json"), "utf8"))
      const tools = (manifest.tools ?? {}) as Record<
        string,
        { readOnly?: boolean; writesToTable?: string }
      >
      const contradictory = Object.entries(tools)
        .filter(([, t]) => t?.readOnly === true && typeof t.writesToTable === "string")
        .map(([name, t]) => `${name} -> ${t.writesToTable}`)
      expect(contradictory).toEqual([])
    })
  }

  // The kernel registers a manifest job only when it has a `schedule` or `onDemand: true`
  // (runtime.ts), and `enqueueAppJob` throws "No handler registered" for anything else. A job
  // the app enqueues but the manifest never declares (social's `parse-webhook`, which made
  // every signed Meta delivery fail) passes the app's unit tests, which call the job function
  // directly. This pins the contract from the source: every enqueued name is a registered job.
  for (const app of apps) {
    it(`${app}: every job the app enqueues is a job the kernel registers`, () => {
      const manifest = JSON.parse(readFileSync(join(BUNDLED_DIR, app, "app.manifest.json"), "utf8"))
      const jobs = (manifest.jobs ?? {}) as Record<
        string,
        { schedule?: string; onDemand?: boolean }
      >
      const problems: string[] = []
      for (const { file, arg } of enqueuedJobArgs(app)) {
        // Calls whose name is not a literal (a variable, a template) cannot be checked here.
        // Inside a function signature or type (`enqueueJob: (jobName: string ...`) the
        // "argument" is a parameter declaration, not a call.
        if (/^[a-zA-Z_$][\w$]*\s*:/.test(arg)) continue
        const lit = arg.match(/^["'](.+)["']$/)
        if (!lit) {
          problems.push(
            `${file}: enqueueJob(${arg}) uses a non-literal job name; use a literal so it can be checked`,
          )
          continue
        }
        const def = jobs[lit[1]!]
        if (!def)
          problems.push(`${file}: enqueues "${lit[1]}", which the manifest does not declare`)
        else if (!def.schedule && def.onDemand !== true)
          problems.push(
            `${file}: "${lit[1]}" is declared without schedule or onDemand, so it is never registered`,
          )
      }
      expect(problems).toEqual([])
    })
  }

  it("the enqueue scan sees social's enqueue calls (the guard is not vacuous)", () => {
    const names = enqueuedJobArgs("social").map((c) => c.arg)
    expect(names).toContain('"parse-webhook"')
    expect(names).toContain('"discovery-sync"')
  })

  it("rejects a tool timeout above the tool cap -- the 0.9.3 regression", () => {
    // Pins the specific confusion: 120000 is fine under `jobs`, and copying it
    // into `tools` produces a manifest that installs and never registers.
    const manifest = JSON.parse(
      readFileSync(join(BUNDLED_DIR, "invoicing", "app.manifest.json"), "utf8"),
    )
    const firstTool = Object.keys(manifest.tools)[0]!
    manifest.tools[firstTool].timeoutMs = 120000
    const result = validateAppManifest(manifest)
    expect(result.success).toBe(false)
    expect(result.error).toContain("timeoutMs")
  })
})

// Every scheduled job of this repo's apps (bundled and first-party) says which
// orgs it is for. A cron with no `runsFor` fans out to every org, and each run
// holds a sandbox worker for its bundle load whether or not the org has
// anything for it: at a thousand orgs that is many times the pool. A job that
// really needs every org says so, with the reason.
describe("scheduled jobs declare runsFor", () => {
  const FIRST_PARTY_DIR = join(import.meta.dir, "..", "..", "apps")
  const manifests = [
    ...bundledApps().map((app) => join(BUNDLED_DIR, app, "app.manifest.json")),
    ...readdirSync(FIRST_PARTY_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(FIRST_PARTY_DIR, e.name, "app.manifest.json"))
      .filter((p) => {
        try {
          return statSync(p).isFile()
        } catch {
          return false
        }
      }),
  ]

  it("finds first-party manifests with scheduled jobs", () => {
    expect(manifests.some((p) => p.endsWith(join("tickets", "app.manifest.json")))).toBe(true)
  })

  for (const path of manifests) {
    const manifest = JSON.parse(readFileSync(path, "utf8"))
    it(`${manifest.name}: every scheduled job has a valid runsFor`, () => {
      expect(runsForErrors(manifest, { requireDeclared: true })).toEqual([])
    })
  }

  it("the guard rejects a scheduled job without runsFor, and a bad one", () => {
    const base = {
      name: "x",
      connections: { shop: {} },
      schema: { parked: { fields: { status: "string" } } },
    }
    expect(
      runsForErrors(
        { ...base, jobs: { a: { handler: "a", schedule: "* * * * *" } } },
        { requireDeclared: true },
      ),
    ).toHaveLength(1)
    const bad = {
      ...base,
      jobs: {
        a: { handler: "a", schedule: "* * * * *", runsFor: { connection: "nope" } },
        b: {
          handler: "b",
          schedule: "* * * * *",
          runsFor: { rows: { entity: "parked", where: { other: 1 } } },
        },
        c: { handler: "c", schedule: "* * * * *", runsFor: { everyOrg: "x" } },
        d: { handler: "d", onDemand: true, runsFor: { connection: "shop" } },
        e: {
          handler: "e",
          schedule: "* * * * *",
          runsFor: { rows: { entity: "parked", where: { status: { gt: 1 } } } },
        },
      },
    }
    const errors = runsForErrors(bad)
    for (const job of ["a", "b", "c", "d", "e"])
      expect(errors.some((e) => e.startsWith(`jobs.${job}.`))).toBe(true)
    const good = {
      ...base,
      jobs: {
        a: {
          handler: "a",
          schedule: "* * * * *",
          runsFor: { connection: ["shop", "other-app:conn"] },
        },
        b: {
          handler: "b",
          schedule: "* * * * *",
          runsFor: { rows: [{ entity: "parked", where: { status: { in: ["x"] } } }] },
        },
        c: {
          handler: "c",
          schedule: "* * * * *",
          runsFor: { everyOrg: "Every org has a daily digest to send." },
        },
      },
    }
    expect(runsForErrors(good, { requireDeclared: true })).toEqual([])
  })
})
