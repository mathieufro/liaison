// SPDX-License-Identifier: FSL-1.1-ALv2
//
// App versions, health and rollback (S5-S10): the server keeps the active and
// the previous version of an installed app, switches versions in the running
// process without a restart, health-gates every switch and goes back to the
// previous version when the new one fails, refuses a version that would lose
// data, honours `noRollback`, and keeps the app's state across a restart.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { desc, eq } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import {
  appActivationEvents,
  appsActiveVersion,
  appsInstalled,
} from "~/db/schema/kernel/apps-installed"
import { schemaRef } from "~/db/schema-ref"
import { isJobWorkerRegistered } from "~/infra/jobs/jobs"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import {
  ACTIVE_VERSIONS_CHANNEL,
  AppActivationError,
  activateAppVersion,
  activationGate,
  listAppVersionStates,
  orgAppProblems,
  redactReason,
  rollbackApp,
  syncActiveVersionsFromDb,
} from "~/modules/apps/activation"
import {
  eventSubscriptionDisposers,
  initializedOrgRuntimes,
  registeredAppVersions,
  resetAppRegistries,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { installCatalogApp, resetCatalogCache } from "~/modules/apps/catalog"
import { ensureAppsForOrg, getDefaultApps } from "~/modules/apps/init"
import { applyUpgrade, installAppFromTarball } from "~/modules/apps/install-service"
import { listOrgAppsForAdmin } from "~/modules/apps/org-app-admin"
import { registerApps } from "~/modules/apps/runtime"
import { signAccessToken } from "~/modules/auth/jwt"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"

const TEST_ORG = "00000000-0000-0000-0000-0000000a7e01"
const TEST_USER = "00000000-0000-0000-0000-0000000a7e02"
const ADMIN = "00000000-0000-0000-0000-000000000001"
const APP = "versions-fixture"
const SCOPES = [`${APP}:items:read`]

let installRoot: string

interface Version {
  tools?: Record<string, string>
  jobs?: string[]
  schema?: Record<string, unknown>
  extra?: Record<string, unknown>
  /** Extra bundle functions (event handlers). */
  handlers?: string[]
  /** The handler bundle's text, verbatim. */
  bundle?: string
}

/** A `.liaisonapp` whose tools and jobs are plain bundle functions. */
function tarball(version: string, v: Version = {}): string {
  const work = mkdtempSync(join(tmpdir(), "versions-pkg-"))
  const stage = join(work, "stage")
  mkdirSync(stage)
  const tools = v.tools ?? { list_items: "List items" }
  const manifest: Record<string, unknown> = {
    name: APP,
    version,
    packageFormat: 1,
    license: "MIT",
    scopes: SCOPES,
    tools: Object.fromEntries(
      Object.entries(tools).map(([name, description]) => [
        name,
        { description, requiredScopes: SCOPES, readOnly: true, handler: name },
      ]),
    ),
    ...(v.jobs
      ? { jobs: Object.fromEntries(v.jobs.map((j) => [j, { handler: j, onDemand: true }])) }
      : {}),
    ...(v.schema ? { schema: v.schema } : {}),
    ...v.extra,
  }
  writeFileSync(join(stage, "app.manifest.json"), JSON.stringify(manifest))
  const fns = [...Object.keys(tools), ...(v.jobs ?? []), ...(v.handlers ?? [])]
  writeFileSync(
    join(stage, "bundle.js"),
    v.bundle ?? fns.map((f) => `function ${f}() { return { version: "${version}" } }`).join("\n"),
  )
  const tar = join(work, `${APP}-${version}.liaisonapp`)
  spawnSync("tar", ["-czf", tar, "-C", stage, "app.manifest.json", "bundle.js"])
  return tar
}

async function install(version: string, v: Version = {}) {
  return installAppFromTarball({
    tarballPath: tarball(version, v),
    installedBy: ADMIN,
    grantedScopes: SCOPES,
    requireSignature: false,
  })
}

async function upgrade(version: string, v: Version = {}) {
  return applyUpgrade({
    name: APP,
    tarballPath: tarball(version, v),
    installedBy: ADMIN,
    grantedScopes: SCOPES,
    requireSignature: false,
  })
}

async function pointer() {
  const [row] = await withSystemDb("t", (db) =>
    db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, APP)),
  )
  return row ? { version: row.version, previous: row.previousVersion } : null
}

async function rowVersions(): Promise<string[]> {
  const rows = await withSystemDb("t", (db) =>
    db.select().from(appsInstalled).where(eq(appsInstalled.name, APP)),
  )
  return rows.map((r) => r.version).sort()
}

