// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The WARM POOL of pre-seeded visitor workspaces.
//
// WHY. A signup used to create its org and then seed the whole company world
// behind its response, one seed per visitor, all of them at once. A hundred
// people starting the demo in the same minute meant a hundred concurrent full
// seeds on one box, competing for CPU, database connections and locks. The
// pool turns that into a bounded number of seeds, ahead of demand:
//
//   FILL    a background job (`demo-pool-refill`, a BullMQ job scheduler, demo
//           mode only) keeps LIAISON_DEMO_POOL_SIZE orgs ready. It seeds up to
//           LIAISON_DEMO_SEED_CONCURRENCY - 1 of them at once (one slot stays
//           a visitor's), and a Redis lock keeps two processes from both
//           refilling. Every seed also takes a slot of the box-wide seeding
//           gate (demo-seed-gate.ts); while visitors wait for one, the refill
//           keeps only its share of them (a third). A failed seed backs
//           off exponentially and says so loudly (an error log with an alert
//           tag, and the pool status record).
//   CLAIM   a signup takes the OLDEST ready org in one transaction
//           (`SELECT ... FOR UPDATE SKIP LOCKED`, so two signups never get the
//           same org and neither waits on the other), and makes it the
//           visitor's: their marker with their expiry from now, their needs,
//           their locale, and the org's owner account renamed to them.
//   EMPTY   no ready org: the signup falls back to creating and seeding its
//           own org behind the response, as before but through the seeding
//           gate (a burst queues instead of seeding all at once), and a warn
//           line counts the misses so an operator can size the pool.
//
// STORAGE. The pool IS the demo marker (`organizations.settings.demo`): a
// pooled org is an ordinary visitor org whose marker carries `pool:
// "seeding"` or `pool: "ready"` and a null `expiresAt`. Postgres is where the
// demo state lives, so the claim's atomicity is a row lock on the org itself,
// not a second store that could disagree with it. A null expiry is what keeps
// the reaper away (it only reads orgs past a real expiry), and the reaper also
// skips any marker carrying `pool` outright.
//
// THE OWNER. The seeded world is attached to its owner by USER ID all the way
// down: their DMs with their agent, the routines they own, the threads and
// approvals they are joined to, their agent's memory. So a pooled org is seeded
// with a real owner account, created exactly the way the signup creates the
// visitor's (a generated login on the reserved undeliverable domain, a random
// password nobody sees), and the claim TRANSFORMS that account into the
// visitor's, in the claim's transaction: the row keeps its id, so every
// reference the seed wrote already points at the visitor, and only its display
// name changes. Nothing in the seed copies the owner's name into content. The
// owner's personal agent is the exception, because its handle comes from the
// name and can never change: the claim gives the visitor a new agent under
// their own handle and hands the placeholder agent's rows over to it
// (`handOverOwnerAgent`, below).
//
// NEEDS. A tailored seed differs per set of needs (installed apps, optional
// parts, scenario routines), and seven needs make 127 sets: one pool per set
// cannot stay warm. So every pooled org is seeded with EVERY need, the world a
// visitor who picks Everything gets, and the claim fits it to the visitor's
// picks with cheap row updates (`fitPooledWorldToNeeds`): the apps their picks
// do not need are turned Off, the same switch a tailored seed flips, and the
// support routine goes back Off unless they picked support.
//
// LOCALE. The seeded content is the same in every language; the locale only
// sets the org's default language, which the claim writes. One pool serves
// every locale.
//
// BUILD. A pooled org is seeded ahead of demand, so a deploy that changes the
// seed (a routine's prompt, its scopes, a tour's fixtures) would otherwise
// hand the next visitors worlds the OLD build seeded. Every pooled marker
// carries the build that seeded it (`build`, from LIAISON_VERSION), and the
// running build only claims and counts its own. The refill retires the others
// to the reaper, the same way it retires a failed seed. Without a build id
// (a local `dev` run) every pooled org is the running build's, as before.
//
// WORLD. Most deploys change nothing a seed writes, and retiring a full pool
// on every one of them leaves the next visitors seeding their own workspace
// while the pool refills. So a pooled marker also carries the WORLD it holds
// (`world`): one fingerprint of the database schema (the migration journal)
// and of the seed's own inputs (the seeder, the seed engine files the demo
// tier imports, its fixtures, the scenario tours and the demo world's data
// files). Seed engine files only other tiers import (lively, load) are not
// inputs: adding or changing one is not a new demo world. A pooled org another build seeded is still
// the running build's pool when its world is the running build's: claimed,
// counted, never retired. A different world, or a marker written before the
// fingerprint existed, is another build's world, retired as above. The
// fingerprint covers what the seed reads and writes, not the product services
// it calls through: a change to how those store a row that leaves the schema
// alone is not a new world. The fingerprint is over file CONTENTS only, never
// their paths: moving a seed file without changing it keeps the world, so a
// refactor that only moves code does not retire a ready pool.
//
// WORLDS. A box can run several demo worlds (LIAISON_DEMO_WORLDS, the
// companies of `DEMO_WORLDS`), and the pool keeps workspaces of each:
// LIAISON_DEMO_POOL_SIZES splits it, or LIAISON_DEMO_POOL_SIZE is shared
// evenly. Every pooled marker names its world (`worldId`; a marker without
// one is `products`), and a claim asks for one world and can only ever take
// an org of that world: the filter is in the claim's own `WHERE`, under the
// row lock. Each world has its own fingerprint: the shared inputs plus its own
// pack directories (`DEMO_WORLD_PACK_INPUTS`), never another world's, so a
// change to one world's pack retires that world's pool and keeps the others.
// A world whose story follows the calendar month (any but `products`) records
// the Paris month it was seeded in (`worldMonth`), and an org of last month is
// never handed out. Any pooled org older than LIAISON_DEMO_POOL_MAX_AGE_HOURS
// is refused too, and the refill retires both.

import crypto from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import {
  DEMO_DEFAULT_WORLD,
  DEMO_WORLD_NEEDS,
  DEMO_WORLDS,
  type DemoNeed,
  type DemoOrgMarker,
  type DemoWorldId,
  demoWorldIdOf,
  type ShippedLocale,
} from "@liaison/shared"
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { type Agent, agents } from "~/db/schema/kernel/agents"
import { users } from "~/db/schema/kernel/users"
import { schemaRef } from "~/db/schema-ref"
import { env, parseDemoPoolSizes } from "~/lib/env"
import { loadOrgSettingsFragment, rememberLoadOrg } from "~/lib/load-harness"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { isShuttingDown } from "~/lib/shutdown"
import { ensureBaseAgentTx } from "~/modules/agent/directory/base-agent"
import {
  insertPersonalAgentWithFreeHandle,
  personalAgentHandleFor,
} from "~/modules/agent/directory/personal-agent"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import {
  type DemoPoolState,
  demoPoolStateOf,
  invalidateDemoMarker,
  markOrgAsDemo,
  visitorMarker,
} from "~/modules/demo/demo-org"
import { STALE_PROVISIONING_MS, writeProvisioning } from "~/modules/demo/demo-provisioning"
import {
  releaseSeedSlot,
  type SeedLease,
  tryAcquireRefillSeedSlot,
} from "~/modules/demo/demo-seed-gate"
import { DEMO_COMPANY_NAME, seedDemoOrgData } from "~/modules/demo/demo-seeder"
import { zeroDemoOrgCredits } from "~/modules/demo/demo-spend"
import { demoWorldOrgName, enabledDemoWorlds } from "~/modules/demo/demo-worlds"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { storyClock } from "~/seed/worlds/story-clock"

const K = () => drizzleSql.raw(schemaRef("kernel"))

export { type DemoPoolState, demoPoolStateOf }

const log = rootLogger.child({ module: "demo-pool" })

/**
 * The reserved domain every visitor account's login lives on. `.invalid` is
 * reserved by RFC 2606 and can never resolve, so nothing addressed to one of
 * these accounts can ever be delivered, and no real account can hold one.
 */
export const DEMO_INTERNAL_LOGIN_DOMAIN = "visitor.demo.invalid"

