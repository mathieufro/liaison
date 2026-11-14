// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Self-healing local infra for the chaos sim + test suites (Postgres, Redis,
// MeiliSearch, SeaweedFS). ONE idempotent command — safe to re-run anytime, recovers a
// crashed/partial cluster with zero manual steps:
//
//   bun run infra:up          # bring up + heal (containers, postgres role, liaison_test)
//   bun run infra:check       # single-shot status, change nothing (exit 1 if unhealthy)
//
// It is ALSO imported by the internal QA chaos runner, which calls
// `ensureInfra()` on startup so a run never dies on a downed Postgres.
//
// What it heals:
//   1. `docker compose up -d` — start any stopped container.
//   2. Wait for Postgres / Redis / MeiliSearch / SeaweedFS to answer (bounded).
//   3. The `postgres` superuser role. docker-compose ships a `liaison` superuser, but
//      ALL tooling (db-reset, .env.test, the chaos forceChaosDatabaseUrl, preflight)
//      connects as `postgres:postgres` — so ensure that role exists, bootstrapping
//      through whichever superuser the cluster currently has.
//   4. `liaison_test` with the app/rls roles + latest migrations (via db:reset:test —
//      a fresh, fully-migrated test DB is exactly what the chaos run clones from),
//      but ONLY when it is actually missing or unmigrated. `liaison_dev` is never
//      touched, so a dev seed is preserved.
//
//      Why conditional: `liaison_test` on this machine is SHARED with a second
//      checkout, and a feature branch can carry migrations dated far in the future.
//      Resetting unconditionally republishes that ledger into a database the other
//      checkout relies on, and Drizzle then skips every migration dated below the
//      high water mark, silently, for whoever runs next. An agent that only wanted
//      Docker started should not be able to cause that. Pass `--reset-test-db` (or
//      set `INFRA_RESET_TEST_DB=1`) to force the reset.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { spawn } from "bun"
import { assertDevComposeProject } from "../packages/test-helpers/src/ensure-infra"
import { RESET_EXPECT_DB_VAR, resolveTestDb } from "../packages/test-helpers/src/test-db-target"

const ROOT = new URL("..", import.meta.url).pathname
// The test database this env is configured for (liaison_test unless the DB URL vars name
// another): what is probed is what a reset may drop, and nothing else.
const readIf = (f: string) => (existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f), "utf8") : "")
const TEST_DB = resolveTestDb({
  env: process.env,
  envTestText: readIf(".env.test"),
  rootEnvText: readIf(".env"),
}).name
const TEST_DSN = `postgres://postgres:postgres@localhost:5432/${TEST_DB}`
const MEILI = process.env.MEILISEARCH_HOST ?? "http://localhost:7700"
const OBJECTSTORE_HEALTH = "http://localhost:9000/healthz"
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379"

// Superuser candidates, tried in order. `postgres:postgres` is the convention all
// tooling uses; `liaison:liaison` is what docker-compose.yml currently ships.
const SUPERUSER_CANDIDATES = [
  "postgres://postgres:postgres@localhost:5432",
  "postgres://liaison:liaison@localhost:5432",
]

const log = (m: string) => process.stdout.write(`${m}\n`)

async function sh(
  cmd: string[],
  opts: { env?: Record<string, string | undefined>; quiet?: boolean } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = spawn(cmd, {
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  if (!opts.quiet && code !== 0 && stderr.trim()) log(stderr.trim())
  return { ok: code === 0, stdout, stderr }
}

/** psql one-liner against a full DSN. Returns ok + trimmed stdout. */
async function psql(dsn: string, sql: string): Promise<{ ok: boolean; out: string }> {
  const r = await sh(["psql", dsn, "-tAX", "-v", "ON_ERROR_STOP=1", "-c", sql], { quiet: true })
  return { ok: r.ok, out: r.stdout.trim() }
}

async function http200(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).status === 200
  } catch {
    return false
  }
}

async function redisPong(): Promise<boolean> {
  return (await sh(["redis-cli", "-u", REDIS_URL, "ping"], { quiet: true })).stdout.includes("PONG")
}

/** Single-shot health: every dependency the chaos run needs, RIGHT NOW. */
export async function infraHealthy(): Promise<{ ok: boolean; down: string[] }> {
  const checks: Array<[string, Promise<boolean>]> = [
    // pg health = the chaos DSN actually connects (covers pg up AND liaison_test exists).
    [`postgres/${TEST_DB}`, psql(TEST_DSN, "select 1").then((r) => r.ok)],
    ["redis", redisPong()],
    ["meilisearch", http200(`${MEILI}/health`)],
    ["objectstore", http200(OBJECTSTORE_HEALTH)],
  ]
  const results = await Promise.all(checks.map(([, p]) => p))
  const down = checks.filter((_, i) => !results[i]).map(([name]) => name)
  return { ok: down.length === 0, down }
}

async function pollUntil(
  label: string,
  fn: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) {
      log(`  ✓ ${label}`)
      return true
    }
    await Bun.sleep(2000)
  }
  log(`  ✗ ${label} — not healthy after ${Math.round(timeoutMs / 1000)}s`)
  return false
}