function dirVersions(): string[] {
  const dir = join(installRoot, APP)
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

async function events() {
  return withSystemDb("t", (db) =>
    db
      .select()
      .from(appActivationEvents)
      .where(eq(appActivationEvents.app, APP))
      .orderBy(desc(appActivationEvents.at)),
  )
}

const tool = (name: string) => toolRegistry.get([TEST_ORG, APP, name])

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${TEST_ORG}, 'Versions Org', 'versions-org') ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
    VALUES (${TEST_USER}, ${TEST_ORG}, 'versions@test.com', 'hash', 'V', 'active')
    ON CONFLICT (id) DO NOTHING`
  // The org is initialized in this process: every switch below must reach it live.
  await ensureAppsForOrg(TEST_ORG)
}, 120_000)

beforeEach(() => {
  installRoot = mkdtempSync(join(tmpdir(), "versions-root-"))
  process.env.LIAISON_APPS_DIR = installRoot
})

afterEach(async () => {
  const { unregisterAppEverywhere } = await import("~/modules/apps/runtime")
  await unregisterAppEverywhere(APP)
  rmSync(installRoot, { recursive: true, force: true })
  delete process.env.LIAISON_APPS_DIR
  await withSystemDb("t", async (db) => {
    await db.delete(appsInstalled).where(eq(appsInstalled.name, APP))
    await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, APP))
    await db.delete(appActivationEvents).where(eq(appActivationEvents.app, APP))
  })
  await sql`DELETE FROM kernel.apps WHERE org_id = ${TEST_ORG} AND name = ${APP}`
  // Each test starts from no app tables: a table left by an earlier test would
  // make CREATE TABLE IF NOT EXISTS skip the declaration under test.
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${schemaRef("app_versions_fixture")} CASCADE`)
})

