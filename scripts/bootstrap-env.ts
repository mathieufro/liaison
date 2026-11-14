#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2

/**
 * Shared bootstrap: ensures Postgres + Redis are running, creates DB/roles, runs migrations.
 * Used by both `dev` and `test` scripts with different DB names.
 *
 * Usage:
 *   import { bootstrap } from "./bootstrap-env"
 *   await bootstrap({ dbName: "liaison_dev" })
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { assertDevComposeProject } from "../packages/test-helpers/src/ensure-infra"

const POSTGRES_ROLE = "postgres"
const POSTGRES_PASSWORD = "postgres"
const APP_ROLE = "liaison_app"
const APP_PASSWORD = "liaison_app"

const ROOT = `${import.meta.dir}/..`

type CmdResult = { ok: boolean; code: number; stdout: string; stderr: string }

function log(step: string, message: string) {
  console.log(`\x1b[2m[bootstrap]\x1b[0m ${step}: ${message}`)
}

function run(command: string[], options?: { cwd?: string; quiet?: boolean }): CmdResult {
  const proc = Bun.spawnSync(command, { cwd: options?.cwd, stdout: "pipe", stderr: "pipe" })
  const stdout = proc.stdout.toString().trim()
  const stderr = proc.stderr.toString().trim()
  if (!options?.quiet && (stdout || stderr)) {
    if (stdout) console.log(stdout)
    if (stderr) console.error(stderr)
  }
  return { ok: proc.exitCode === 0, code: proc.exitCode, stdout, stderr }
}

function has(cmd: string): boolean {
  return run(["which", cmd], { quiet: true }).ok
}

async function waitFor(check: () => boolean, label: string, attempts = 30, delayMs = 500) {
  for (let i = 0; i < attempts; i++) {
    if (check()) return
    await sleep(delayMs)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function assertOk(result: CmdResult, errorMessage: string) {
  if (!result.ok) {
    throw new Error(`${errorMessage}\n${result.stderr || result.stdout || "(no output)"}`)
  }
}

// Connect over TCP with explicit creds — the infra is a docker-compose Postgres
// (TCP + password), not a brew cluster with a trust-auth local socket for the OS
// user. A bare `psql -d <db>` connected as `$USER` over the local socket and
// silently failed against docker, making the availability check think Postgres
// was down. `PG_SUPER_BASE` is the convention all tooling uses.
const PG_SUPER_BASE = `postgres://${POSTGRES_ROLE}:${POSTGRES_PASSWORD}@localhost:5432`

function psql(sql: string, db = "postgres", quiet = false): CmdResult {
  return run(["psql", `${PG_SUPER_BASE}/${db}`, "-v", "ON_ERROR_STOP=1", "-c", sql], { quiet })
}

function psqlValue(sql: string, db = "postgres"): string {
  const result = run(
    ["psql", `${PG_SUPER_BASE}/${db}`, "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql],
    {
      quiet: true,
    },
  )
  return result.ok ? result.stdout.trim() : ""
}

function redisPong(): boolean {
  const ping = run(["redis-cli", "ping"], { quiet: true })
  return ping.ok && ping.stdout.includes("PONG")
}

function ensureRedis() {
  log("redis", "checking availability")
  if (redisPong()) {
    log("redis", "already running")
    return
  }
  // Prefer the docker-compose cluster (same infra as Postgres).
  if (has("docker")) {
    log("redis", "starting docker compose cluster")
    assertDevComposeProject()
    run(["docker", "compose", "up", "-d"], { quiet: true })
    for (let i = 0; i < 15; i++) {
      if (redisPong()) {
        log("redis", "ready (docker)")
        return
      }
      Bun.sleepSync(1000)
    }
  }
  if (has("brew")) {
    if (!has("redis-server")) {
      log("redis", "installing redis with homebrew")
      assertOk(run(["brew", "install", "redis"]), "Failed to install redis")
    }
    log("redis", "starting redis service")
    assertOk(run(["brew", "services", "start", "redis"], { quiet: true }), "Failed to start redis")
    return
  }
  if (has("redis-server")) {
    log("redis", "starting redis-server in daemon mode")
    assertOk(run(["redis-server", "--daemonize", "yes"], { quiet: true }), "Failed to start redis")
    return
  }
  throw new Error("redis not reachable (tried docker compose + brew). Run `bun run infra:up`.")
}

function ensurePostgres() {
  log("postgres", "checking availability")
  if (!has("psql")) throw new Error("psql not found. Install the postgres client and rerun.")
  if (psqlValue("SELECT 1") === "1") {
    log("postgres", "already running")
    return
  }
  // Not reachable as postgres:postgres → bring up the docker-compose cluster (the
  // infra the sim + test suites use) and heal the `postgres` superuser role the
  // compose omits (it ships a `liaison` superuser). Self-healing — no manual steps.
  if (has("docker")) {
    log("postgres", "starting docker compose cluster")
    assertDevComposeProject()
    run(["docker", "compose", "up", "-d"], { quiet: true })
    for (let i = 0; i < 30; i++) {
      if (psqlValue("SELECT 1") === "1") {
        log("postgres", "ready (docker)")
        return
      }
      // Bootstrap the `postgres` superuser through the compose `liaison` superuser.
      run(
        [
          "psql",
          "postgres://liaison:liaison@localhost:5432/postgres",
          "-tAc",
          "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='postgres') THEN CREATE ROLE postgres LOGIN SUPERUSER PASSWORD 'postgres'; END IF; END $$;",
        ],
        { quiet: true },
      )
      Bun.sleepSync(1000)
    }
  }
  // Legacy brew fallback.
  if (has("brew")) {
    for (const service of ["postgresql@16", "postgresql@15", "postgresql@14", "postgresql"]) {
      if (!run(["brew", "list", service], { quiet: true }).ok) continue
      if (run(["brew", "services", "start", service], { quiet: true }).ok) {
        Bun.sleepSync(2000)
        if (psqlValue("SELECT 1") === "1") return
      }
    }
  }
  throw new Error("PostgreSQL not reachable (tried docker compose + brew). Run `bun run infra:up`.")
}

function ensureRolesAndDatabase(dbName: string) {
  log("db", `ensuring roles and database "${dbName}"`)
  ensureRoles()
  ensureDatabase(dbName)
}

function ensureRoles() {
  assertOk(
    psql(
      `DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${POSTGRES_ROLE}') THEN
    EXECUTE format('CREATE ROLE %I LOGIN SUPERUSER PASSWORD %L', '${POSTGRES_ROLE}', '${POSTGRES_PASSWORD}');
  ELSE
    EXECUTE format('ALTER ROLE %I WITH LOGIN SUPERUSER PASSWORD %L', '${POSTGRES_ROLE}', '${POSTGRES_PASSWORD}');
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', '${APP_ROLE}', '${APP_PASSWORD}');
  ELSE
    EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', '${APP_ROLE}', '${APP_PASSWORD}');
  END IF;
END $$;`,
    ),
    "Failed to create/update postgres roles",
  )
}

function ensureDatabase(dbName: string) {
  const exists = psqlValue(`SELECT 1 FROM pg_database WHERE datname = '${dbName}'`)
  if (exists !== "1") {
    assertOk(
      psql(`CREATE DATABASE ${dbName} OWNER ${POSTGRES_ROLE};`),
      `Failed to create ${dbName}`,
    )
  }
  assertOk(
    psql(`GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO ${POSTGRES_ROLE};`),
    "Failed DB grant to postgres role",
  )
  assertOk(
    psql(`GRANT CONNECT, CREATE ON DATABASE ${dbName} TO ${APP_ROLE};`),
    "Failed DB grant to app role",
  )
}

function runMigrations(dbName: string) {
  log("migrate", "running drizzle migrations")
  const databaseUrl = `postgres://${POSTGRES_ROLE}:${POSTGRES_PASSWORD}@localhost:5432/${dbName}`
  const result = Bun.spawnSync(["bun", "--filter", "@liaison/api", "db:migrate"], {
    cwd: ROOT,
    env: { ...process.env, MIGRATION_DATABASE_URL: databaseUrl },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = result.stdout.toString().trim()
  const stderr = result.stderr.toString().trim()
  if (stdout) console.log(stdout)
  if (stderr) console.error(stderr)
  if (result.exitCode !== 0) throw new Error("Failed to run drizzle migrations")
}

function ensureDbGrants(dbName: string) {
  log("db", "ensuring schema/table grants for liaison_app and liaison_rls")
  const grants = [
    "CREATE EXTENSION IF NOT EXISTS pgcrypto;",
    `GRANT USAGE ON SCHEMA kernel TO ${APP_ROLE};`,
    `GRANT ALL ON ALL TABLES IN SCHEMA kernel TO ${APP_ROLE};`,
    `GRANT ALL ON ALL SEQUENCES IN SCHEMA kernel TO ${APP_ROLE};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA kernel GRANT ALL ON TABLES TO ${APP_ROLE};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA kernel GRANT ALL ON SEQUENCES TO ${APP_ROLE};`,
    `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_rls') THEN
    GRANT USAGE ON SCHEMA kernel TO liaison_rls;
    GRANT ALL ON ALL TABLES IN SCHEMA kernel TO liaison_rls;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA kernel TO liaison_rls;
    ALTER DEFAULT PRIVILEGES IN SCHEMA kernel GRANT ALL ON TABLES TO liaison_rls;
    ALTER DEFAULT PRIVILEGES IN SCHEMA kernel GRANT ALL ON SEQUENCES TO liaison_rls;
  END IF;
END $$;`,
    // The blanket grants above would undo a migration's deliberate REVOKE:
    // kernel.durable_consumer_marks belongs to liaison_admin alone (0089).
    `DO $$
BEGIN
  IF to_regclass('kernel.durable_consumer_marks') IS NOT NULL THEN
    REVOKE ALL ON kernel.durable_consumer_marks FROM ${APP_ROLE};
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_rls') THEN
      REVOKE ALL ON kernel.durable_consumer_marks FROM liaison_rls;
    END IF;
  END IF;
END $$;`,
  ]
  for (const statement of grants) {
    assertOk(psql(statement, dbName, true), `Failed: ${statement}`)
  }
}

/**
 * Newest mtime (ms) of any file under `dir`, skipping directories named in
 * `exclude` (e.g. `dist`, `node_modules`). Returns 0 for a missing/empty dir.
 */