/**
 * The generated login of one visitor account. Random, so it identifies nothing
 * and cannot be typed by anyone else; the visitor never sees or needs it (their
 * session comes back on the signup response).
 */
export function demoInternalLogin(): string {
  return `visitor-${crypto.randomBytes(12).toString("hex")}@${DEMO_INTERNAL_LOGIN_DOMAIN}`
}

/**
 * A url-safe, collision-resistant slug for a new visitor org. Derived from the
 * caller's name so an operator reading the org list recognises it, with a random
 * suffix doing the actual uniqueness work: two visitors typing "Acme" must not
 * race for one slug, and `ensureOrg` treats a slug it already knows as an
 * UPDATE, which would hand the second visitor the first one's workspace.
 */
export function demoOrgSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
  return `demo-${base || "workspace"}-${crypto.randomBytes(6).toString("hex")}`
}

/**
 * The display name a pooled org's owner account carries until a visitor
 * claims it. The claim renames the account and gives the visitor an agent of
 * their own handle (`handOverOwnerAgent`), so nobody ever sees this name.
 */
export const DEMO_POOL_OWNER_NAME = "Unclaimed"

/** The language a pooled org is seeded in; the claim writes the visitor's. */
const POOL_SEED_LOCALE: ShippedLocale = "en"

/**
 * The build that seeds and claims pooled orgs: the release or commit the image
 * was built from (LIAISON_VERSION), or null for a local run without one.
 */
export function demoPoolBuildId(): string | null {
  const version = env.LIAISON_VERSION.trim()
  return version && version !== "dev" ? version : null
}

/** Test pins of the world fingerprint: one per world, and one for every world. */
const worldOverrides = new Map<DemoWorldId, string>()
let worldOverrideDefault: string | null = null

/** The repository root, which the world inputs below are relative to. */
const REPO_ROOT = path.resolve(import.meta.dir, "../../../../..")

/**
 * What a pooled world is made of, relative to the repository root: the schema
 * (the migration journal names every migration the build applies) and every
 * demo module the seed reads its content from (`demo-world-inputs.test.ts`
 * fails when the demo tier reaches one this list leaves out). A directory
 * counts all of its files but tests. The seed engine's files are added by
 * `demoTierSeedFiles`: the ones the demo tier imports, not the whole engine.
 */
export const DEMO_WORLD_INPUTS = [
  "apps/api/src/db/migrations/meta/_journal.json",
  "packages/shared/src/demo",
  "packages/shared/src/tours/demo",
  "packages/shared/src/i18n/locales/en/tours.json",
  "packages/shared/src/i18n/locales/fr/tours.json",
  "apps/api/src/modules/demo/world",
  "apps/api/src/modules/demo/warehouse",
  "apps/api/src/modules/demo/shopify",
  "apps/api/src/modules/demo/boxtal",
  "apps/api/src/modules/demo/api-connector",
  "apps/api/src/modules/demo/replay",
  "apps/api/src/modules/demo/demo-seeder.ts",
  "apps/api/src/modules/demo/demo-pool.ts",
] as const

/**
 * Each world's own pack: directories only that world's seed reads. A world's
 * fingerprint hashes its own and skips every other world's, wherever they sit
 * (under a shared input like `tours/demo`, or reached by the seed's imports),
 * so an edit to one world's pack retires only that world's pool. A directory
 * that does not exist yet holds nothing. `products` has none: its files are
 * where they always were and count as shared.
 */
export const DEMO_WORLD_PACK_INPUTS: Readonly<Record<DemoWorldId, readonly string[]>> = {
  products: [],
  saas: [
    "apps/api/src/seed/worlds/saas",
    "apps/api/src/modules/demo/worlds/saas",
    "packages/shared/src/tours/demo/worlds/saas",
    "apps/api/src/seed/factories/payments",
  ],
  studio: [
    "apps/api/src/seed/worlds/studio",
    "apps/api/src/modules/demo/worlds/studio",
    "packages/shared/src/tours/demo/worlds/studio",
  ],
}

function isUnder(rel: string, dir: string): boolean {
  return rel === dir || rel.startsWith(`${dir}/`)
}

/** Is `rel` in the pack of a world other than `worldId`? */
export function isOtherWorldPackFile(rel: string, worldId: DemoWorldId): boolean {
  return DEMO_WORLDS.some(
    (other) => other !== worldId && DEMO_WORLD_PACK_INPUTS[other].some((dir) => isUnder(rel, dir)),
  )
}

function isTestFile(name: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) || name.includes(".test-fixtures.")
}

/** Every file under `rel` but tests (or `rel` itself, a file), or null when there is none. */
function listRepoFiles(rel: string): string[] | null {
  const abs = path.join(REPO_ROOT, rel)
  const stat = statSync(abs, { throwIfNoEntry: false })
  if (!stat) return null
  if (stat.isFile()) return [rel]
  const out: string[] = []
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const child = path.posix.join(rel, entry.name)
    if (entry.isDirectory()) out.push(...(listRepoFiles(child) ?? []))
    else if (entry.isFile() && !isTestFile(entry.name)) out.push(child)
  }
  return out
}

/** The worlds' fingerprints, computed once each (null: an input is missing). */
const computedWorlds = new Map<DemoWorldId, string | null>()

/** The demo tier's entry: what the signup, the warm pool and the reset seed through. */
export const DEMO_TIER_ENTRY = "apps/api/src/seed/tiers/demo/seed-demo.ts"
const SEED_ROOT = "apps/api/src/seed/"
const API_SRC = "apps/api/src"

/** How the closure reads the tree: a file's source, or null when there is no such file. */
export type SourceReader = (rel: string) => string | null

/**
 * The tree a world's files are listed and read from: the repository, or a
 * test's fake. `list` gives every file under a path but tests (the path itself
 * for a file), or null when nothing is there.
 */
export interface DemoSourceTree {
  read: SourceReader
  list: (rel: string) => string[] | null
}

function readRepoSource(rel: string): string | null {
  // Read at once, no check first: the answer is the file as read, or null when no file is there.
  try {
    return readFileSync(path.join(REPO_ROOT, rel), "utf8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return null
    throw err
  }
}

const REPO_TREE: DemoSourceTree = { read: readRepoSource, list: listRepoFiles }

/** Import and re-export specifiers, static and dynamic. */
const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g

/** The repository-relative file `spec` names from `from`, or null for a package or no file. */
export function resolveSourceImport(from: string, spec: string, read: SourceReader): string | null {
  let base: string
  if (spec.startsWith("~/")) base = path.posix.join(API_SRC, spec.slice(2))
  else if (spec.startsWith(".")) base = path.posix.join(path.posix.dirname(from), spec)
  else return null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (read(candidate) !== null) return candidate
  }
  return null
}

/**
 * The seed engine files `worldId`'s demo tier is made of: every file under
 * `apps/api/src/seed/` reached by imports from the tier's entry and from
 * `roots` (the other world inputs, which import the engine too), followed
 * through engine files transitively. Test files are never inputs, and neither
 * is another world's pack: the seed reaches every pack through the pack
 * registry, but only seeds the one world.
 */
export function demoTierSeedFiles(
  roots: readonly string[],
  read: SourceReader,
  worldId: DemoWorldId,
): string[] {
  const found = new Set<string>([DEMO_TIER_ENTRY])
  const queue = [DEMO_TIER_ENTRY, ...roots.filter((r) => /\.tsx?$/.test(r))]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    const src = read(file)
    if (src === null) throw new Error(`demo world input missing: ${file}`)
    for (const match of src.matchAll(IMPORT_SPEC)) {
      const target = resolveSourceImport(file, match[1] as string, read)
      if (!target?.startsWith(SEED_ROOT) || isTestFile(path.posix.basename(target))) continue
      if (isOtherWorldPackFile(target, worldId)) continue
      if (!found.has(target)) {
        found.add(target)
        queue.push(target)
      }
    }
  }
  return [...found].sort()
}