afterAll(async () => {
  resetAppRegistries()
  await sql`DELETE FROM kernel.audit_log WHERE org_id = ${TEST_ORG}`
  await sql`DELETE FROM kernel.apps WHERE org_id = ${TEST_ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${TEST_ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
})

describe("two versions on disk (S5)", () => {
  it("an upgrade keeps the previous version's files and row and prunes older ones", async () => {
    await install("1.0.0")
    await upgrade("2.0.0")
    await upgrade("3.0.0")
    expect(dirVersions()).toEqual(["2.0.0", "3.0.0"])
    expect(await rowVersions()).toEqual(["2.0.0", "3.0.0"])
    expect(await pointer()).toEqual({ version: "3.0.0", previous: "2.0.0" })
  }, 60_000)

  it("an install over the active version keeps the same two", async () => {
    await install("1.0.0")
    await install("2.0.0")
    await install("3.0.0")
    expect(dirVersions()).toEqual(["2.0.0", "3.0.0"])
    expect(await rowVersions()).toEqual(["2.0.0", "3.0.0"])
    expect(await pointer()).toEqual({ version: "3.0.0", previous: "2.0.0" })
  }, 60_000)

  it("discovery registers only the active version", async () => {
    await install("1.0.0")
    await upgrade("2.0.0")
    const mine = (await getDefaultApps()).filter((d) => d.name === APP)
    expect(mine.map((d) => d.version)).toEqual(["2.0.0"])
  }, 60_000)
})

describe("switch without restart (S6)", () => {
  it("the new version's tools replace the old one's in the running process", async () => {
    await install("1.0.0", { tools: { list_items: "v1 list", old_only: "v1 only" } })
    expect(tool("list_items")?.description).toBe("v1 list")
    expect(tool("old_only")).toBeDefined()

    await upgrade("2.0.0", { tools: { list_items: "v2 list", new_only: "v2 only" } })
    expect(tool("list_items")?.description).toBe("v2 list")
    expect(tool("new_only")).toBeDefined()
    expect(tool("old_only")).toBeUndefined()
    expect(registeredAppVersions.get(`${TEST_ORG}:${APP}`)).toBe("2.0.0")
    expect((await events())[0]).toMatchObject({
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      outcome: "activated",
      actorKind: "operator",
      actorId: ADMIN,
    })
  }, 60_000)

  it("a job only the old version had is no longer callable after the switch", async () => {
    await install("1.0.0", { jobs: ["sweep_v1", "sweep_both"] })
    expect(isJobWorkerRegistered(APP, "sweep_v1")).toBe(true)
    await upgrade("2.0.0", { jobs: ["sweep_both"] })
    expect(isJobWorkerRegistered(APP, "sweep_v1")).toBe(false)
    expect(isJobWorkerRegistered(APP, "sweep_both")).toBe(true)
  }, 60_000)

  it("follows a version another server process activated", async () => {
    await install("1.0.0", { tools: { list_items: "v1 list" } })
    await upgrade("2.0.0", { tools: { list_items: "v2 list" } })
    // Another process rolled the app back: only the database says so.
    await withSystemDb("t", (db) =>
      db
        .update(appsActiveVersion)
        .set({ version: "1.0.0", previousVersion: "2.0.0" })
        .where(eq(appsActiveVersion.name, APP)),
    )
    await syncActiveVersionsFromDb()
    expect(registeredAppVersions.get(`${TEST_ORG}:${APP}`)).toBe("1.0.0")
    expect(tool("list_items")?.description).toBe("v1 list")
  }, 60_000)
})

describe("health gate and switch-back (S7)", () => {
  it("a version whose registration throws is switched back, with the reason recorded", async () => {
    await install("1.0.0", { tools: { list_items: "v1 list" } })
    const failing = upgrade("2.0.0", {
      tools: { list_items: "v2 list" },
      // A reference to a table nobody declares: the DDL fails at registration.
      schema: {
        notes: {
          rlsScope: "items",
          fields: {
            body: "string",
            owner_id: { type: "uuid", references: { table: "no_such_table", column: "id" } },
          },
        },
      },
    })
    await expect(failing).rejects.toBeInstanceOf(AppActivationError)
    await expect(failing).rejects.toThrow("still running 1.0.0")

    expect(await pointer()).toEqual({ version: "1.0.0", previous: null })
    expect(registeredAppVersions.get(`${TEST_ORG}:${APP}`)).toBe("1.0.0")
    expect(tool("list_items")?.description).toBe("v1 list")
    // The failed version is not kept.
    expect(dirVersions()).toEqual(["1.0.0"])
    const [event] = await events()
    expect(event).toMatchObject({
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      outcome: "switched_back",
      reasonCode: "registration_failed",
    })
    expect(event?.reasonMessage?.length).toBeGreaterThan(0)
    expect(event?.reasonMessage?.length).toBeLessThanOrEqual(500)
    // The App store reads it as "Upgrade failed, still running 1.0.0".
    const [state] = await listAppVersionStates([APP])
    expect(state).toMatchObject({
      version: "1.0.0",
      upgradeFailed: { version: "2.0.0", reasonCode: "registration_failed" },
    })
  }, 60_000)

  it("a first install that fails its gate is not activated", async () => {
    const failing = install("1.0.0", {
      schema: {
        notes: {
          rlsScope: "items",
          fields: {
            owner_id: { type: "uuid", references: { table: "no_such_table", column: "id" } },
          },
        },
      },
    })
    await expect(failing).rejects.toBeInstanceOf(AppActivationError)
    expect(await pointer()).toBeNull()
    expect(dirVersions()).toEqual([])
    expect((await events())[0]).toMatchObject({ outcome: "refused", toVersion: "1.0.0" })
  }, 60_000)
})

describe("rollback (S9) and noRollback (A10)", () => {
  it("rolls back to the previous version through the same gate", async () => {
    await install("1.0.0", { tools: { list_items: "v1 list" } })
    await upgrade("2.0.0", { tools: { list_items: "v2 list" } })
    await rollbackApp(APP, { id: ADMIN, kind: "operator" })
    expect(await pointer()).toEqual({ version: "1.0.0", previous: "2.0.0" })
    expect(tool("list_items")?.description).toBe("v1 list")
    expect((await events())[0]).toMatchObject({
      fromVersion: "2.0.0",
      toVersion: "1.0.0",
      outcome: "activated",
    })
  }, 60_000)

  it("POST /api/apps/:name/rollback makes the previous version active through the gate, as the caller", async () => {
    await install("1.0.0", { tools: { list_items: "v1 list" } })
    await upgrade("2.0.0", { tools: { list_items: "v2 list" } })
    // The gate's seams: every org's switch to the version being activated runs here.
    const judged: string[] = []
    activationGate.beforeOrgSwitch = async (orgId, version) => {
      judged.push(`before ${orgId} ${version}`)
    }
    activationGate.afterOrgSwitch = async (orgId, version) => {
      judged.push(`after ${orgId} ${version}`)
    }
    // A single-org self-host: any app admin manages the instance's apps.
    _setEdition("self_hosted")
    DemoModeTestAccess.set(false)
    let res: Response
    try {
      const token = await signAccessToken(
        {
          userId: TEST_USER,
          orgId: TEST_ORG,
          name: "V",
          authVersion: 1,
          permissionVersion: 1,
          scopes: ["*"],
          dimensionGrants: { "*": ["*"] },
        },
        env.JWT_SECRET,
      )
      res = await app.request(`/api/apps/${APP}/rollback`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      })
    } finally {
      activationGate.beforeOrgSwitch = undefined
      activationGate.afterOrgSwitch = undefined
      _setEdition(null)
      DemoModeTestAccess.set(null)
    }
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      name: APP,
      version: "1.0.0",
      previousVersion: "2.0.0",
    })
    // The previous version is the active one, in the database and in this process.
    expect(await pointer()).toEqual({ version: "1.0.0", previous: "2.0.0" })
    expect(registeredAppVersions.get(`${TEST_ORG}:${APP}`)).toBe("1.0.0")
    expect(tool("list_items")?.description).toBe("v1 list")
    // The health gate judged the switch in the org where the app runs.
    expect(judged).toContain(`before ${TEST_ORG} 1.0.0`)
    expect(judged).toContain(`after ${TEST_ORG} 1.0.0`)
    // The activation is recorded with the caller as the operator who rolled back.
    expect((await events())[0]).toMatchObject({
      fromVersion: "2.0.0",
      toVersion: "1.0.0",
      outcome: "activated",
      reasonCode: null,
      actorId: TEST_USER,
      actorKind: "operator",
    })
    const audit = await sql`SELECT actor_id, metadata FROM kernel.audit_log
      WHERE org_id = ${TEST_ORG} AND action = 'app.rolled_back'`
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      actor_id: TEST_USER,
      metadata: { version: "1.0.0", from: "2.0.0" },
    })
  }, 60_000)

  it("refuses to go below a first-party security release", async () => {
    const catalogDir = mkdtempSync(join(tmpdir(), "versions-catalog-"))
    process.env.LIAISON_APP_CATALOG_DIR = catalogDir
    try {
      bakeCatalog(catalogDir, "1.0.0")
      await installCatalogApp({ orgId: TEST_ORG, name: APP, installedBy: ADMIN })
      bakeCatalog(catalogDir, "2.0.0", { extra: { noRollback: true } })
      await installCatalogApp({ orgId: TEST_ORG, name: APP, installedBy: ADMIN })
      await expectNoRollbackRefusal()
    } finally {
      delete process.env.LIAISON_APP_CATALOG_DIR
      resetCatalogCache()
      rmSync(catalogDir, { recursive: true, force: true })
    }
  }, 60_000)

  async function expectNoRollbackRefusal(): Promise<void> {
    const refused = rollbackApp(APP, { id: ADMIN, kind: "operator" })
    await expect(refused).rejects.toThrow("security release")
    await expect(refused).rejects.toMatchObject({ code: "no_rollback" })
    expect(await pointer()).toEqual({ version: "2.0.0", previous: "1.0.0" })
    expect((await events())[0]).toMatchObject({ outcome: "refused", reasonCode: "no_rollback" })
  }

  it("P2-fix8: an outside package cannot declare itself a security release", async () => {
    await install("1.0.0")
    await upgrade("2.0.0", { extra: { noRollback: true } })
    await rollbackApp(APP, { id: ADMIN, kind: "operator" })
    expect(await pointer()).toEqual({ version: "1.0.0", previous: "2.0.0" })
  }, 60_000)

  it("P2-fix8: a failing first-party security release is switched back and recorded", async () => {
    const catalogDir = mkdtempSync(join(tmpdir(), "versions-catalog-"))
    process.env.LIAISON_APP_CATALOG_DIR = catalogDir
    try {
      bakeCatalog(catalogDir, "1.0.0", { tools: { list_items: "v1 list" } })
      await installCatalogApp({ orgId: TEST_ORG, name: APP, installedBy: ADMIN })
      bakeCatalog(catalogDir, "2.0.0", { schema: BROKEN_SCHEMA, extra: { noRollback: true } })
      await expect(
        installCatalogApp({ orgId: TEST_ORG, name: APP, installedBy: ADMIN }),
      ).rejects.toBeInstanceOf(AppActivationError)
    } finally {
      delete process.env.LIAISON_APP_CATALOG_DIR
      resetCatalogCache()
      rmSync(catalogDir, { recursive: true, force: true })
    }
    expect((await pointer())?.version).toBe("1.0.0")
    expect(registeredAppVersions.get(`${TEST_ORG}:${APP}`)).toBe("1.0.0")
    expect((await events())[0]).toMatchObject({
      toVersion: "2.0.0",
      outcome: "switched_back",
      reasonCode: "registration_failed",
    })
  }, 60_000)

  it("refuses rollback when there is no previous version", async () => {
    await install("1.0.0")
    await expect(rollbackApp(APP, { id: ADMIN, kind: "operator" })).rejects.toThrow(
      "no previous version",
    )
  }, 60_000)
})

describe("additive data rule (S10)", () => {
  const v1Schema = {
    notes: {
      rlsScope: "items",
      fields: {
        body: "string",
        status: { type: "string", enum: ["open", "closed"] },
        label: "string?",
      },
    },
  }

  it("refuses a version that drops a column, naming what would be lost", async () => {
    await install("1.0.0", { schema: v1Schema })
    const refused = upgrade("2.0.0", {
      schema: {
        notes: {
          rlsScope: "items",
          fields: { status: v1Schema.notes.fields.status, label: "string?" },
        },
      },
    })
    await expect(refused).rejects.toThrow("column notes.body is dropped")
    expect(await pointer()).toEqual({ version: "1.0.0", previous: null })
    expect(dirVersions()).toEqual(["1.0.0"])
  }, 60_000)

  it("accepts a version that only adds a column and an enum value", async () => {
    await install("1.0.0", { schema: v1Schema })
    await upgrade("2.0.0", {
      schema: {
        notes: {
          rlsScope: "items",
          fields: {
            ...v1Schema.notes.fields,
            status: { type: "string", enum: ["open", "closed", "archived"] },
            priority: "integer?",
          },
        },
      },
    })
    expect((await pointer())?.version).toBe("2.0.0")
  }, 60_000)
})

describe("app state survives a restart (S8)", () => {
  it("a failed registration's reason is persisted with the app's state, and cleared by a good one", async () => {
    await registerApps(
      [{ _format: "manifest", name: APP, version: "9.0.0", notAManifestKey: true } as never],
      TEST_ORG,
    )
    // Read from the database, not process memory: what a restarted server sees.
    const [row] = await sql`
      SELECT status, problem_code, problem_message FROM kernel.apps
      WHERE org_id = ${TEST_ORG} AND name = ${APP}`
    expect(row).toMatchObject({ status: "error", problem_code: "manifest_invalid" })
    expect(String(row?.problem_message)).toContain("notAManifestKey")
    expect((await orgAppProblems(TEST_ORG)).get(APP)?.code).toBe("manifest_invalid")

    await install("1.0.0")
    const [after] = await sql`
      SELECT status, problem_code FROM kernel.apps WHERE org_id = ${TEST_ORG} AND name = ${APP}`
    expect(after).toMatchObject({ status: "active", problem_code: null })
  }, 60_000)
})

describe("redactReason (A14)", () => {
  it("drops paths, URLs, emails and tokens, and caps the length", () => {
    const out = redactReason(
      `ENOENT: /srv/liaison/apps/x/2.0.0/bundle.js at postgres://u:pw@db:5432/x by a@b.example token ${"a".repeat(40)}`,
    )
    expect(out).not.toContain("/srv/")
    expect(out).not.toContain("postgres://")
    expect(out).not.toContain("a@b.example")
    expect(out).not.toContain("a".repeat(40))
    expect(out).toContain("ENOENT")
    expect(redactReason("x ".repeat(600)).length).toBeLessThanOrEqual(500)
  })
})

