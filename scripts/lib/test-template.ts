// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Template databases for test runs.
//
// A suite that needs a clean substrate used to DROP the shared liaison_test and
// replay every migration (about 200 of them) before its first test, every run.
// Now the migrated schema is built ONCE per migration set, into
//
//     liaison_tpl_<hash of the migrations dir, the in-tree app manifests,
//                  the registration code + the recipe below>
//
// under a short build lock, and every run takes a copy of it:
//
//     DROP DATABASE IF EXISTS liaison_test_<ns> WITH (FORCE)
//     CREATE DATABASE liaison_test_<ns> TEMPLATE liaison_tpl_<hash>
//
// which is a file-level copy, not a replay. A namespace database carries the
// hash it was cloned from in its comment, so a suite that does not need a clean
// substrate reuses it as long as the migrations have not changed, and gets a
// fresh clone the moment they have.
//
// The recipe replicates scripts/db-reset.ts `test` (roles, the database grants,
// BYPASSRLS for the test role, then drizzle's migrator), then applies the
// in-tree apps' manifest schemas (apps/api/src/db/apply-app-schemas.ts). An
// app's tables and columns beyond its migrations come from its manifest when it
// registers; without that step a test reading one (app_tickets.inboxes
// .default_audience, the mail columns) passed or failed on whether an earlier
// test file had registered the apps in the same database. The step runs the
// registration itself, so the template's app schemas are exactly what an org's
// setup applies, and the manifests and the registration code are part of the
// key, so a change to either rebuilds the template.
//
// Opt-out: LIAISON_TEST_TEMPLATE_APP_SCHEMAS=0 builds (and clones) the
// migrations-only template instead, a separate key, for a run that has to see
// app registration start from the migrated shape.
//
// Database-level grants are not copied by CREATE DATABASE ... TEMPLATE, so they
// are re-applied on every clone.

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import postgres from "postgres"
import { APP_REGISTRATION_CODE_FILES } from "../../apps/api/src/modules/apps/registration-code-files"
import {
  TEST_REQUEST_LOGIN_PASSWORD,
  type TestCoordinates,
} from "../../packages/test-helpers/src/test-namespace"
import { acquireNamespaceLock } from "./test-lock"

/** Bump when the build recipe below changes, so every template is rebuilt. */
export const TEMPLATE_RECIPE_VERSION = "3"
export const TEMPLATE_PREFIX = "liaison_tpl_"
/**
 * Suites that re-clone the namespace database before they run (a fresh copy
 * of the template: the old copy is renamed aside and every connection to it is
 * terminated). While one of them prepares, the namespace database is briefly
 * missing, so nothing else in the namespace may be reading it at that moment
 * (scripts/test-gate.ts orders its lanes on this).
 */
export const CLEAN_SUBSTRATE_SUITES: ReadonlySet<string> = new Set([
  "e2e",
  "e2e-parallel",
  "playwright",
])
const ROLES_WITH_DB_GRANTS = [
  "liaison_app",
  "liaison_admin",
  "liaison_rls",
  "liaison_schema_admin",
  "liaison_request",
]

/** A template younger than this is never collected: a peer may be about to clone it. */
const GC_MIN_AGE_MS = 60 * 60 * 1000

type Log = (message: string) => void

function hashDir(h: ReturnType<typeof createHash>, dir: string, rel = ""): void {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir).sort()) {
    const abs = path.join(dir, name)
    const relName = rel ? `${rel}/${name}` : name
    if (statSync(abs).isDirectory()) hashDir(h, abs, relName)
    else if (!/\.test\.ts$/.test(name)) {
      // Test files sit next to the migrations; they change no schema.
      h.update(relName)
      h.update("\0")
      h.update(readFileSync(abs))
      h.update("\0")
    }
  }
}

/**
 * True unless LIAISON_TEST_TEMPLATE_APP_SCHEMAS=0: the template carries the
 * in-tree apps' manifest schemas on top of the migrations.
 */
export function templateAppSchemas(env: Record<string, string | undefined> = process.env): boolean {
  return env.LIAISON_TEST_TEMPLATE_APP_SCHEMAS !== "0"
}

