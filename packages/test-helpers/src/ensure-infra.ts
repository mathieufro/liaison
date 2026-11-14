// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Test infrastructure orchestrator.
 *
 * Probes whether the dev-mode Docker services (Postgres, Redis, Meilisearch,
 * SeaweedFS + the `liaison-dev` bucket) are reachable and ready. If anything
 * is missing, starts the `docker-compose.yml` services and waits for them to
 * come up. Idempotent: a no-op when everything is already running.
 *
 * Architectural intent: tests should never silently fail because a developer
 * forgot to run `docker compose up`. Any test entry point (route-test-setup
 * for unit/integration; worker-env for E2E) should call `ensureTestInfra()`
 * in its setup hook.
 */

import { spawnSync } from "node:child_process"
import { createHash, createHmac } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve as resolvePath } from "node:path"
import { fileURLToPath } from "node:url"
import {
  DEV_DB,
  dbNameFromUrl,
  RESET_EXPECT_DB_VAR,
  resolveTestDb,
  TestDbTargetError,
} from "./test-db-target"

const OBJECTSTORE_URL = process.env.OBJECT_STORAGE_ENDPOINT ?? "http://localhost:9000"
const OBJECTSTORE_BUCKET = process.env.OBJECT_STORAGE_BUCKET ?? "liaison-dev"
const OBJECTSTORE_ACCESS = process.env.OBJECT_STORAGE_ACCESS_KEY ?? "liaison"
const OBJECTSTORE_SECRET = process.env.OBJECT_STORAGE_SECRET_KEY ?? "liaison-dev-secret"
const OBJECTSTORE_REGION = process.env.OBJECT_STORAGE_REGION ?? "us-east-1"
const MEILI_URL = process.env.MEILISEARCH_HOST ?? "http://localhost:7700"
const POSTGRES_HOST = process.env.PG_HOST ?? "localhost"
const POSTGRES_PORT = Number(process.env.PG_PORT ?? "5432")
const REDIS_HOST = process.env.REDIS_HOST ?? "localhost"
const REDIS_PORT = Number(process.env.REDIS_PORT ?? "6379")
// Superuser DSN used purely for a liveness `SELECT 1`. Must match the
// docker-compose Postgres. Override with PG_SUPERUSER_URL if customized.
const PG_SUPERUSER_URL =
  process.env.PG_SUPERUSER_URL ??
  `postgres://postgres:postgres@${POSTGRES_HOST}:${POSTGRES_PORT}/postgres`

const READY_DEADLINE_MS = 30_000
const READY_POLL_MS = 250
// A hung Postgres accepts the TCP connection but never answers a query. The
// liveness probe must therefore run a real query under a hard timeout so a
// wedged backend is detected in seconds — never an opaque downstream hang.
const LIVENESS_QUERY_TIMEOUT_MS = 3_000
// Every spawned helper gets a HARD timeout. `spawnSync` without one blocks the
// caller forever, and this module runs inside a Playwright worker fixture whose
// own budget is 300 s: a wedged `docker compose` call there does not fail, it
// burns the whole fixture, and the worker is then SIGKILLed mid-setup (env
// leaked, zero tests run). Bounded means the failure is loud and attributable.
const DOCKER_CMD_TIMEOUT_MS = 60_000
const DB_RESET_TIMEOUT_MS = 300_000
const PSQL_LOOKUP_TIMEOUT_MS = 10_000

// Repository root resolved relative to this file's location in the workspace.
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolvePath(__dirname, "../../..")

// Cache the readiness check across the entire process — the bun:test runner
// loads many *.test.ts files, and probing/spawning for every one would add
// seconds per test file. Once we've verified the services are up in a process,
// they stay up.
let _readyPromise: Promise<void> | null = null

export function ensureTestInfra(): Promise<void> {
  if (!_readyPromise) {
    _readyPromise = ensureTestInfraOnce().catch((err) => {
      // Reset on failure so subsequent calls can retry.
      _readyPromise = null
      throw err
    })
  }
  return _readyPromise
}

interface ServiceCheck {
  name: string
  composeName: string
  /** Cheap reachability check — is the port accepting connections at all? */
  portProbe: () => Promise<boolean>
  /** Real liveness — does the service actually answer? Catches a wedged
   *  container that accepts TCP but never responds. */
  probe: () => Promise<boolean>
}