/**
 * The files `worldId`'s fingerprint hashes, repository-relative and sorted:
 * what `DEMO_WORLD_INPUTS` names, its own pack directories, and the demo
 * tier's seed engine files that world reaches; never a file of another
 * world's pack. Throws when a shared input is missing.
 */
export function demoWorldFiles(worldId: DemoWorldId, tree: DemoSourceTree = REPO_TREE): string[] {
  const files: string[] = []
  for (const rel of DEMO_WORLD_INPUTS) {
    const listed = tree.list(rel)
    if (!listed) throw new Error(`demo world input missing: ${rel}`)
    files.push(...listed.filter((f) => !isOtherWorldPackFile(f, worldId)))
  }
  for (const rel of DEMO_WORLD_PACK_INPUTS[worldId]) files.push(...(tree.list(rel) ?? []))
  return [...new Set([...files, ...demoTierSeedFiles(files, tree.read, worldId)])].sort()
}

/**
 * `worldId`'s fingerprint over `tree`: its files' contents plus the world's
 * id, so two worlds never share one even while their files are the same.
 */
export function demoWorldFingerprintOf(
  worldId: DemoWorldId,
  tree: DemoSourceTree = REPO_TREE,
): string {
  const contents = demoWorldFiles(worldId, tree).map((rel) => {
    const src = tree === REPO_TREE ? readFileSync(path.join(REPO_ROOT, rel)) : tree.read(rel)
    if (src === null) throw new Error(`demo world input missing: ${rel}`)
    return typeof src === "string" ? Buffer.from(src) : src
  })
  return worldFingerprint([...contents, Buffer.from(`demo-world:${worldId}`)])
}

/**
 * A fingerprint of file contents alone: the SHA-256 of the sorted SHA-256 of
 * each, so neither a file's path nor the order it was read in counts.
 */
export function worldFingerprint(contents: readonly Uint8Array[]): string {
  const digests = contents.map((c) => crypto.createHash("sha256").update(c).digest("hex")).sort()
  const hash = crypto.createHash("sha256")
  for (const digest of digests) hash.update(digest)
  return hash.digest("hex").slice(0, 32)
}

/**
 * `worldId`'s fingerprint in the running build: a SHA-256 over the sorted
 * SHA-256 of every input's bytes (contents only, so a moved file keeps the
 * world), or null when an input is missing (a checkout that cannot seed has no
 * world to share, so only its build id counts). Computed once per world.
 */
export function demoPoolWorld(worldId: DemoWorldId): string | null {
  const pinned = worldOverrides.get(worldId) ?? worldOverrideDefault
  if (pinned !== null) return pinned
  const known = computedWorlds.get(worldId)
  if (known !== undefined) return known
  let computed: string | null
  try {
    computed = demoWorldFingerprintOf(worldId)
  } catch (err) {
    log.warn(
      { err, worldId },
      "demo pool: no world fingerprint; only the build id matches pooled orgs",
    )
    computed = null
  }
  computedWorlds.set(worldId, computed)
  return computed
}

/**
 * The Paris month a pooled org of `worldId` seeded at `at` holds, `YYYY-MM`,
 * or null for a world whose story does not follow the month (`products`).
 */
export function demoWorldMonth(worldId: DemoWorldId, at: Date): string | null {
  return worldId === DEMO_DEFAULT_WORLD ? null : storyClock(at).monthKey()
}

/** When this process started: pooled orgs of another build seeded before it are stale. */
const PROCESS_STARTED_AT = Date.now()

/**
 * A pooled org's marker: a visitor org with no expiry until it is claimed, of
 * one world (`worldId`, and for a world that follows the month, the Paris
 * month it was seeded in).
 */
export function pooledMarker(
  state: DemoPoolState,
  createdAt: Date,
  build: string | null,
  world: string | null,
  run: string | null,
  worldId: DemoWorldId,
): DemoOrgMarker {
  const worldMonth = demoWorldMonth(worldId, createdAt)
  return {
    variant: "visitor",
    createdAt: createdAt.toISOString(),
    expiresAt: null,
    pool: state,
    ...(build ? { build } : {}),
    ...(world ? { world } : {}),
    ...(run ? { run } : {}),
    worldId,
    ...(worldMonth ? { worldMonth } : {}),
  }
}

/**
 * Does this pooled org hold the running build's world? Always without a build
 * id; otherwise when the running build seeded it, or another build seeded the
 * same world (see WORLD in the header).
 */
function isCurrentWorld(
  row: { build: string | null; world: string | null },
  current: { build: string | null; world: string | null },
): boolean {
  if (current.build === null || row.build === current.build) return true
  return current.world !== null && row.world === current.world
}

function runningWorld(worldId: DemoWorldId): { build: string | null; world: string | null } {
  return { build: demoPoolBuildId(), world: demoPoolWorld(worldId) }
}

/** The oldest a ready pooled org may be when it is claimed, in milliseconds. */
function maxPooledAgeMs(): number {
  return env.LIAISON_DEMO_POOL_MAX_AGE_HOURS * 3600_000
}

/**
 * How many ready workspaces the pool keeps of each world: LIAISON_DEMO_POOL_SIZES
 * when set, else LIAISON_DEMO_POOL_SIZE split evenly over the enabled worlds,
 * the remainder going in `DEMO_WORLDS` order. A world the box does not run
 * keeps none.
 */
export function demoPoolTargets(): Record<DemoWorldId, number> {
  const targets: Record<DemoWorldId, number> = { products: 0, saas: 0, studio: 0 }
  const enabled = enabledDemoWorlds()
  const sizes = parseDemoPoolSizes(env.LIAISON_DEMO_POOL_SIZES) ?? {}
  if (Object.keys(sizes).length > 0) {
    for (const id of enabled) targets[id] = sizes[id] ?? 0
    return targets
  }
  const total = env.LIAISON_DEMO_POOL_SIZE
  const base = Math.floor(total / enabled.length)
  const rest = total % enabled.length
  enabled.forEach((id, i) => {
    targets[id] = base + (i < rest ? 1 : 0)
  })
  return targets
}

function totalTarget(targets: Record<DemoWorldId, number>): number {
  return DEMO_WORLDS.reduce((sum, id) => sum + targets[id], 0)
}

/** Is the pool switched on for this process? */
export function isDemoPoolEnabled(): boolean {
  return isDemoModeEnabled() && totalTarget(demoPoolTargets()) > 0
}

// ── Making a visitor org's shell ────────────────────────────────────────────

export interface VisitorOrgShell {
  orgId: string
  userId: string
  login: string
  password: string
}

/**
 * The part of a visitor org a person cannot use the product without: the org,
 * its demo marker, the admin account and the agent surface. Shared by the
 * signup's own path and the pool, so a pooled org is built exactly like the
 * one a signup would have built.
 */
export async function createVisitorOrgShell(input: {
  slug: string
  locale: ShippedLocale
  marker: DemoOrgMarker
  ownerName: string
  /** The fictional company's name for the workspace; absent, the default world's. */
  orgName?: string
  /** A load-harness start: the org is flagged with its marker (lib/load-harness.ts). */
  loadHarness?: boolean
}): Promise<VisitorOrgShell> {
  // The workspace's NAME is the fictional company's, never the caller's.
  const { orgId } = await ensureOrg({
    slug: input.slug,
    name: input.orgName ?? DEMO_COMPANY_NAME,
    locale: input.locale,
  })
  // MARK NEXT, before anything can act as this org: every restriction demo
  // mode applies is keyed on this marker.
  await markOrgAsDemo(orgId, input.marker, { loadHarness: input.loadHarness === true })
  // The admin, on a GENERATED login (routes.ts header note). The password is
  // random and never shown, and it is handed to the seeder as the org's owner
  // so the world is attached to THIS account rather than to a persona.
  const password = crypto.randomBytes(24).toString("base64url")
  const login = demoInternalLogin()
  const { userId } = await ensureUser({
    orgId,
    email: login,
    name: input.ownerName,
    password,
    role: "admin",
  })
  // `@base`, ensured again for an org the seeder created first.
  await withSystemDb("demo-org-agents", (tx) => ensureBaseAgentTx(tx, orgId))
  return { orgId, userId, login, password }
}