/** The in-tree app roots registration discovers (discover-apps.ts), minus LIAISON_DEV_APP_ROOTS. */
const IN_TREE_APP_ROOTS = ["apps/api/src/apps", "apps/api/test-support/apps"]

/** Each in-tree app's manifest and descriptor: what its registered schema is derived from. */
function hashAppManifests(h: ReturnType<typeof createHash>, root: string): void {
  for (const rel of IN_TREE_APP_ROOTS) {
    const dir = path.join(root, rel)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir).sort()) {
      for (const file of ["app.manifest.json", "manifest-descriptor.ts"]) {
        const abs = path.join(dir, name, file)
        if (!existsSync(abs)) continue
        h.update(`${rel}/${name}/${file}\0`)
        h.update(readFileSync(abs))
        h.update("\0")
      }
    }
  }
  // The catalog app whose schema the template also applies (apply-app-schemas.ts).
  for (const rel of ["bundled-apps/api-connector/app.manifest.json"]) {
    const abs = path.join(root, rel)
    h.update(`${rel}\0`)
    if (existsSync(abs)) h.update(readFileSync(abs))
    h.update("\0")
  }
  for (const rel of [...APP_REGISTRATION_CODE_FILES, "db/apply-app-schemas.ts"]) {
    const abs = path.join(root, "apps/api/src", rel)
    h.update(`${rel}\0`)
    if (existsSync(abs)) h.update(readFileSync(abs))
    h.update("\0")
  }
}

/**
 * The template key: every migration file (names + bytes, recursively, the
 * journal included), the migrator entry point, the recipe version, and (unless
 * opted out) the in-tree app manifests and the registration code that turns them
 * into the app schemas.
 */
export function templateHash(
  root: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const h = createHash("sha256")
  h.update(`recipe:${TEMPLATE_RECIPE_VERSION}\0`)
  hashDir(h, path.join(root, "apps/api/src/db/migrations"))
  const migrator = path.join(root, "apps/api/src/db/migrate.ts")
  if (existsSync(migrator)) h.update(readFileSync(migrator))
  if (templateAppSchemas(env)) {
    h.update("app-schemas\0")
    hashAppManifests(h, root)
  } else {
    h.update("migrations-only\0")
  }
  return h.digest("hex").slice(0, 16)
}

export function templateName(hash: string): string {
  return `${TEMPLATE_PREFIX}${hash}`
}

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe database name: ${name}`)
  return name
}

/** A superuser connection to the maintenance database. */
function admin(c: TestCoordinates): ReturnType<typeof postgres> {
  return postgres(c.superuserUrl("postgres"), {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    onnotice: () => {},
  })
}

async function dbExists(sql: ReturnType<typeof postgres>, name: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM pg_database WHERE datname = ${name}`
  return rows.length > 0
}

async function dropDatabase(sql: ReturnType<typeof postgres>, name: string): Promise<void> {
  ident(name)
  // A template refuses DROP; clear the flag first. No-op on a plain database.
  if (await dbExists(sql, name)) {
    await sql.unsafe(`ALTER DATABASE ${name} WITH IS_TEMPLATE false`)
    await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  }
}

async function runMigrations(root: string, url: string, log: Log): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["bun", "src/db/migrate.ts"],
    cwd: path.join(root, "apps/api"),
    env: { ...process.env, MIGRATION_DATABASE_URL: url, NODE_ENV: "test" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`migrations failed on ${url} (exit ${code}):\n${(err || out).slice(-2000)}`)
  }
  log(`  migrations applied`)
}

/**
 * Registers the in-tree apps' schemas on the database (apply-app-schemas.ts),
 * connected as the tests connect (the app login over DATABASE_URL), so every
 * app schema and table is owned as a test's own registration would leave it.
 * Its Redis keys and Meili indexes go under a prefix of their own.
 */