const SERVICES: ServiceCheck[] = [
  {
    name: "postgres",
    composeName: "postgres",
    portProbe: () => probeTcp(POSTGRES_HOST, POSTGRES_PORT),
    probe: async () => probePgAlive(),
  },
  {
    name: "redis",
    composeName: "redis",
    portProbe: () => probeTcp(REDIS_HOST, REDIS_PORT),
    probe: () => probeRedisAlive(),
  },
  {
    name: "meilisearch",
    composeName: "meilisearch",
    portProbe: () => probeHttp(`${MEILI_URL}/health`),
    probe: () => probeHttp(`${MEILI_URL}/health`),
  },
  {
    name: "objectstore",
    composeName: "objectstore",
    portProbe: () => probeHttp(`${OBJECTSTORE_URL}/healthz`),
    probe: () => probeHttp(`${OBJECTSTORE_URL}/healthz`),
  },
]

type ServiceState = "ok" | "missing" | "wedged"

/**
 * Classify a service: `ok` (answers), `missing` (port closed — needs
 * `up -d`), or `wedged` (port open but not answering — needs `restart`).
 * The wedged case is the one a bare TCP probe silently mis-reports as fine.
 */
async function classifyService(svc: ServiceCheck): Promise<ServiceState> {
  if (await svc.probe()) return "ok"
  return (await svc.portProbe()) ? "wedged" : "missing"
}