/** First superuser DSN base that can connect, or null. */
async function findSuperuser(): Promise<string | null> {
  for (const base of SUPERUSER_CANDIDATES) {
    if ((await psql(`${base}/postgres`, "select 1")).ok) return base
    if ((await psql(`${base}/liaison`, "select 1")).ok) return base
  }
  return null
}

/**
 * Whether `liaison_test` already carries a migrated schema. A bare `select 1`
 * only proves the database exists, which is why the health probe above is not
 * enough on its own to decide against a reset.
 */
export async function testDbMigrated(): Promise<boolean> {
  return (
    (await psql(TEST_DSN, "select to_regclass('kernel.organizations') is not null")).out === "t"
  )
}

/** True when the operator explicitly asked for the shared test database to be reset. */
export function resetTestDbRequested(
  argv: string[] = process.argv,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return argv.includes("--reset-test-db") || env.INFRA_RESET_TEST_DB === "1"
}

/**
 * The reset decision, pure so it can be tested without a cluster. Reset when the
 * database is not usable yet (nothing to lose) or when it was asked for
 * explicitly, and never merely because someone wanted Docker started.
 */
export function shouldResetTestDb(input: { migrated: boolean; force: boolean }): boolean {
  return input.force || !input.migrated
}

/** Bring the cluster up + repair it. Idempotent. Throws on unrecoverable failure. */
export async function bringUpInfra(): Promise<void> {
  log("── bringing up chaos/test infra ──")
  log("• docker compose up -d")
  assertDevComposeProject()
  const up = await sh(["docker", "compose", "up", "-d"])
  if (!up.ok) {
    throw new Error(
      "`docker compose up -d` failed — is Docker running? (start Docker Desktop / colima)",
    )
  }

  log("• waiting for services")
  const pgUp = await pollUntil(
    "postgres :5432",
    async () => (await findSuperuser()) !== null,
    90_000,
  )
  const redisUp = await pollUntil("redis :6379", redisPong, 90_000)
  const meiliUp = await pollUntil("meilisearch :7700", () => http200(`${MEILI}/health`), 90_000)
  const objectstoreUp = await pollUntil(
    "objectstore :9000",
    () => http200(OBJECTSTORE_HEALTH),
    90_000,
  )
  if (!pgUp || !redisUp || !meiliUp || !objectstoreUp)
    throw new Error("infra not fully healthy after bring-up")

  // Heal the `postgres` superuser role (compose may ship only a `liaison` superuser).
  const superBase = await findSuperuser()
  if (!superBase) throw new Error("no working Postgres superuser found")
  if (!superBase.startsWith("postgres://postgres:")) {
    log("• healing `postgres` superuser role")
    const sql =
      "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='postgres') THEN CREATE ROLE postgres LOGIN SUPERUSER PASSWORD 'postgres'; END IF; END $$;"
    if (!(await psql(`${superBase}/postgres`, sql)).ok) await psql(`${superBase}/liaison`, sql)
    if (!(await psql("postgres://postgres:postgres@localhost:5432/postgres", "select 1")).ok) {
      throw new Error("could not establish the `postgres` superuser role")
    }
    log("  ✓ postgres superuser ready")
  } else {
    log("  ✓ postgres superuser present")
  }

  // Ensure liaison_test exists, roled, migrated (the chaos clone base). Conditional:
  // see the header note about the shared database and far future migration ledgers.
  const ready = await testDbMigrated()
  if (shouldResetTestDb({ migrated: ready, force: resetTestDbRequested() })) {
    log(`• ensuring ${TEST_DB} (roles + migrations) via db:reset:test`)
    const reset = await sh(["bun", "run", "db:reset:test"], {
      env: { [RESET_EXPECT_DB_VAR]: TEST_DB },
    })
    if (!reset.ok) throw new Error(`db:reset:test failed: ${reset.stderr.slice(-400)}`)
  } else {
    log(`• ${TEST_DB} is already migrated, leaving it alone`)
    log("  (it is shared with another checkout: pass --reset-test-db to reset it anyway)")
  }

  log(`\n✓ infra ready — postgres + ${TEST_DB} (migrated), redis, meilisearch, objectstore`)
}

/**
 * Chaos-runner entrypoint: ensure infra is healthy, self-healing if not. Cheap
 * no-op when everything is already up; brings the cluster up + repairs it otherwise.
 */
export async function ensureInfra(): Promise<void> {
  const h = await infraHealthy()
  if (h.ok) {
    log(`✓ infra healthy (postgres/${TEST_DB}, redis, meilisearch, objectstore)`)
    return
  }
  log(`⚠ infra not healthy (down: ${h.down.join(", ")}) — self-healing…`)
  await bringUpInfra()
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const h = await infraHealthy()
    log(h.ok ? "✓ all infra healthy" : `✗ unhealthy — down: ${h.down.join(", ")}`)
    process.exit(h.ok ? 0 : 1)
  }
  try {
    await bringUpInfra()
    process.exit(0)
  } catch (err) {
    log(`✗ ${(err as Error).message}`)
    process.exit(1)
  }
}