// ── Refill ──────────────────────────────────────────────────────────────────

const REFILL_LOCK_KEY = "demo:pool:refill-lock"
/** One backoff record per world (`<key>:<worldId>`): a failing world backs off alone. */
const BACKOFF_KEY = "demo:pool:backoff"
const STATUS_KEY = "demo:pool:status"
const EMPTY_COUNT_KEY = "demo:pool:empty-claims"

/**
 * The refill lock's lease TTL. Its live holder renews it every third of that
 * while the run lasts, so a run killed with its process (a deploy swaps every
 * process at once) frees the lock within one lease, not a seed's whole
 * deadline: a lock left for the deadline kept the new build's pool from
 * refilling for a quarter of an hour after every deploy.
 */
let refillLockTtlMs = 30_000
/** First retry after a failed seed, doubled per consecutive failure. */
const BACKOFF_BASE_MS = 30_000
const BACKOFF_MAX_MS = 30 * 60_000

export interface DemoPoolWorldDepth {
  ready: number
  seeding: number
}

export interface DemoPoolDepth extends DemoPoolWorldDepth {
  /** The same counts for each world the box runs. */
  worlds: Partial<Record<DemoWorldId, DemoPoolWorldDepth>>
}

/**
 * Why a ready pooled org can no longer be handed out, or null when it can:
 * older than LIAISON_DEMO_POOL_MAX_AGE_HOURS, or seeded in another Paris
 * month than this one for a world that follows the month. The claim's
 * `WHERE` applies the same two rules.
 */
function expiredReason(row: PooledRow, nowMs: number): "age" | "month" | null {
  const at = Date.parse(row.createdAt)
  if (!Number.isFinite(at) || nowMs - at > maxPooledAgeMs()) return "age"
  const month = demoWorldMonth(row.worldId, new Date(nowMs))
  if (month !== null && row.worldMonth !== month) return "month"
  return null
}

/**
 * How many pooled orgs of the running build are ready, and how many are being
 * seeded, in total and per enabled world. Another build's pooled orgs, a world
 * the box does not run, and ready orgs too old to hand out are not the pool:
 * the refill retires them.
 */
export async function demoPoolDepth(now: number = Date.now()): Promise<DemoPoolDepth> {
  const enabled = enabledDemoWorlds()
  const worlds: Partial<Record<DemoWorldId, DemoPoolWorldDepth>> = {}
  for (const id of enabled) worlds[id] = { ready: 0, seeding: 0 }
  let ready = 0
  let seeding = 0
  for (const row of await pooledRows()) {
    const counts = worlds[row.worldId]
    if (!counts || !isCurrentWorld(row, runningWorld(row.worldId))) continue
    if (row.state === "ready") {
      if (expiredReason(row, now) !== null) continue
      counts.ready++
      ready++
    } else {
      counts.seeding++
      seeding++
    }
  }
  return { ready, seeding, worlds }
}

interface PooledRow {
  orgId: string
  state: DemoPoolState
  createdAt: string
  /** Its world; a marker without one is `products`. */
  worldId: DemoWorldId
  /** The Paris month it was seeded in, for a world that follows the month. */
  worldMonth: string | null
  /** The build that seeded it, or null for a marker written without one. */
  build: string | null
  /** The world fingerprint it was seeded from, or null for a marker without one. */
  world: string | null
  /** The refill run (its lock token) seeding it, or null for a marker without one. */
  run: string | null
}

async function pooledRows(): Promise<PooledRow[]> {
  const k = drizzleSql.raw(schemaRef("kernel"))
  const rows = await withSystemDb("demo-pool-depth", async (tx) =>
    rowsOf(
      await tx.execute(drizzleSql`
        SELECT id, settings->'demo' AS demo FROM ${k}.organizations
        WHERE settings->'demo'->>'pool' IN ('seeding', 'ready')
        ORDER BY created_at ASC`),
    ),
  )
  const out: PooledRow[] = []
  for (const row of rows) {
    const demo = typeof row.demo === "string" ? JSON.parse(row.demo) : row.demo
    const state = demoPoolStateOf(demo)
    if (!state) continue
    out.push({
      orgId: String(row.id),
      state,
      createdAt: String(demo?.createdAt ?? ""),
      worldId: demoWorldIdOf(demo?.worldId),
      worldMonth: typeof demo?.worldMonth === "string" ? demo.worldMonth : null,
      build: typeof demo?.build === "string" ? demo.build : null,
      world: typeof demo?.world === "string" ? demo.world : null,
      run: typeof demo?.run === "string" ? demo.run : null,
    })
  }
  return out
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<
    Record<string, unknown>
  >
}

/**
 * Hand a pooled org to the reaper: an expired visitor marker, no `pool`. Used
 * for a seed that failed and for a seed a dead process left half done, so a
 * broken org is never claimed and never squats a pool slot.
 *
 * Only while the org is still pooled: the caller read its row earlier, and in
 * between another process may have claimed it for a visitor. A claimed org
 * keeps the visitor's marker, so the reaper never takes their workspace.
 * Returns whether the org was retired.
 */
async function retirePooledOrg(orgId: string): Promise<boolean> {
  const retired = visitorMarker(1, new Date(Date.now() - 2 * 3600_000))
  const k = drizzleSql.raw(schemaRef("kernel"))
  const rows = await withSystemDb("demo-pool-retire", async (tx) =>
    rowsOf(
      await tx.execute(drizzleSql`
        UPDATE ${k}.organizations
        SET settings = jsonb_set(settings, '{demo}', ${JSON.stringify(retired)}::jsonb),
          updated_at = now()
        WHERE id = ${orgId}::uuid AND settings->'demo'->>'pool' IN ('seeding', 'ready')
        RETURNING id`),
    ),
  )
  if (rows.length === 0) {
    log.warn({ orgId }, "demo pool: a workspace to retire is no longer pooled; left as it is")
    return false
  }
  await invalidateDemoMarker(orgId)
  return true
}

export interface DemoPoolRefillOutcome {
  /** Why nothing was seeded, when nothing was. */
  skipped?: "disabled" | "locked" | "backoff" | "busy"
  /** Orgs seeded into the pool by this run. */
  seeded: number
  /** Seeds that failed (a world stops at its first one and backs off). */
  failed: number
  /** The worlds this run seeded, in the order it started their seeds. */
  order: DemoWorldId[]
  depth: DemoPoolDepth
}

interface BackoffRecord {
  worldId: DemoWorldId
  failures: number
  notBefore: number
}

function backoffKey(worldId: DemoWorldId): string {
  return `${BACKOFF_KEY}:${worldId}`
}