function newestMtimeMs(dir: string, exclude: Set<string>): number {
  if (!existsSync(dir)) return 0
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (exclude.has(entry.name)) continue
    const p = join(dir, entry.name)
    newest = entry.isDirectory()
      ? Math.max(newest, newestMtimeMs(p, exclude))
      : Math.max(newest, statSync(p).mtimeMs)
  }
  return newest
}

/**
 * Rebuild any bundled-app `.liaisonapp` tarball whose source is newer than the
 * built artifact, so e2e/integration installs never run against a stale bundle
 * (a recurring footgun: edit a handler/template, forget to rebuild, tests run
 * the old code). Cheap when fresh — only an mtime walk; rebuilds only the
 * stale apps. The shared packages bundled INTO every app (`@liaison/app-sdk`,
 * `@liaison/shared`) are folded into the staleness clock so an SDK/schema edit
 * invalidates all app tarballs too.
 *
 * Opt out with `LIAISON_SKIP_APP_REBUILD=1`. Rebuilds use `--skip-sign` (the
 * `_test` install routes install with `requireSignature: false`) and drop any
 * now-stale `.cosign.bundle` so a signature-checking path fails loud, not on a
 * mismatch.
 */
export function ensureBundledAppsFresh() {
  if (process.env.LIAISON_SKIP_APP_REBUILD === "1") {
    log("apps", "skip rebuild (LIAISON_SKIP_APP_REBUILD=1)")
    return
  }
  const bundledRoot = join(ROOT, "bundled-apps")
  if (!existsSync(bundledRoot)) return
  const skip = new Set(["dist", "node_modules", ".turbo", ".git"])
  // Shared deps that get bundled into every app — their edits invalidate all
  // app tarballs (e.g. the PDF DSL touches app-sdk + shared, bundled into
  // invoicing's template artifacts).
  const sharedMtime = Math.max(
    newestMtimeMs(join(ROOT, "packages/app-sdk/src"), skip),
    newestMtimeMs(join(ROOT, "packages/shared/src"), skip),
  )
  const buildScript = join(ROOT, "scripts/build-bundled-app.sh")
  if (!existsSync(buildScript)) return

  for (const app of readdirSync(bundledRoot, { withFileTypes: true })) {
    if (!app.isDirectory()) continue
    const appDir = join(bundledRoot, app.name)
    const manifestPath = join(appDir, "app.manifest.json")
    if (!existsSync(manifestPath)) continue
    let version = "0.1.0"
    try {
      version = (JSON.parse(readFileSync(manifestPath, "utf8")).version as string) ?? version
    } catch {
      /* keep default */
    }
    const tarball = join(appDir, "dist", `${app.name}-${version}.liaisonapp`)
    const tarMtime = existsSync(tarball) ? statSync(tarball).mtimeMs : 0
    const srcMtime = Math.max(newestMtimeMs(appDir, skip), sharedMtime)
    if (tarMtime > 0 && tarMtime >= srcMtime) continue // fresh — nothing to do

    log(
      "apps",
      `${app.name}: ${tarMtime === 0 ? "tarball missing" : "source newer than tarball"} → rebuilding`,
    )
    const res = run(["bash", buildScript, app.name, "--skip-sign"], { cwd: ROOT })
    if (!res.ok) {
      // Footgun guard: an ESTABLISHED app (one with a prior tarball) failing to
      // rebuild after a source edit must hard-fail — otherwise tests silently run
      // the stale tarball and miss the regression. But a BRAND-NEW app that has
      // never built (no tarball, e.g. a half-finished WIP app another workstream
      // just added) has no stale code to mask: skipping it leaves it simply
      // absent (any test that needs it fails honestly), and a broken WIP app must
      // not block the entire test suite's bootstrap. Warn loudly and continue.
      if (tarMtime === 0) {
        log(
          "apps",
          `WARNING: ${app.name} has no tarball and failed to build — skipping (app will be ABSENT this run). Build error:\n${res.stderr || res.stdout}`,
        )
        continue
      }
      throw new Error(`Failed to rebuild bundled app "${app.name}":\n${res.stderr || res.stdout}`)
    }
    const sig = `${tarball}.cosign.bundle`
    if (existsSync(sig)) rmSync(sig, { force: true })
    log("apps", `${app.name}: rebuilt ✓`)
  }
}