async function ensureTestInfraOnce(): Promise<void> {
  // 1. Classify every service by REAL liveness (not just port-open) so a
  // wedged container is detected here instead of hanging a downstream query.
  const states = await Promise.all(
    SERVICES.map(async (svc) => [svc, await classifyService(svc)] as const),
  )
  const bucketReady = await objectstoreBucketExists()
  // A namespaced run (LIAISON_TEST_NS, set by scripts/test-run.ts) gets its
  // database cloned from a template keyed by the migrations hash before any test
  // starts, so it cannot drift; and resetting the SHARED liaison_test or
  // liaison_dev from inside such a run would pull them from under every other
  // checkout using them. Drift repair is a bare-run behaviour only.
  const dbs = process.env.LIAISON_TEST_NS ? null : driftTargets()
  const testDrifted = dbs ? await detectSchemaDrift(dbs.test) : false
  const devDrifted = dbs?.dev ? await detectSchemaDrift(dbs.dev) : false

  const allOk = states.every(([, st]) => st === "ok")
  // Fast path — everything healthy and both DBs in sync with on-disk migration.
  if (allOk && bucketReady && !testDrifted && !devDrifted) return

  // 2. Recover unhealthy services. `missing` → start it; `wedged` → restart
  // it (a port-open-but-dead container, e.g. a hung Postgres, only recovers
  // with a restart, never with `up -d`). Probe each independently so a
  // host-managed service on the same port isn't disturbed.
  const missing = states.filter(([, st]) => st === "missing").map(([s]) => s)
  const wedged = states.filter(([, st]) => st === "wedged").map(([s]) => s)

  if (missing.length > 0) {
    await runDockerCompose(["up", "-d", ...missing.map((s) => s.composeName)])
  }
  if (wedged.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[test-infra] Recovering wedged service(s): ${wedged
        .map((s) => s.name)
        .join(", ")} — port open but not answering; restarting container(s).`,
    )
    await runDockerCompose(["restart", ...wedged.map((s) => s.composeName)])
  }
  for (const svc of [...missing, ...wedged]) {
    await waitForLiveness(svc)
  }

  // 3. Ensure the storage bucket exists (idempotent).
  if (!bucketReady) await ensureObjectstoreBucket()

  // 4. Auto-reset whichever DB drifted. Both stay in sync with the on-disk
  // migration automatically so a squashed-schema change never silently
  // leaves a drifted DB that hangs/fails later.
  if (testDrifted && dbs) await runDbReset("test", dbs.test.name)
  if (devDrifted && dbs?.dev) await runDbReset("dev", dbs.dev.name)
}

/**
 * Wait for a service to pass its REAL liveness probe. Throws a loud,
 * actionable error naming the service + remedy — never a silent timeout that
 * surfaces minutes later as an opaque downstream hang.
 */
async function waitForLiveness(svc: ServiceCheck): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < READY_DEADLINE_MS) {
    if (await svc.probe()) return
    await Bun.sleep(READY_POLL_MS)
  }
  const portOpen = await svc.portProbe()
  throw new Error(
    `[test-infra] ${svc.name} did not become healthy within ${READY_DEADLINE_MS}ms.\n` +
      (portOpen
        ? `Its port is open but it is NOT answering (wedged container). ` +
          `Recovery via 'docker compose restart ${svc.composeName}' did not help.\n`
        : `Its port is not even accepting connections.\n`) +
      `Inspect: 'docker compose ps' and 'docker compose logs ${svc.composeName}'. ` +
      `A full reset: 'docker compose down && docker compose up -d'.`,
  )
}

async function probeTcp(host: string, port: number): Promise<boolean> {
  try {
    // Bun.connect is async with a synchronous handshake — race against a short timer.
    const socket = await Promise.race([
      Bun.connect({
        hostname: host,
        port,
        socket: { data() {}, open() {}, close() {}, error() {} },
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ])
    if (!socket) return false
    ;(socket as { end?: () => void }).end?.()
    return true
  } catch {
    return false
  }
}

async function probeHttp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(500),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Real Postgres liveness: open a connection AND execute `SELECT 1` under a
 * hard timeout. A wedged backend (TCP accepted, queries never return) fails
 * here — unlike a bare port probe, which it would falsely pass. `psql`'s
 * spawn timeout is the hard bound; PGCONNECT_TIMEOUT bounds the TCP/auth leg.
 */
function probePgAlive(): boolean {
  const result = spawnSync("psql", [PG_SUPERUSER_URL, "-tAc", "SELECT 1"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: LIVENESS_QUERY_TIMEOUT_MS,
    env: { ...process.env, PGCONNECT_TIMEOUT: "2" },
  })
  return result.status === 0 && result.stdout.trim() === "1"
}

/**
 * Real Redis liveness: RESP `PING` over a socket under a hard timeout. A
 * wedged Redis that still accepts TCP fails here. No redis-cli dependency.
 */
async function probeRedisAlive(): Promise<boolean> {
  try {
    return await Promise.race([
      (async () => {
        let ponged = false
        const socket = await Bun.connect({
          hostname: REDIS_HOST,
          port: REDIS_PORT,
          socket: {
            data(_s, data) {
              if (data.toString().startsWith("+PONG")) ponged = true
            },
            open(s) {
              s.write("PING\r\n")
            },
            error() {},
            close() {},
          },
        })
        const deadline = Date.now() + LIVENESS_QUERY_TIMEOUT_MS
        while (!ponged && Date.now() < deadline) await Bun.sleep(25)
        ;(socket as { end?: () => void }).end?.()
        return ponged
      })(),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), LIVENESS_QUERY_TIMEOUT_MS),
      ),
    ])
  } catch {
    return false
  }
}

/** The project the dev substrate's compose file names (`name:` in docker-compose.yml). */
export const DEV_COMPOSE_PROJECT = "liaison"

/**
 * The self-host stack's compose file, when the project's containers came from it. The
 * self-host stack (deploy/docker-compose.yml, the trial's quickstart) also runs as project
 * `liaison`, with the same service names: neither name can change without renaming running
 * containers and volumes, so the dev tooling refuses to act on a project that holds it.
 */
export function selfHostComposeIn(configFiles: readonly string[]): string | null {
  for (const entry of configFiles) {
    for (const file of entry.split(",")) {
      if (/(^|[/\\])deploy[/\\][^/\\]*compose[^/\\]*\.ya?ml$/i.test(file.trim())) return file.trim()
    }
  }
  return null
}

/** Throw before a dev compose command would recreate or restart the self-host stack. */
export function assertDevComposeProject(): void {
  const listed = spawnSync(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${DEV_COMPOSE_PROJECT}`,
      "--format",
      '{{.Label "com.docker.compose.project.config_files"}}',
    ],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8", timeout: DOCKER_CMD_TIMEOUT_MS },
  )
  if (listed.status !== 0) return
  const selfHost = selfHostComposeIn(listed.stdout.split("\n"))
  if (selfHost) {
    throw new Error(
      `The compose project '${DEV_COMPOSE_PROJECT}' holds the self-host stack (${selfHost}), ` +
        "and the dev substrate uses the same project name. Running the dev compose now would " +
        "recreate or restart its containers. Stop it first (deploy/quickstart.sh --down keeps " +
        "its data), or start it under another name (deploy/quickstart.sh --project <name>).",
    )
  }
}