async function readBackoff(worldId: DemoWorldId): Promise<BackoffRecord | null> {
  const raw = await redis.get(backoffKey(worldId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as BackoffRecord
  } catch {
    return null
  }
}

/**
 * The world the next pooled seed goes to: the one missing the largest share of
 * its target, ties in `DEMO_WORLDS` order, among the worlds still allowed to
 * seed. Null when none is short.
 */
export function nextWorldToSeed(
  targets: Record<DemoWorldId, number>,
  depth: DemoPoolDepth,
  allowed: (worldId: DemoWorldId) => boolean = () => true,
): DemoWorldId | null {
  let best: DemoWorldId | null = null
  let bestShare = 0
  for (const id of DEMO_WORLDS) {
    const target = targets[id]
    if (target <= 0 || !allowed(id)) continue
    const have = (depth.worlds[id]?.ready ?? 0) + (depth.worlds[id]?.seeding ?? 0)
    const share = (target - have) / target
    if (share > bestShare) {
      best = id
      bestShare = share
    }
  }
  return best
}

/**
 * The most pooled seeds one refill run keeps going at once: every seeding slot
 * of the box-wide gate but one, so a visitor who finds the pool empty never
 * waits a whole pooled seed for a slot (at concurrency 1, the one slot).
 */
export function demoPoolRefillParallelism(): number {
  return Math.max(1, env.LIAISON_DEMO_SEED_CONCURRENCY - 1)
}

/**
 * Top the pool up to each world's target (`demoPoolTargets`), with up to
 * `demoPoolRefillParallelism()` seeds at once, the world missing the largest
 * share first (`nextWorldToSeed`). Each seed holds a slot of the
 * box-wide gate; while visitors wait for one, the refill keeps only its share
 * of the slots (demo-seed-gate.ts, PRIORITY), so a burst that outruns seeding
 * still refills the pool instead of draining it until the burst ends. One seed at a time capped the refill at one seed's
 * length (3600 / seed seconds an hour), below a launch's signup rate however
 * many slots the gate had. Holds a Redis lock for the whole run, so a second
 * process (or a second job on this one) finds it held and returns at once: a
 * burst of claims never starts a second run. Re-reads the depth before every
 * seed it starts, so claims made while it runs are refilled by the same run.
 * Each seed's org row exists (as `seeding`) before the next depth read, so the
 * run never seeds past a target. Never throws on a failed seed: it records the
 * failure against that world, starts no further seed of it (the other worlds
 * go on), lets the ones running finish, and the next scheduler tick after that
 * world's backoff retries it.
 */
export async function refillDemoPool(now: () => number = Date.now): Promise<DemoPoolRefillOutcome> {
  const targets = demoPoolTargets()
  const size = totalTarget(targets)
  if (!isDemoModeEnabled() || size <= 0) {
    return {
      skipped: "disabled",
      seeded: 0,
      failed: 0,
      order: [],
      depth: { ready: 0, seeding: 0, worlds: {} },
    }
  }
  const backoffs = new Map<DemoWorldId, BackoffRecord>()
  for (const id of DEMO_WORLDS) {
    if (targets[id] <= 0) continue
    const record = await readBackoff(id)
    if (record && now() < record.notBefore) backoffs.set(id, record)
  }
  if (backoffs.size > 0) {
    // Every world short of its target is backing off: nothing to seed this tick.
    const depth = await demoPoolDepth(now())
    const short = DEMO_WORLDS.filter((id) => nextWorldToSeed(targets, depth, (w) => w === id))
    if (short.length > 0 && short.every((id) => backoffs.has(id))) {
      return { skipped: "backoff", seeded: 0, failed: 0, order: [], depth }
    }
  }
  const token = crypto.randomUUID()
  const locked = await redis.set(REFILL_LOCK_KEY, token, "PX", refillLockTtlMs, "NX")
  if (locked !== "OK") {
    return { skipped: "locked", seeded: 0, failed: 0, order: [], depth: await demoPoolDepth(now()) }
  }
  const renewal = renewRefillLock(token)
  let seeded = 0
  let failed = 0
  let started = 0
  let stop = false
  const order: DemoWorldId[] = []
  /** Worlds that failed in this run: no further seed of them until their backoff lapses. */
  const failedWorlds = new Set<DemoWorldId>()
  const running = new Set<Promise<void>>()

  /** One pooled seed under its gate lease; records its outcome, never throws. */
  const runOne = async (lease: SeedLease, shell: PooledShell): Promise<void> => {
    const { worldId } = shell
    let result: PooledSeedResult
    try {
      result = await seedPooledShell(shell)
    } catch (err) {
      result = {
        ok: false,
        orgId: shell.orgId,
        ms: Date.now() - shell.started,
        detail: err instanceof Error ? err.message : String(err),
      }
    } finally {
      await releaseSeedSlot(lease)
    }
    const after = await demoPoolDepth(now())
    if (result.ok) {
      seeded++
      await redis.del(backoffKey(worldId))
      await writePoolStatus({
        lastSeedAt: new Date().toISOString(),
        lastError: null,
        worldId,
        after,
      })
      // WARN on purpose: one line per refill that shows on a box running
      // LOG_LEVEL=warn, which is what an operator sizes the pool from.
      const own = after.worlds[worldId] ?? { ready: 0, seeding: 0 }
      log.warn(
        {
          orgId: result.orgId,
          worldId,
          seedMs: result.ms,
          ready: after.ready,
          seeding: after.seeding,
          worldReady: own.ready,
          worldTarget: targets[worldId],
          size,
          parallel: running.size,
        },
        `demo pool refill: seeded one ${worldId} workspace in ${result.ms} ms, ${own.ready}/${targets[worldId]} ready (${after.ready}/${size} in all)`,
      )
      return
    }
    failed++
    // One backoff step per world per run, however many of its seeds failed together.
    if (failedWorlds.has(worldId)) return
    failedWorlds.add(worldId)
    const failures =
      (backoffs.get(worldId)?.failures ?? (await readBackoff(worldId))?.failures ?? 0) + 1
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS)
    await redis.set(
      backoffKey(worldId),
      JSON.stringify({ worldId, failures, notBefore: now() + delay } satisfies BackoffRecord),
    )
    await writePoolStatus({
      lastSeedAt: new Date().toISOString(),
      lastError: result.detail ?? "seed failed",
      worldId,
      after,
    })
    log.error(
      {
        orgId: result.orgId,
        worldId,
        seedMs: result.ms,
        detail: result.detail,
        failures,
        retryInMs: delay,
        ready: after.ready,
        size,
        alert: "demo_pool_world_failing",
      },
      `demo pool refill: a pooled ${worldId} workspace failed to seed; that world backs off`,
    )
  }

  let busy = false
  try {
    await retireStalePooledOrgs(now(), token)
    const parallel = demoPoolRefillParallelism()
    for (;;) {
      // A process that is shutting down (the old build of a rolling deploy)
      // starts no further seed: it would hold a seeding slot and the refill
      // lock for a whole seed while its replacement waits to refill, and it
      // may be stopped before the seed is done. The seeds already running
      // finish, then the lock is released for the new build's refill.
      if (!stop && shuttingDown()) {
        stop = true
        log.warn(
          { started, running: running.size },
          "demo pool refill: this process is shutting down; no new seed, the next build refills",
        )
      }
      if (!stop && running.size < parallel) {
        const depth = await demoPoolDepth(now())
        const worldId = nextWorldToSeed(
          targets,
          depth,
          (id) => !backoffs.has(id) && !failedWorlds.has(id),
        )
        if (worldId) {
          // A seeding slot from the box-wide gate; while visitors wait for one,
          // only within the refill's share (demo-seed-gate.ts, PRIORITY).
          const lease = await tryAcquireRefillSeedSlot()
          if (lease) {
            try {
              const shell = await createPooledShell(token, worldId, new Date(now()))
              started++
              order.push(worldId)
              const task: Promise<void> = runOne(lease, shell).finally(() => running.delete(task))
              running.add(task)
            } catch (err) {
              // The shell could not be created: no seed holds this slot.
              await releaseSeedSlot(lease)
              throw err
            }
            continue
          }
          if (started === 0 && running.size === 0) busy = true
        }
      }
      // Nothing more to start now: wait for a running seed, or end the run.
      if (running.size === 0) break
      await Promise.race(running)
    }
  } finally {
    // A throw above (the shell's org could not be created) still lets the
    // seeds already running finish under the lock before it is released.
    if (running.size > 0) await Promise.allSettled([...running])
    clearInterval(renewal)
    await releaseRefillLock(token)
  }
  return {
    ...(busy ? { skipped: "busy" as const } : {}),
    seeded,
    failed,
    order,
    depth: await demoPoolDepth(now()),
  }
}

/** Keep this run's lock alive while it runs (compare and pexpire). */
function renewRefillLock(token: string): ReturnType<typeof setInterval> {
  const ttl = refillLockTtlMs
  const timer = setInterval(
    () => {
      redis
        .eval(
          `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`,
          1,
          REFILL_LOCK_KEY,
          token,
          String(ttl),
        )
        .catch((err) => log.warn({ err }, "demo pool refill lock renewal failed"))
    },
    Math.max(1, Math.floor(ttl / 3)),
  )
  timer.unref?.()
  return timer
}