export interface BootstrapOptions {
  dbName: string
  /**
   * Services and roles only: create and migrate no database. The test runner
   * gives every run its own database cloned from a migrated template
   * (scripts/lib/test-template.ts), so the test bootstrap no longer migrates
   * the shared liaison_test that other checkouts may be using.
   */
  servicesOnly?: boolean
}

export async function bootstrap({ dbName, servicesOnly = false }: BootstrapOptions) {
  if (!has("redis-cli")) {
    if (has("brew")) {
      log("redis", "redis-cli missing, attempting Homebrew install")
      assertOk(run(["brew", "install", "redis"]), "Failed to install redis")
    } else {
      throw new Error("redis-cli is missing. Install Redis and rerun.")
    }
  }

  ensureRedis()
  await waitFor(() => {
    const ping = run(["redis-cli", "ping"], { quiet: true })
    return ping.ok && ping.stdout.includes("PONG")
  }, "redis")

  ensurePostgres()
  await waitFor(() => psqlValue("SELECT 1") === "1", "postgres")

  if (servicesOnly) {
    ensureRoles()
    log("done", `ready (services and roles; per-run databases come from the template)`)
    return
  }
  ensureRolesAndDatabase(dbName)
  runMigrations(dbName)
  ensureDbGrants(dbName)

  log("done", `ready (db=${dbName}, appRole=${APP_ROLE}, redis=localhost:6379)`)
}