async function runDockerCompose(args: string[]): Promise<void> {
  assertDevComposeProject()
  const result = spawnSync("docker", ["compose", ...args], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: DOCKER_CMD_TIMEOUT_MS,
  })
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    throw new Error(
      `docker compose ${args.join(" ")} did not finish within ${DOCKER_CMD_TIMEOUT_MS}ms ` +
        `(concurrent test workers contending on the same compose project is the usual cause). ` +
        `stderr: ${result.stderr ?? ""}`,
    )
  }
  if (result.status !== 0) {
    throw new Error(
      `docker compose ${args.join(" ")} failed (exit ${result.status}): ${result.stderr}`,
    )
  }
}

// ── Object store bucket helpers ───────────────────────────────────────────

/**
 * Minimal AWS SigV4 signer for a single unsigned-payload GET, just enough to
 * probe bucket existence. SeaweedFS denies EVERY unauthenticated request once
 * identities are configured — existing or missing bucket alike both answer
 * 403 — so a plain "404 means missing" check doesn't distinguish the two.
 * Signed as the app identity (OBJECT_STORAGE_ACCESS_KEY/SECRET_KEY), which is
 * exactly the identity scoped to this one bucket, so a 403 here can only mean
 * "wrong bucket" and a 200 means it exists and the app can see into it.
 */