/** Delete the lock only if this run still holds it (compare and delete). */
async function releaseRefillLock(token: string): Promise<void> {
  try {
    await redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      1,
      REFILL_LOCK_KEY,
      token,
    )
  } catch (err) {
    log.warn({ err }, "demo pool refill lock release failed; it lapses on its own")
  }
}

/**
 * Hand the reaper every pooled org that can never be claimed:
 *
 * - a `seeding` org of another refill run belongs to a run that is over: the
 *   refill lock is held by one run at a time, a live run renews it and waits
 *   for its own seeds before letting it go, and this run holds it now. So the
 *   seed died with its process (an out of memory kill, a deploy): nobody will
 *   ever mark it ready, and it counted toward the pool size, so the pool was
 *   short by every such shell. Collected at once, not after a seed's whole
 *   deadline (~16 min): a killed worker used to leave the pool short by its
 *   shells for that long. A `seeding` org without a run (written before the
 *   marker carried one) keeps the old rule: older than a seed's deadline;
 * - an org another build seeded (ready or seeding) holds that build's world,
 *   which the running build never hands out. Only one seeded before this
 *   process started, or older than a seed's deadline: while an old and a new
 *   process overlap during a deploy, the old one must not retire the new
 *   one's fresh seeds. The same holds for an org of a world this process
 *   does not run (a newer build may run it): one this box does not run any
 *   more retires once it is past that window;
 * - a ready org older than LIAISON_DEMO_POOL_MAX_AGE_HOURS, or of a world that
 *   follows the month seeded in another Paris month, is never handed out.
 */
async function retireStalePooledOrgs(nowMs: number, run: string): Promise<void> {
  const build = demoPoolBuildId()
  const enabled = new Set(enabledDemoWorlds())
  const otherBuild: PooledRow[] = []
  const expired: Array<{ orgId: string; worldId: DemoWorldId; reason: string }> = []
  for (const row of await pooledRows()) {
    const at = Date.parse(row.createdAt)
    const known = Number.isFinite(at)
    const deadRun = row.state === "seeding" && row.run !== null && row.run !== run
    const current = runningWorld(row.worldId)
    if (!enabled.has(row.worldId) || !isCurrentWorld(row, current)) {
      if (!deadRun && known && at >= PROCESS_STARTED_AT && nowMs - at <= STALE_PROVISIONING_MS) {
        continue
      }
      if (await retirePooledOrg(row.orgId)) otherBuild.push(row)
      continue
    }
    if (row.state === "ready") {
      const reason = expiredReason(row, nowMs)
      if (reason !== null) {
        if (await retirePooledOrg(row.orgId)) {
          expired.push({ orgId: row.orgId, worldId: row.worldId, reason })
        }
      }
      continue
    }
    if (!deadRun && (row.run === run || (known && nowMs - at <= STALE_PROVISIONING_MS))) continue
    log.error(
      {
        orgId: row.orgId,
        since: row.createdAt,
        ...(deadRun ? { run: row.run } : {}),
        alert: "demo_pool_seed_abandoned",
      },
      "demo pool: a pooled workspace was left half seeded; handing it to the reaper",
    )
    await retirePooledOrg(row.orgId)
  }
  if (otherBuild.length > 0) {
    log.warn(
      {
        build,
        retired: otherBuild.length,
        orgIds: otherBuild.map((r) => r.orgId),
        worldIds: [...new Set(otherBuild.map((r) => r.worldId))],
        builds: [...new Set(otherBuild.map((r) => r.build))],
        worlds: [...new Set(otherBuild.map((r) => r.world))],
      },
      `demo pool: retired ${otherBuild.length} pooled workspace(s) seeded by another build from another world, or of a world this box does not run`,
    )
  }
  if (expired.length > 0) {
    log.warn(
      { retired: expired.length, expired },
      `demo pool: retired ${expired.length} ready workspace(s) too old to hand out`,
    )
  }
}

interface DemoPoolStatus {
  lastSeedAt: string
  lastError: string | null
  /** The world of the seed this records. */
  worldId: DemoWorldId
  /** The depth after it, in total and per world. */
  after: DemoPoolDepth
}

async function writePoolStatus(status: DemoPoolStatus): Promise<void> {
  try {
    await redis.set(STATUS_KEY, JSON.stringify(status))
  } catch (err) {
    log.warn({ err }, "failed to record the demo pool status")
  }
}

/**
 * The last refill's outcome, for an operator: when, which world, what failed,
 * and the depth after in total and per world.
 */
export async function readDemoPoolStatus(): Promise<DemoPoolStatus | null> {
  const raw = await redis.get(STATUS_KEY)
  return raw ? (JSON.parse(raw) as DemoPoolStatus) : null
}

/** A pooled org's shell, created and marked `seeding`, not yet seeded. */
interface PooledShell extends VisitorOrgShell {
  slug: string
  worldId: DemoWorldId
  /** The refill clock's time when the shell was made: its marker's `createdAt` and month. */
  createdAt: Date
  started: number
  startedAt: string
}

interface PooledSeedResult {
  ok: boolean
  orgId: string
  ms: number
  detail?: string
}

/**
 * Create one pooled org's shell: it counts as `seeding` in the depth from here.
 * It carries the refill run's lock token, so the next run knows a shell its run
 * left behind is dead (retireStalePooledOrgs).
 */
async function createPooledShell(
  run: string,
  worldId: DemoWorldId,
  createdAt: Date,
): Promise<PooledShell> {
  const started = Date.now()
  const slug = demoOrgSlug("")
  const shell = await createVisitorOrgShell({
    slug,
    locale: POOL_SEED_LOCALE,
    marker: pooledMarker(
      "seeding",
      createdAt,
      demoPoolBuildId(),
      demoPoolWorld(worldId),
      run,
      worldId,
    ),
    ownerName: DEMO_POOL_OWNER_NAME,
    orgName: demoWorldOrgName(worldId),
  })
  const startedAt = new Date(started).toISOString()
  await writeProvisioning({ orgId: shell.orgId, state: "provisioning", startedAt })
  return { ...shell, slug, worldId, createdAt, started, startedAt }
}

/** Seed a pooled shell with its whole world, and mark it ready (or retire it). */
async function seedPooledShell(shell: PooledShell): Promise<PooledSeedResult> {
  const { slug, started, startedAt, worldId, createdAt } = shell
  let ok = false
  let detail: string | undefined
  try {
    const seed = await seedDemoOrgData({
      orgSlug: slug,
      orgName: demoWorldOrgName(worldId),
      worldId,
      variant: "visitor",
      locale: POOL_SEED_LOCALE,
      owner: { email: shell.login, name: DEMO_POOL_OWNER_NAME, password: shell.password },
      needs: [...DEMO_WORLD_NEEDS[worldId]],
    })
    ok = seed.ok
    detail = seed.detail
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err)
  }
  try {
    // Whatever the seed did or did not do, a demo workspace holds no money.
    await zeroDemoOrgCredits(shell.orgId)
  } catch (err) {
    log.error({ err, orgId: shell.orgId }, "failed to zero a pooled demo org's credits")
  }
  const finishedAt = new Date().toISOString()
  if (ok) {
    await markOrgAsDemo(
      shell.orgId,
      pooledMarker("ready", createdAt, demoPoolBuildId(), demoPoolWorld(worldId), null, worldId),
    )
    await writeProvisioning({ orgId: shell.orgId, state: "ready", startedAt, finishedAt })
  } else {
    // A failed pooled org is never handed out: a visitor who would get it gets
    // a fresh seed instead. The reaper collects it.
    await writeProvisioning({ orgId: shell.orgId, state: "failed", startedAt, finishedAt })
    await retirePooledOrg(shell.orgId)
  }
  return { ok, orgId: shell.orgId, ms: Date.now() - started, ...(detail ? { detail } : {}) }
}

// ── Claim ───────────────────────────────────────────────────────────────────

export interface ClaimedPooledOrg {
  orgId: string
  slug: string
  userId: string
  /** The visitor's own agent's handle (`@<first name>`). */
  agentHandle: string
  marker: DemoOrgMarker
  /** The world the org holds: always the one the claim asked for. */
  worldId: DemoWorldId
}