async function applyAppSchemas(
  root: string,
  c: TestCoordinates,
  db: string,
  hash: string,
  log: Log,
): Promise<void> {
  const envFile = path.join(root, ".env.test")
  const prefix = `tplbuild_${hash}`
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: c.appUrl(db),
    DATABASE_REQUEST_PASSWORD: TEST_REQUEST_LOGIN_PASSWORD,
    DATABASE_URL_SUPERUSER: c.superuserUrl(db),
    MIGRATION_DATABASE_URL: c.superuserUrl(db),
    REDIS_PREFIX: `${prefix}:`,
    MEILI_INDEX_PREFIX: `${prefix}-`,
    // The template is the same for every checkout: no developer's extra app roots.
    LIAISON_DEV_APP_ROOTS: "",
  }
  const proc = Bun.spawn({
    cmd: [
      "bun",
      ...(existsSync(envFile) ? [`--env-file=${envFile}`] : []),
      "src/db/apply-app-schemas.ts",
    ],
    cwd: path.join(root, "apps/api"),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`app schemas failed on ${db} (exit ${code}):\n${(err || out).slice(-3000)}`)
  }
  const summary = out.split("\n").find((l) => l.startsWith("app schemas applied"))
  log(`  ${summary ?? "app schemas applied"}`)
}

/** Builds the template under a temporary name, then renames it into place. */
async function buildTemplate(
  root: string,
  c: TestCoordinates,
  name: string,
  hash: string,
  log: Log,
) {
  const building = ident(`${name}_build`)
  const sql = admin(c)
  try {
    await dropDatabase(sql, building)
    await sql.unsafe(`CREATE DATABASE ${building}`)
    // Cluster-level roles: created once, survive every drop (db-reset.ts recipe).
    await sql.unsafe(
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='liaison_app') THEN CREATE ROLE liaison_app LOGIN PASSWORD 'liaison_app'; END IF; END $$`,
    )
    await sql.unsafe(
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='liaison_rls') THEN CREATE ROLE liaison_rls NOBYPASSRLS; END IF; END $$`,
    )
    await sql.unsafe(`GRANT ALL ON DATABASE ${building} TO liaison_app`)
    // Role changes are cluster-wide and race other databases' writers ("tuple
    // concurrently updated"), so write only when the role is not already so.
    // Test clusters only: fixtures seed kernel tables over the bare app-role
    // connection, which has to bypass RLS (see scripts/db-reset.ts).
    await sql.unsafe(`DO $$ BEGIN
      IF NOT pg_has_role('liaison_app', 'liaison_rls', 'MEMBER') THEN GRANT liaison_rls TO liaison_app; END IF;
      IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'liaison_app') THEN ALTER ROLE liaison_app BYPASSRLS; END IF;
    END $$`)
  } finally {
    await sql.end({ timeout: 5 })
  }
  await runMigrations(root, c.superuserUrl(building), log)
  const sql2 = admin(c)
  try {
    // The request login (migration 0178 creates it NOLOGIN; a deployment's
    // migration step gives it LOGIN and its password). Cluster-wide, so only
    // when it cannot log in yet.
    await sql2.unsafe(`DO $$ BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'liaison_request' AND NOT rolcanlogin) THEN
        ALTER ROLE liaison_request LOGIN PASSWORD '${TEST_REQUEST_LOGIN_PASSWORD}';
      END IF;
    END $$`)
    // The app login connects to the database during the app schema step, the
    // way a test does: the grants a clone gets (cloneDatabase) are needed here too.
    const roles = await sql2<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles WHERE rolname IN ${sql2(ROLES_WITH_DB_GRANTS)}`
    for (const r of roles) {
      await sql2.unsafe(`GRANT ALL ON DATABASE ${building} TO ${ident(r.rolname)}`)
    }
  } finally {
    await sql2.end({ timeout: 5 })
  }
  if (templateAppSchemas()) await applyAppSchemas(root, c, building, hash, log)
  const sql3 = admin(c)
  try {
    // Nothing the app schema step opened may still hold the database.
    await sql3`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
               WHERE datname = ${building} AND pid <> pg_backend_pid()`
    await sql3.unsafe(`ALTER DATABASE ${building} RENAME TO ${ident(name)}`)
    // A template nobody can connect to can never be "in use by other users"
    // when a run clones it.
    await sql3.unsafe(`ALTER DATABASE ${name} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`)
  } finally {
    await sql3.end({ timeout: 5 })
  }
}

/**
 * Makes sure the template for the current migrations exists, building it under
 * a short machine-wide build lock if not. Returns its name.
 */
export async function ensureTemplate(opts: {
  root: string
  coords: TestCoordinates
  log?: Log
}): Promise<{ name: string; hash: string; built: boolean }> {
  const log = opts.log ?? ((m: string) => console.log(m))
  const hash = templateHash(opts.root)
  const name = templateName(hash)
  {
    const sql = admin(opts.coords)
    try {
      if (await dbExists(sql, name)) return { name, hash, built: false }
    } finally {
      await sql.end({ timeout: 5 })
    }
  }
  // The build lock reuses the namespace-lock machinery under a reserved name:
  // one builder per template on the machine, everyone else waits for it.
  const lock = await acquireNamespaceLock(`tpl_${hash}`, {
    cmd: "template build",
    installExitHandlers: true,
    logEveryMs: 15_000,
    log,
  })
  try {
    const sql = admin(opts.coords)
    try {
      if (await dbExists(sql, name)) return { name, hash, built: false }
    } finally {
      await sql.end({ timeout: 5 })
    }
    const t0 = Date.now()
    log(
      `▸ building template ${name} (migrations${templateAppSchemas() ? " or app manifests" : ""} changed, or first run)`,
    )
    await buildTemplate(opts.root, opts.coords, name, hash, log)
    log(`  template ${name} built in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    return { name, hash, built: true }
  } finally {
    lock.release()
  }
}