/** A broken schema: the DDL fails at registration (a reference to no table). */
const BROKEN_SCHEMA = {
  notes: {
    rlsScope: "items",
    fields: { owner_id: { type: "uuid", references: { table: "no_such_table", column: "id" } } },
  },
}

/** Bake `version` as the image's catalog entry for the fixture app. */
function bakeCatalog(catalogDir: string, version: string, v: Version = {}): void {
  const file = `${APP}-${version}.liaisonapp`
  copyFileSync(tarball(version, v), join(catalogDir, file))
  writeFileSync(
    join(catalogDir, "catalog.json"),
    JSON.stringify([{ name: APP, version, file, scopes: SCOPES, connections: [] }]),
  )
  resetCatalogCache()
}

describe("P2-fix1: a catalog upgrade in a process with no initialized org", () => {
  it("probes an org where the app is on, and switches back a version whose registration throws", async () => {
    const catalogDir = mkdtempSync(join(tmpdir(), "versions-catalog-"))
    process.env.LIAISON_APP_CATALOG_DIR = catalogDir
    const system = { id: null, kind: "system" as const }
    try {
      bakeCatalog(catalogDir, "1.0.0", { tools: { list_items: "v1 list" } })
      await installCatalogApp({ orgId: TEST_ORG, name: APP, installedBy: ADMIN, actor: system })
      // The boot reconcile runs before the server registers any org.
      const initialized = [...initializedOrgRuntimes]
      initializedOrgRuntimes.clear()
      try {
        bakeCatalog(catalogDir, "2.0.0", { schema: BROKEN_SCHEMA })
        await expect(
          installCatalogApp({
            orgId: TEST_ORG,
            name: APP,
            installedBy: ADMIN,
            register: false,
            actor: system,
          }),
        ).rejects.toBeInstanceOf(AppActivationError)
      } finally {
        for (const o of initialized) initializedOrgRuntimes.add(o)
      }
      expect((await pointer())?.version).toBe("1.0.0")
      expect((await events())[0]).toMatchObject({
        toVersion: "2.0.0",
        outcome: "switched_back",
        reasonCode: "registration_failed",
      })
    } finally {
      delete process.env.LIAISON_APP_CATALOG_DIR
      resetCatalogCache()
      rmSync(catalogDir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("P2-fix2: a gate that times out stops switching orgs", () => {
  it("a registration still running past the timeout never lands after the switch-back", async () => {
    await install("1.0.0", { tools: { list_items: "v1 list" }, jobs: ["sweep_v1"] })
    const timeoutMs = activationGate.timeoutMs
    activationGate.timeoutMs = 300
    activationGate.beforeOrgSwitch = async (_org, version) => {
      if (version === "2.0.0") await Bun.sleep(1500)
    }
    try {
      const slow = upgrade("2.0.0", { tools: { list_items: "v2 list" }, jobs: ["sweep_v2"] })
      await expect(slow).rejects.toMatchObject({ code: "timeout" })
      // Long enough for the slow registration to have finished, had it gone on.
      await Bun.sleep(2000)
    } finally {
      activationGate.timeoutMs = timeoutMs
      activationGate.beforeOrgSwitch = undefined
    }
    expect((await pointer())?.version).toBe("1.0.0")
    expect(registeredAppVersions.get(`${TEST_ORG}:${APP}`)).toBe("1.0.0")
    expect(tool("list_items")?.description).toBe("v1 list")
    expect(isJobWorkerRegistered(APP, "sweep_v1")).toBe(true)
    expect(isJobWorkerRegistered(APP, "sweep_v2")).toBe(false)
  }, 60_000)
})

describe("P2-fix3: activations of one app run one at a time", () => {
  it("two concurrent activations end with the registered version equal to the pointer", async () => {
    await install("1.0.0", { tools: { list_items: "v1 list" } })
    await upgrade("2.0.0", { tools: { list_items: "v2 list" } })
    activationGate.beforeOrgSwitch = async (_org, version) => {
      if (version === "1.0.0") await Bun.sleep(500)
    }
    try {
      const back = rollbackApp(APP, { id: ADMIN, kind: "operator" })
      await Bun.sleep(50)
      const forward = activateAppVersion(APP, "2.0.0", { id: ADMIN, kind: "operator" })
      await Promise.allSettled([back, forward])
    } finally {
      activationGate.beforeOrgSwitch = undefined
    }
    const p = await pointer()
    expect(p?.version).toBe("2.0.0")
    expect(registeredAppVersions.get(`${TEST_ORG}:${APP}`)).toBe(p?.version)
    expect(tool("list_items")?.description).toBe("v2 list")
    // Serialized: the rollback finished before the second activation read the pointer.
    const outcomes = (await events()).slice(0, 2).map((e) => `${e.fromVersion}->${e.toVersion}`)
    expect(outcomes).toEqual(["1.0.0->2.0.0", "2.0.0->1.0.0"])
  }, 60_000)
})

describe("P2-fix4: a failed switch keeps the running version registered", () => {
  it("while the new version fails to register, the old version's tools stay in place", async () => {
    await install("1.0.0", {
      tools: { list_items: "v1 list", old_only: "v1 only" },
      handlers: ["onContact"],
      extra: { events: { subscribes: { "kernel:contact:create": "onContact" } } },
    })
    const subscriptions = eventSubscriptionDisposers.get([TEST_ORG, APP])
    expect(subscriptions?.length).toBeGreaterThan(0)
    const seen: Array<unknown> = []
    activationGate.afterOrgSwitch = async (org, version) => {
      if (version === "2.0.0" && org === TEST_ORG) {
        seen.push(
          tool("list_items")?.description,
          tool("old_only")?.description,
          registeredAppVersions.get(`${TEST_ORG}:${APP}`),
          eventSubscriptionDisposers.get([TEST_ORG, APP]) === subscriptions,
        )
      }
    }
    try {
      await expect(
        upgrade("2.0.0", { tools: { list_items: "v2 list" }, schema: BROKEN_SCHEMA }),
      ).rejects.toBeInstanceOf(AppActivationError)
    } finally {
      activationGate.afterOrgSwitch = undefined
    }
    // Right after the failed registration, before any switch-back: no gap.
    expect(seen).toEqual(["v1 list", "v1 only", "1.0.0", true])
    expect(registeredAppVersions.get(`${TEST_ORG}:${APP}`)).toBe("1.0.0")
  }, 60_000)
})

describe("P2-fix5: the pointer moves only after the gate passed", () => {
  it("while the new version is judged, the database and other registrations still name the old one", async () => {
    await install("1.0.0", { tools: { list_items: "v1 list" } })
    const during: unknown[] = []
    activationGate.beforeOrgSwitch = async (_org, version) => {
      if (version !== "2.0.0") return
      during.push((await pointer())?.version)
      const discovered = (await getDefaultApps()).find((d) => d.name === APP)
      during.push(discovered?.version)
    }
    try {
      await upgrade("2.0.0", { tools: { list_items: "v2 list" } })
    } finally {
      activationGate.beforeOrgSwitch = undefined
    }
    expect(during).toEqual(["1.0.0", "1.0.0"])
    expect(await pointer()).toEqual({ version: "2.0.0", previous: "1.0.0" })
    expect(tool("list_items")?.description).toBe("v2 list")
  }, 60_000)
})

describe("P2-fix6: reasons are redacted and stay within the org (A14)", () => {
  const PG_DETAIL =
    'duplicate key value violates unique constraint "uniq_app_shop_orders_ref" DETAIL: Key (org_id, ref)=(7d1c, ACME-INVOICE-77) already exists. relation "app_shop.orders"'

  it("redactReason drops Postgres key values, constraint and relation names", () => {
    const out = redactReason(PG_DETAIL)
    expect(out).not.toContain("ACME-INVOICE-77")
    expect(out).not.toContain("uniq_app_shop_orders_ref")
    expect(out).not.toContain("app_shop.orders")
    expect(out).toContain("duplicate key value violates unique constraint")
  })

  it("the problem persisted for an org is redacted", async () => {
    await install("1.0.0")
    let persisted: string | null | undefined
    activationGate.afterOrgSwitch = async (org, version) => {
      if (version !== "2.0.0" || org !== TEST_ORG) return
      const [row] = await sql`
        SELECT problem_message FROM kernel.apps WHERE org_id = ${TEST_ORG} AND name = ${APP}`
      persisted = row?.problem_message
    }
    try {
      await expect(upgrade("2.0.0", { schema: BROKEN_SCHEMA })).rejects.toBeInstanceOf(
        AppActivationError,
      )
    } finally {
      activationGate.afterOrgSwitch = undefined
    }
    expect(persisted).toBeTruthy()
    expect(persisted).not.toContain("no_such_table")
  }, 60_000)

  it("an org admin outside the operator org sees the reason code and a fixed sentence only", async () => {
    await install("1.0.0")
    await expect(upgrade("2.0.0", { schema: BROKEN_SCHEMA })).rejects.toBeInstanceOf(
      AppActivationError,
    )
    const e = env as { LIAISON_OPERATOR_ORG_ID?: string }
    const saved = e.LIAISON_OPERATOR_ORG_ID
    try {
      e.LIAISON_OPERATOR_ORG_ID = "00000000-0000-0000-0000-0000000a7eff"
      const row = (await listOrgAppsForAdmin(TEST_ORG)).find((r) => r.name === APP)
      expect(row?.upgradeFailed).toEqual({
        version: "2.0.0",
        reasonCode: "registration_failed",
        reasonMessage: "Version 2.0.0 did not pass its health check; this server still runs 1.0.0.",
      })
      e.LIAISON_OPERATOR_ORG_ID = TEST_ORG
      const operatorRow = (await listOrgAppsForAdmin(TEST_ORG)).find((r) => r.name === APP)
      expect(operatorRow?.upgradeFailed?.reasonMessage).toContain("does not exist")
    } finally {
      e.LIAISON_OPERATOR_ORG_ID = saved
    }
  }, 60_000)
})

describe("P2-fix7: the additive rule runs on every different package and fails closed", () => {
  const schema = { notes: { rlsScope: "items", fields: { body: "string", label: "string?" } } }
  const dropped = { notes: { rlsScope: "items", fields: { label: "string?" } } }

  it("a same-version package with different bytes is held to the rule", async () => {
    await install("1.0.0", { schema })
    await expect(install("1.0.0", { schema: dropped })).rejects.toThrow(
      "column notes.body is dropped",
    )
  }, 60_000)

  it("a deliberate downgrade is held to the rule too", async () => {
    await install("1.0.0", { schema })
    await expect(
      installAppFromTarball({
        tarballPath: tarball("0.9.0", { schema: dropped }),
        installedBy: ADMIN,
        grantedScopes: SCOPES,
        requireSignature: false,
        allowDowngrade: true,
      }),
    ).rejects.toThrow("column notes.body is dropped")
  }, 60_000)

  it("C7: a catalog version whose running files are gone is checked against the schema recorded at install", async () => {
    const catalogDir = mkdtempSync(join(tmpdir(), "versions-catalog-"))
    process.env.LIAISON_APP_CATALOG_DIR = catalogDir
    try {
      bakeCatalog(catalogDir, "1.0.0", { schema })
      await installCatalogApp({ orgId: TEST_ORG, name: APP, installedBy: ADMIN })
      // A container whose install root was not kept: the rows stay, the files go.
      rmSync(join(installRoot, APP), { recursive: true, force: true })
      bakeCatalog(catalogDir, "2.0.0", { schema: dropped })
      await expect(
        installCatalogApp({ orgId: TEST_ORG, name: APP, installedBy: ADMIN }),
      ).rejects.toThrow("column notes.body is dropped")
      expect((await pointer())?.version).toBe("1.0.0")
    } finally {
      delete process.env.LIAISON_APP_CATALOG_DIR
      resetCatalogCache()
      rmSync(catalogDir, { recursive: true, force: true })
    }
  }, 60_000)

  it("C7: a row installed before the schema was recorded still repairs from the catalog", async () => {
    const catalogDir = mkdtempSync(join(tmpdir(), "versions-catalog-"))
    process.env.LIAISON_APP_CATALOG_DIR = catalogDir
    try {
      bakeCatalog(catalogDir, "1.0.0", { schema })
      await installCatalogApp({ orgId: TEST_ORG, name: APP, installedBy: ADMIN })
      await sql`UPDATE kernel.apps_installed SET manifest_schema = NULL WHERE name = ${APP}`
      rmSync(join(installRoot, APP), { recursive: true, force: true })
      bakeCatalog(catalogDir, "2.0.0", { schema })
      await installCatalogApp({ orgId: TEST_ORG, name: APP, installedBy: ADMIN })
      expect((await pointer())?.version).toBe("2.0.0")
      const [row] = await sql<{ manifest_schema: unknown }[]>`
        SELECT manifest_schema FROM kernel.apps_installed WHERE name = ${APP} AND version = '2.0.0'`
      expect(row?.manifest_schema).toEqual({ schema })
    } finally {
      delete process.env.LIAISON_APP_CATALOG_DIR
      resetCatalogCache()
      rmSync(catalogDir, { recursive: true, force: true })
    }
  }, 60_000)

  it("an unreadable running manifest is checked against the schema recorded at install", async () => {
    await install("1.0.0", { schema })
    rmSync(join(installRoot, APP, "1.0.0", "app.manifest.json"))
    await expect(upgrade("2.0.0", { schema: dropped })).rejects.toThrow(
      "column notes.body is dropped",
    )
  }, 60_000)

  it("an unreadable running manifest with no recorded schema refuses the upgrade", async () => {
    await install("1.0.0", { schema })
    await sql`UPDATE kernel.apps_installed SET manifest_schema = NULL WHERE name = ${APP}`
    rmSync(join(installRoot, APP, "1.0.0", "app.manifest.json"))
    await expect(upgrade("2.0.0", { schema: dropped })).rejects.toThrow(
      "the running version's manifest cannot be read",
    )
  }, 60_000)
})

describe("P2-fix9: only orgs where the app runs judge a switch (A10)", () => {
  it("a failure in an org where the app already failed to load is that org's state, not a switch-back", async () => {
    await install("1.0.0")
    await sql`UPDATE kernel.apps SET status = 'error' WHERE org_id = ${TEST_ORG} AND name = ${APP}`
    await upgrade("2.0.0", { schema: BROKEN_SCHEMA })
    expect((await pointer())?.version).toBe("2.0.0")
    expect((await events())[0]).toMatchObject({ toVersion: "2.0.0", outcome: "activated" })
  }, 60_000)
})

describe("an org deleted after it was initialized", () => {
  it("does not fail the gate, and its runtime is forgotten", async () => {
    // An org this process initialized whose row is gone since (an expired demo
    // workspace collected here or by another process).
    const gone = crypto.randomUUID()
    initializedOrgRuntimes.add(gone)
    try {
      await install("1.0.0", { tools: { list_items: "v1 list" } })
      expect((await pointer())?.version).toBe("1.0.0")
      expect((await events())[0]).toMatchObject({ toVersion: "1.0.0", outcome: "activated" })
      expect(tool("list_items")?.description).toBe("v1 list")
      expect(initializedOrgRuntimes.has(gone)).toBe(false)
      expect(initializedOrgRuntimes.has(TEST_ORG)).toBe(true)
    } finally {
      initializedOrgRuntimes.delete(gone)
    }
  }, 60_000)
})

describe("P2-fix10: the gate loads the handler bundle the way a tool call does", () => {
  it("a version whose bundle does not parse is switched back", async () => {
    await install("1.0.0", { tools: { list_items: "v1 list" } })
    await expect(
      upgrade("2.0.0", { tools: { list_items: "v2 list" }, bundle: "function list_items( {" }),
    ).rejects.toMatchObject({ code: "module_invalid" })
    expect((await pointer())?.version).toBe("1.0.0")
    expect(tool("list_items")?.description).toBe("v1 list")
  }, 60_000)

  it("a version whose bundle carries an import attribute is switched back before the host parses it, so a macro in it never runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "versions-macro-"))
    try {
      const marker = join(dir, "ran")
      const macro = join(dir, "macro.ts")
      writeFileSync(
        macro,
        `import { writeFileSync } from "node:fs"\nexport function mark() { writeFileSync(${JSON.stringify(marker)}, "ran"); return 1 }\n`,
      )
      await install("1.0.0", { tools: { list_items: "v1 list" } })
      await expect(
        upgrade("2.0.0", {
          tools: { list_items: "v2 list" },
          bundle: `import { mark } from ${JSON.stringify(macro)} with { type: "macro" };\nvar seen = mark();\nexport async function list_items() { return seen }\n`,
        }),
      ).rejects.toMatchObject({ code: "module_invalid" })
      expect(existsSync(marker)).toBe(false)
      expect((await pointer())?.version).toBe("1.0.0")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("the gate's other outcomes", () => {
  it("a gate that crashes switches back", async () => {
    await install("1.0.0", { tools: { list_items: "v1 list" } })
    activationGate.beforeOrgSwitch = async (_org, version) => {
      if (version === "2.0.0") throw new Error("probe exploded")
    }
    try {
      await expect(upgrade("2.0.0", { tools: { list_items: "v2 list" } })).rejects.toMatchObject({
        code: "gate_crashed",
      })
    } finally {
      activationGate.beforeOrgSwitch = undefined
    }
    expect((await pointer())?.version).toBe("1.0.0")
    expect(tool("list_items")?.description).toBe("v1 list")
    expect((await events())[0]).toMatchObject({
      outcome: "switched_back",
      reasonCode: "gate_crashed",
    })
  }, 60_000)

  it("a failure in an org where the app is Off does not switch back", async () => {
    await install("1.0.0")
    await sql`UPDATE kernel.apps SET status = 'disabled' WHERE org_id = ${TEST_ORG} AND name = ${APP}`
    await upgrade("2.0.0", { schema: BROKEN_SCHEMA })
    expect((await pointer())?.version).toBe("2.0.0")
    expect((await events())[0]).toMatchObject({ outcome: "activated" })
  }, 60_000)

  it("a declared tool that did not register fails the gate (tools_missing)", async () => {
    await install("1.0.0", { tools: { list_items: "v1 list" } })
    activationGate.afterOrgSwitch = async (org, version) => {
      if (version === "2.0.0") toolRegistry.delete([org, APP, "list_items"])
    }
    try {
      await expect(upgrade("2.0.0", { tools: { list_items: "v2 list" } })).rejects.toMatchObject({
        code: "tools_missing",
      })
    } finally {
      activationGate.afterOrgSwitch = undefined
    }
    expect((await pointer())?.version).toBe("1.0.0")
    expect((await events())[0]).toMatchObject({
      outcome: "switched_back",
      reasonCode: "tools_missing",
    })
  }, 60_000)

  it("the announcement to other processes carries no payload (A15)", async () => {
    const listener = redis.duplicate()
    const messages: string[] = []
    try {
      await listener.subscribe(ACTIVE_VERSIONS_CHANNEL)
      listener.on("message", (_channel: string, message: string) => messages.push(message))
      await install("1.0.0")
      for (let i = 0; i < 20 && messages.length === 0; i++) await Bun.sleep(50)
    } finally {
      await listener.quit()
    }
    expect(messages.length).toBeGreaterThan(0)
    for (const m of messages) expect(JSON.parse(m)).toEqual({})
  }, 60_000)
})