/**
 * Take the oldest ready pooled org of `worldId` the running build seeded and make it the visitor's, in ONE
 * transaction: the org row is locked `FOR UPDATE SKIP LOCKED`, so concurrent
 * claims each get a different org (or none) and never wait on each other. The
 * marker becomes the visitor's own (their needs, their expiry starting now,
 * the org's world kept), the org takes the visitor's language, and the owner
 * account the seed attached the world to takes the visitor's name. Null when
 * no org of that world can be handed out: never an org of another world, nor
 * one older than LIAISON_DEMO_POOL_MAX_AGE_HOURS, nor one of a world that
 * follows the month seeded in another Paris month.
 */
export async function claimPooledOrg(input: {
  /** The world the visitor's workspace must hold; an org of any other world is never handed out. */
  worldId: DemoWorldId
  name: string
  locale: ShippedLocale
  needs: readonly DemoNeed[]
  now?: Date
  /**
   * A signed load-harness start (spec A29): it takes a pooled workspace like a
   * visitor, so a stress run measures the pool. The claim marks it synthetic
   * and flags it as a load org in the same statement that hands it over.
   */
  synthetic?: boolean
  /**
   * The workspace's end, when it is not "a visitor TTL from now": a visitor
   * who starts over keeps the end their first workspace had (routes.ts,
   * START_OVER), so starting over never lengthens a demo.
   */
  expiresAt?: string
}): Promise<ClaimedPooledOrg | null> {
  const { worldId } = input
  if (!isDemoPoolEnabled() || !enabledDemoWorlds().includes(worldId)) return null
  const now = input.now ?? new Date()
  const fresh = visitorMarker(env.LIAISON_DEMO_VISITOR_TTL_HOURS, now, input.needs)
  const visitor = input.expiresAt ? { ...fresh, expiresAt: input.expiresAt } : fresh
  const loadFlag = input.synthetic ? loadOrgSettingsFragment() : {}
  const k = drizzleSql.raw(schemaRef("kernel"))
  // Only the asked world, and only the running build's fingerprint of it (see
  // WORLDS, BUILD and WORLD in the header). A marker without a world is the
  // default world's, as `demoWorldOf` reads it.
  const sameWorldId = drizzleSql`AND COALESCE(settings->'demo'->>'worldId', ${DEMO_DEFAULT_WORLD}) = ${worldId}`
  const { build, world } = runningWorld(worldId)
  const sameBuild = !build
    ? drizzleSql``
    : world
      ? drizzleSql`AND (settings->'demo'->>'build' = ${build} OR settings->'demo'->>'world' = ${world})`
      : drizzleSql`AND settings->'demo'->>'build' = ${build}`
  // Fresh enough: markers write `createdAt` with toISOString, which sorts as text.
  const oldest = new Date(now.getTime() - maxPooledAgeMs()).toISOString()
  const month = demoWorldMonth(worldId, now)
  const sameMonth =
    month === null ? drizzleSql`` : drizzleSql`AND settings->'demo'->>'worldMonth' = ${month}`
  for (;;) {
    let pickedId: string | null = null
    const claim = await withSystemDb("demo-pool-claim", async (tx) => {
      const picked = rowsOf(
        await tx.execute(drizzleSql`
          SELECT id, slug, settings->'demo'->>'worldMonth' AS world_month,
            COALESCE(settings->'demo'->>'worldId', ${DEMO_DEFAULT_WORLD}) AS world_id
          FROM ${k}.organizations
          WHERE settings->'demo'->>'pool' = 'ready' ${sameWorldId} ${sameBuild}
            AND settings->'demo'->>'createdAt' >= ${oldest} ${sameMonth}
          ORDER BY created_at ASC, id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`),
      )[0]
      if (!picked) return null
      const orgId = String(picked.id)
      pickedId = orgId
      // The visitor's marker keeps the org's world: what the pool seeded it
      // as, read from the row (the `WHERE` makes it the asked one).
      const pickedMonth = typeof picked.world_month === "string" ? picked.world_month : null
      const withWorld: DemoOrgMarker = {
        ...visitor,
        worldId: demoWorldIdOf(picked.world_id),
        ...(pickedMonth ? { worldMonth: pickedMonth } : {}),
      }
      const marker: DemoOrgMarker = input.synthetic ? { ...withWorld, synthetic: true } : withWorld
      const owners = rowsOf(
        await tx.execute(drizzleSql`
          UPDATE ${k}.users SET name = ${input.name}, updated_at = now()
          WHERE org_id = ${orgId}::uuid AND lower(email) LIKE ${`%@${DEMO_INTERNAL_LOGIN_DOMAIN}`}
          RETURNING id`),
      )
      if (owners.length !== 1) {
        // Not one owner account: not an org this claim can hand anybody. It
        // leaves the pool (for the reaper) and the claim takes the next one.
        const retired = visitorMarker(1, new Date(now.getTime() - 2 * 3600_000))
        await tx.execute(drizzleSql`
          UPDATE ${k}.organizations
          SET settings = jsonb_set(settings, '{demo}', ${JSON.stringify(retired)}::jsonb),
            updated_at = now()
          WHERE id = ${orgId}::uuid`)
        return { broken: orgId, owners: owners.length } as const
      }
      const userId = String(owners[0]?.id)
      // The visitor's OWN agent, under the handle their name gives it, with
      // everything the seed attached to the placeholder's agent handed over.
      const agent = await handOverOwnerAgent(tx, orgId, userId, input.name)
      await tx.execute(drizzleSql`
        UPDATE ${k}.organizations
        SET settings = jsonb_set(settings, '{demo}', ${JSON.stringify(marker)}::jsonb)
            || ${JSON.stringify(loadFlag)}::jsonb,
          default_locale = ${input.locale},
          updated_at = now()
        WHERE id = ${orgId}::uuid`)
      return { orgId, slug: String(picked.slug), userId, agentHandle: agent.handle, marker }
    }).catch(async (err: unknown) => {
      // A claim that could not complete rolled back whole. The org it picked
      // must not be picked again by every next signup: it leaves the pool for
      // the reaper, loudly, and the claim moves on to the next one.
      if (!pickedId) throw err
      log.error(
        { err, orgId: pickedId, alert: "demo_pool_claim_failed" },
        "demo pool: claiming a ready workspace failed; retired it",
      )
      await retirePooledOrg(pickedId)
      return { broken: pickedId, owners: -1 } as const
    })
    if (!claim) return null
    if ("broken" in claim) {
      await invalidateDemoMarker(claim.broken)
      log.error(
        { orgId: claim.broken, owners: claim.owners, alert: "demo_pool_org_broken" },
        "demo pool: a ready workspace has no single owner account; retired it",
      )
      continue
    }
    // The claim wrote straight to the row: every process re-reads the marker.
    await invalidateDemoMarker(claim.orgId)
    if (input.synthetic) rememberLoadOrg(claim.orgId)
    return { ...claim, worldId: demoWorldIdOf(claim.marker.worldId) }
  }
}

// ── The owner's agent ────────────────────────────────────────────────────────
//
// A personal agent's handle is derived from its owner's first name and can
// never change once written (0051_agents_handle_immutable.sql, a trigger that
// refuses every actor, privileged ones included). A pooled org is seeded before
// anyone knows the visitor's name, so the placeholder owner's agent carries the
// placeholder's handle. The claim does not rename it: it inserts the visitor's
// agent NEW, under the handle their name gives it (the same derivation and
// collision discriminator as at signup), hands every row that names the
// placeholder's agent over to it, and deletes the placeholder's agent, which
// no person has ever seen. Every row is re-pointed by a plain UPDATE the
// schema allows (checkpoint immutability covers a version's content, not its
// agent), all inside the claim's transaction: a claim that cannot hand
// everything over rolls back whole, and the delete of the old agent is the
// proof, since a reference left behind fails its foreign key.

/** Tables and uuid columns that can name an agent, read once from the catalog. */
let agentRefColumns: AgentRefColumn[] | null = null