function signedS3Get(
  urlStr: string,
  accessKey: string,
  secretKey: string,
  region: string,
): { url: string; headers: Record<string, string> } {
  const url = new URL(urlStr)
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = "UNSIGNED-PAYLOAD"
  const canonicalQuery = [...url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&")
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date"
  const canonicalRequest = [
    "GET",
    url.pathname || "/",
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n")
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n")
  const hmac = (key: Buffer | string, data: string) =>
    createHmac("sha256", key).update(data).digest()
  const kDate = hmac(`AWS4${secretKey}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, "s3")
  const kSigning = hmac(kService, "aws4_request")
  const signature = hmac(kSigning, stringToSign).toString("hex")
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  return {
    url: urlStr,
    headers: {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      authorization,
    },
  }
}

/** Does the storage bucket exist? Probed over S3 HTTP (signed as the app
 * identity), NOT by spawning a container. The old probe ran `docker compose
 * run --rm ... objectstore-init` on EVERY call — and this function is called
 * once per test worker process, so a Playwright generation fired four
 * concurrent `compose run` invocations at the same compose project.
 * Contending there is unbounded: three of four workers made no further
 * progress and died on the 300 s `env` fixture timeout while one got through. */
async function objectstoreBucketExists(): Promise<boolean> {
  try {
    const target = `${OBJECTSTORE_URL}/${OBJECTSTORE_BUCKET}?max-keys=0`
    const { url, headers } = signedS3Get(
      target,
      OBJECTSTORE_ACCESS,
      OBJECTSTORE_SECRET,
      OBJECTSTORE_REGION,
    )
    const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(3_000) })
    return res.ok
  } catch {
    // Object store unreachable — the service probe above owns that diagnosis;
    // report "missing" so the caller runs the (bounded) creation path and
    // fails loud.
    return false
  }
}

async function ensureObjectstoreBucket(): Promise<void> {
  if (await objectstoreBucketExists()) return
  // Use the `objectstore-init` compose service. It's already declared in
  // docker-compose.yml and runs to completion (then exits).
  await runDockerCompose(["run", "--rm", "objectstore-init"])
  // Final verification
  if (!(await objectstoreBucketExists())) {
    throw new Error(
      `Test infra: object storage bucket "${OBJECTSTORE_BUCKET}" still missing after objectstore-init`,
    )
  }
}

// ── Schema drift detection ────────────────────────────────────────────────

const MIGRATIONS_DIR = resolvePath(REPO_ROOT, "apps/api/src/db/migrations")

interface DriftTarget {
  /** The database the probe reads and a drift reset would drop. */
  name: string
  /** Superuser DSN for the drizzle ledger lookup. */
  dsn: string
}

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf-8") : ""
}

/**
 * The databases this run may drift-check and reset, from its configured URL env vars, never a
 * hard-coded name: the test database (see test-db-target.ts) and the dev database only when the
 * dev probe really names `liaison_dev`. A MIGRATION_DATABASE_URL pointed at the test database is
 * the same database (checked once); pointed at any other database it is a configuration this
 * path will not reset, and it is refused loudly.
 */
export function driftTargets(env: Record<string, string | undefined> = process.env): {
  test: DriftTarget
  dev: DriftTarget | null
} {
  const test = resolveTestDb({
    env,
    envTestText: readIfExists(join(REPO_ROOT, ".env.test")),
    rootEnvText: readIfExists(join(REPO_ROOT, ".env")),
  }).name
  const testDsn =
    env.MIGRATION_DATABASE_URL_TEST ??
    `postgres://postgres:postgres@${POSTGRES_HOST}:${POSTGRES_PORT}/${test}`
  const devDsn =
    env.MIGRATION_DATABASE_URL ??
    `postgres://postgres:postgres@${POSTGRES_HOST}:${POSTGRES_PORT}/${DEV_DB}`
  const devName = dbNameFromUrl(devDsn)
  if (devName === test) return { test: { name: test, dsn: testDsn }, dev: null }
  if (devName !== DEV_DB) {
    throw new TestDbTargetError(
      `MIGRATION_DATABASE_URL names ${devName ?? "no database"}, which is neither the dev database (${DEV_DB}) nor this run's test database (${test}): refusing to drift-check or reset it`,
    )
  }
  return { test: { name: test, dsn: testDsn }, dev: { name: DEV_DB, dsn: devDsn } }
}

/**
 * Returns true when the current migration directory's content hash differs
 * from the hash drizzle recorded when it last applied the migration. A `true`
 * return means `bun run db:reset:test` must run before tests can rely on
 * up-to-date RLS policies and tables.
 *
 * We compare against drizzle's stored hash rather than computing our own
 * marker so the check stays compatible with future drizzle versions and
 * automatically tracks changes to `_journal.json` too.
 */
async function detectSchemaDrift(target: DriftTarget): Promise<boolean> {
  const journalPath = join(MIGRATIONS_DIR, "meta/_journal.json")
  let journal: { entries: Array<{ tag: string }> }
  try {
    journal = JSON.parse(readFileSync(journalPath, "utf-8"))
  } catch {
    return false // No migrations folder yet — nothing to compare.
  }

  // Hash every .sql file under migrations/ in stable filename order. Drizzle
  // uses a per-migration sha256 in its journal; we hash the concatenated
  // contents for a simple "did anything change?" probe.
  const sqlFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
  const hasher = createHash("sha256")
  for (const f of sqlFiles) {
    hasher.update(readFileSync(join(MIGRATIONS_DIR, f)))
  }
  const localHash = hasher.digest("hex")

  // Query drizzle's migration table. The schema lives under `drizzle.` and is
  // owned by the superuser — fall back to the postgres role.
  try {
    const dsn = target.dsn
    const lookup = spawnSync(
      "psql",
      [dsn, "-tA", "-c", "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1"],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: PSQL_LOOKUP_TIMEOUT_MS,
        env: { ...process.env, PGCONNECT_TIMEOUT: "2" },
      },
    )
    if (lookup.status !== 0) return false // Can't probe → assume in sync; reset on demand.
    const recordedHash = lookup.stdout.trim()
    if (!recordedHash) return true // Migrations never applied → reset will run them.
    return recordedHash !== expectedDrizzleHashFromJournal(journal, localHash)
  } catch {
    return false
  }
}

/**
 * Compute the hash drizzle expects in `__drizzle_migrations.hash`. Drizzle
 * stores the sha256 of each individual migration's SQL content (not the
 * concatenation), keyed by the journal entry order. Since this codebase ships
 * a single squashed migration, we hash that one file directly — same as what
 * drizzle would record on first apply.
 */
function expectedDrizzleHashFromJournal(
  journal: { entries: Array<{ tag: string }> },
  fallback: string,
): string {
  const latest = journal.entries[journal.entries.length - 1]
  if (!latest) return fallback
  try {
    const sql = readFileSync(join(MIGRATIONS_DIR, `${latest.tag}.sql`), "utf-8")
    return createHash("sha256").update(sql).digest("hex")
  } catch {
    return fallback
  }
}

/**
 * Reset the drifted database through db-reset, telling it which database was probed: db-reset
 * resolves its own target from the same env and refuses to drop anything else.
 */
async function runDbReset(target: "dev" | "test", dbName: string): Promise<void> {
  const script = target === "test" ? "db:reset:test" : "db:reset"
  const result = spawnSync("bun", ["run", script], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: DB_RESET_TIMEOUT_MS,
    env: { ...process.env, [RESET_EXPECT_DB_VAR]: dbName },
  })
  if (result.status !== 0) {
    throw new Error(
      `Schema drift auto-reset of ${dbName} failed (${script}, exit ${result.status}): ${result.stderr}`,
    )
  }
}