/** The template hash a namespace database was cloned from, or null. */
async function clonedFrom(sql: ReturnType<typeof postgres>, db: string): Promise<string | null> {
  const rows = await sql<{ d: string | null }[]>`
    SELECT shobj_description(oid, 'pg_database') AS d FROM pg_database WHERE datname = ${db}`
  const m = rows[0]?.d?.match(/template=([0-9a-f]+)/)
  return m ? m[1]! : null
}

/** DROP + CREATE ... TEMPLATE, then the database-level grants a copy does not carry. */
export async function cloneDatabase(opts: {
  coords: TestCoordinates
  template: { name: string; hash: string }
  dbName: string
}): Promise<void> {
  const db = ident(opts.dbName)
  const sql = admin(opts.coords)
  try {
    // DROP DATABASE forces a checkpoint and costs over a second; the copy itself
    // costs a tenth of that. Move the old copy aside instead and let
    // dropTrash() remove it once the tests are running (or finished).
    if (await dbExists(sql, db)) {
      await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                WHERE datname = ${db} AND pid <> pg_backend_pid()`
      const trash = ident(`${db}_trash_${Date.now().toString(36)}`)
      await sql.unsafe(`ALTER DATABASE ${db} RENAME TO ${trash}`)
    }
    await sql.unsafe(`CREATE DATABASE ${db} TEMPLATE ${ident(opts.template.name)}`)
    const roles = await sql<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles WHERE rolname IN ${sql(ROLES_WITH_DB_GRANTS)}`
    for (const r of roles) await sql.unsafe(`GRANT ALL ON DATABASE ${db} TO ${ident(r.rolname)}`)
    // A throwaway test database never needs a commit to wait for its WAL
    // flush: visibility is unchanged, only crash durability goes, and every
    // DDL-heavy fixture (worker schema clones above all) commits faster.
    await sql.unsafe(`ALTER DATABASE ${db} SET synchronous_commit = off`)
    await sql.unsafe(
      `COMMENT ON DATABASE ${db} IS 'liaison test db, template=${opts.template.hash}'`,
    )
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * Roles are cluster wide, and an older migration replayed on the way (a chain
 * cut at an earlier file) takes back any extra membership of the request login.
 * A checkout whose migrations make `liaison_request` a member of
 * `liaison_portal` gets that membership back before its tests run, so the
 * request pool can step into the portal role whatever ran last on this server.
 */
async function ensurePortalMembership(opts: {
  root: string
  coords: TestCoordinates
}): Promise<void> {
  const dir = path.join(opts.root, "apps/api/src/db/migrations")
  const wantsIt = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .some((f) => /GRANT liaison_portal TO/.test(readFileSync(path.join(dir, f), "utf8")))
  if (!wantsIt) return
  const sql = admin(opts.coords)
  try {
    await sql.unsafe(`DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_portal')
           AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liaison_request')
           AND NOT pg_has_role('liaison_request', 'liaison_portal', 'MEMBER') THEN
          GRANT liaison_portal TO liaison_request;
        END IF;
      END $$`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * Makes the namespace database ready: a fresh clone when `fresh` (the suites
 * that need a clean substrate) or when it is missing or was cloned from another
 * migration set; otherwise it is left as it is.
 */
export async function prepareNamespaceDb(opts: {
  root: string
  coords: TestCoordinates
  fresh: boolean
  log?: Log
}): Promise<{ action: "cloned" | "reused"; template: string; templateBuilt: boolean; ms: number }> {
  const t0 = Date.now()
  const log = opts.log ?? ((m: string) => console.log(m))
  const template = await ensureTemplate({ root: opts.root, coords: opts.coords, log })
  let current: string | null = null
  if (!opts.fresh) {
    const sql = admin(opts.coords)
    try {
      current = (await dbExists(sql, opts.coords.dbName))
        ? await clonedFrom(sql, opts.coords.dbName)
        : null
    } finally {
      await sql.end({ timeout: 5 })
    }
  }
  if (!opts.fresh && current === template.hash) {
    await ensurePortalMembership(opts)
    return {
      action: "reused",
      template: template.name,
      templateBuilt: template.built,
      ms: Date.now() - t0,
    }
  }
  await cloneDatabase({ coords: opts.coords, template, dbName: opts.coords.dbName })
  await ensurePortalMembership(opts)
  return {
    action: "cloned",
    template: template.name,
    templateBuilt: template.built,
    ms: Date.now() - t0,
  }
}

/**
 * Drops templates nobody needs: not the current one, not one any test database
 * was cloned from, not one younger than an hour (a peer may be about to clone
 * it), and never while any template build lock is held. Returns what it dropped.
 */
export async function collectOldTemplates(opts: {
  coords: TestCoordinates
  keepHash: string
  log?: Log
}): Promise<string[]> {
  const log = opts.log ?? (() => {})
  const sql = admin(opts.coords)
  const dropped: string[] = []
  try {
    const rows = await sql<{ datname: string; d: string | null; age_ms: number | null }[]>`
      SELECT datname,
             shobj_description(oid, 'pg_database') AS d,
             (EXTRACT(EPOCH FROM now() - (pg_stat_file('base/' || oid || '/PG_VERSION')).modification) * 1000)::float8 AS age_ms
      FROM pg_database
      WHERE datname LIKE 'liaison\\_%'`
    const referenced = new Set<string>([opts.keepHash])
    for (const r of rows) {
      const m = r.d?.match(/template=([0-9a-f]+)/)
      if (m) referenced.add(m[1]!)
    }
    for (const r of rows) {
      if (!r.datname.startsWith(TEMPLATE_PREFIX)) continue
      if (r.datname.endsWith("_build")) continue // a build in flight (or a dead one the next build drops)
      const hash = r.datname.slice(TEMPLATE_PREFIX.length)
      if (referenced.has(hash)) continue
      if (r.age_ms === null || r.age_ms < GC_MIN_AGE_MS) continue
      await dropDatabase(sql, r.datname)
      dropped.push(r.datname)
      log(`  dropped old template ${r.datname}`)
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
  return dropped
}

/** Terminates every other connection to a database (between suites of a `full` run). */
export async function terminateConnections(c: TestCoordinates, db: string): Promise<void> {
  const sql = admin(c)
  try {
    await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE datname = ${db} AND pid <> pg_backend_pid()`
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** Drops the copies cloneDatabase moved aside for this database. */
export async function dropTrash(c: TestCoordinates, db: string): Promise<number> {
  const sql = admin(c)
  try {
    const rows = await sql<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname LIKE ${`${db.replaceAll("_", "\\_")}\\_trash\\_%`}`
    for (const r of rows) await dropDatabase(sql, r.datname)
    return rows.length
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** Drops a database (unit shard cleanup). */
export async function dropTestDatabase(c: TestCoordinates, db: string): Promise<void> {
  const sql = admin(c)
  try {
    await dropDatabase(sql, db)
  } finally {
    await sql.end({ timeout: 5 })
  }
}