interface AgentRefColumn {
  schema: string
  table: string
  column: string
  /** A text column holding ids of any kind (an audit entry's `entity_id`). */
  text: boolean
}

/**
 * Every column that can hold an agent id, in a table scoped by `org_id`: each
 * foreign key to kernel.agents, plus the uuid columns that name an agent
 * without one (`*agent_id`, an event's `actor_id`, `agent_allowed_by`), and
 * the text `entity_id` of an audit or timeline entry about the agent. A uuid equal to the old agent's id can
 * only ever be that agent, so re-pointing a match is always right. Read
 * from the catalog rather than listed here, so a table added later is handed
 * over without anyone remembering this file.
 */
async function agentReferenceColumns(tx: PrivilegedDb): Promise<AgentRefColumn[]> {
  if (agentRefColumns) return agentRefColumns
  const rows = rowsOf(
    await tx.execute(drizzleSql`
      SELECT n.nspname AS schema, c.relname AS "table", a.attname AS "column",
        format_type(a.atttypid, NULL) AS type
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND a.attnum > 0 AND NOT a.attisdropped
        AND (a.atttypid = 'uuid'::regtype OR (a.atttypid = 'text'::regtype AND a.attname = 'entity_id'))
        AND (n.nspname = 'kernel' OR n.nspname LIKE 'app\\_%')
        AND NOT (n.nspname = 'kernel' AND c.relname = 'agents')
        AND EXISTS (SELECT 1 FROM pg_attribute o
                    WHERE o.attrelid = c.oid AND o.attname = 'org_id' AND NOT o.attisdropped)
        AND (
          a.attname LIKE '%agent_id'
          OR a.attname IN ('actor_id', 'agent_allowed_by', 'entity_id')
          OR EXISTS (SELECT 1 FROM pg_constraint f
                     WHERE f.contype = 'f' AND f.conrelid = c.oid
                       AND f.confrelid = '${K()}.agents'::regclass
                       AND a.attnum = ANY (f.conkey))
        )
      ORDER BY 1, 2, 3`),
  )
  agentRefColumns = rows.map((r) => ({
    schema: String(r.schema),
    table: String(r.table),
    column: String(r.column),
    text: r.type === "text",
  }))
  return agentRefColumns
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/**
 * Give the claiming visitor their own personal agent and hand the
 * placeholder's agent's rows to it. Runs inside the claim's transaction.
 */
async function handOverOwnerAgent(
  tx: PrivilegedDb,
  orgId: string,
  userId: string,
  visitorName: string,
): Promise<{ id: string; handle: string }> {
  const owned = await tx
    .select()
    .from(agents)
    .where(
      and(eq(agents.orgId, orgId), eq(agents.ownerUserId, userId), eq(agents.kind, "personal")),
    )
  if (owned.length !== 1) {
    throw new Error(`demo pool: the pooled owner has ${owned.length} personal agents, not one`)
  }
  const old = owned[0] as Agent
  const [user] = await tx
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
  // Same derivation as signup (`ensureUser` passes the first word of the name).
  const baseHandle = personalAgentHandleFor({
    firstName: visitorName.split(" ")[0],
    email: user?.email ?? "",
  })
  const { id: _id, handle: _handle, createdAt: _created, updatedAt: _updated, ...carried } = old
  const fresh = await insertPersonalAgentWithFreeHandle(tx, baseHandle, {
    ...carried,
    orgId,
    ownerUserId: userId,
  })
  for (const ref of await agentReferenceColumns(tx)) {
    const target = drizzleSql.raw(`${quoteIdent(ref.schema)}.${quoteIdent(ref.table)}`)
    const column = drizzleSql.raw(quoteIdent(ref.column))
    await tx.execute(
      ref.text
        ? drizzleSql`
            UPDATE ${target} SET ${column} = ${fresh.id}
            WHERE org_id = ${orgId}::uuid AND ${column} = ${old.id}`
        : drizzleSql`
            UPDATE ${target} SET ${column} = ${fresh.id}::uuid
            WHERE org_id = ${orgId}::uuid AND ${column} = ${old.id}::uuid`,
    )
  }
  // Events the seed queued that the outbox has not delivered yet carry the
  // old id in their payload (an agent's message, say): they go out naming the
  // visitor's agent. Delivered events are history and stay as they were.
  const k = drizzleSql.raw(schemaRef("kernel"))
  await tx.execute(drizzleSql`
    UPDATE ${k}.pending_events
    SET payload = replace(payload::text, ${old.id}, ${fresh.id})::jsonb
    WHERE org_id = ${orgId}::uuid AND processed_at IS NULL
      AND payload::text LIKE ${`%${old.id}%`}`)
  // Nothing names it any more; a reference the hand-over missed fails here
  // on its foreign key and rolls the claim back.
  await tx.delete(agents).where(and(eq(agents.id, old.id), eq(agents.orgId, orgId)))
  return { id: fresh.id, handle: fresh.handle }
}

/**
 * Count a signup that found no workspace of its world in the pool, and say so
 * at WARN with the running count (in total and for that world), so an
 * operator reading a warn-level log can size each world's pool.
 */
export async function recordDemoPoolMiss(worldId: DemoWorldId): Promise<void> {
  let misses = 0
  let worldMisses = 0
  try {
    misses = await redis.incr(EMPTY_COUNT_KEY)
    worldMisses = await redis.incr(`${EMPTY_COUNT_KEY}:${worldId}`)
  } catch {
    // The count is a sizing hint; the warn line below is the signal.
  }
  log.warn(
    {
      worldId,
      poolSize: demoPoolTargets()[worldId],
      emptyClaims: misses,
      worldEmptyClaims: worldMisses,
      alert: "demo_pool_empty",
    },
    `demo pool empty for ${worldId}: this signup seeds its own workspace behind the response`,
  )
}

// ── Kick ────────────────────────────────────────────────────────────────────

type Kick = () => Promise<void>

/** Enqueue one refill run on the job queue the scheduler uses. */
const enqueueRefill: Kick = async () => {
  const { enqueueAppJob } = await import("~/infra/jobs/jobs")
  await enqueueAppJob("kernel", DEMO_POOL_REFILL_JOB, {})
}

let kick: Kick = enqueueRefill

/** The job name of a refill run, scheduled and kicked alike. */
export const DEMO_POOL_REFILL_JOB = "demo-pool-refill"
/** The scheduler's tick: every minute, which is also the backoff's resolution. */
export const DEMO_POOL_REFILL_CRON = "* * * * *"

/**
 * Ask for a refill now (after a claim). Never throws and never waits for the
 * seed: the run happens on the job worker, behind the lock, and a kick that
 * finds the lock held is a no-op because the holder re-reads the depth before
 * every seed. The scheduler's minute tick covers a kick that was lost.
 */
export async function kickDemoPoolRefill(): Promise<void> {
  if (!isDemoPoolEnabled()) return
  try {
    await kick()
  } catch (err) {
    log.warn({ err }, "demo pool refill could not be enqueued; the scheduler tick will do it")
  }
}

/** Test seams. */
/** Whether this process is shutting down (a test seam). */
let shuttingDown: () => boolean = isShuttingDown

export const DemoPoolTestAccess = {
  setShuttingDown(fn: (() => boolean) | null): void {
    shuttingDown = fn ?? isShuttingDown
  },
  setKick(fn: Kick | null): void {
    kick = fn ?? enqueueRefill
  },
  setRefillLockTtlMs(ms: number): void {
    refillLockTtlMs = ms
  },
  /**
   * Pin a world fingerprint (null: the one computed from this checkout): of
   * one world, or with no world, the default every unpinned world reads.
   */
  setWorld(world: string | null, worldId?: DemoWorldId): void {
    if (worldId === undefined) {
      worldOverrideDefault = world
      if (world === null) worldOverrides.clear()
    } else if (world === null) worldOverrides.delete(worldId)
    else worldOverrides.set(worldId, world)
  },
  keys: { REFILL_LOCK_KEY, BACKOFF_KEY, STATUS_KEY, EMPTY_COUNT_KEY, backoffKey },
  retirePooledOrg,
}
