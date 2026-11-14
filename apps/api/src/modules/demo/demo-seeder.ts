// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The seam between the public demo signup and the demo DATA seeder.
//
// The seeder is `seed/tiers/demo/seed-demo.ts`, exporting `seedDemoWorld`: the
// COMPOSED entry point that fills one org with the whole world (people and
// agents, then tickets, mail, knowledge, projects, calendar, contacts and
// conversations, then invoicing, shipping and social, then the owner's place
// in it). It used to be `seedDemoOrg`, the first layer alone, which is why a
// visitor got a workspace full of people and an empty product. It owns a large
// result and it CREATES the org itself, keyed on a slug. This file owns the
// contract between us, kept as narrow as the route actually needs, so neither
// side drifts into the other:
//
//   in   { orgSlug, orgName, variant, locale, owner }
//   out  { ok, orgId?, detail? }
//
// Everything else the seeder returns is deliberately dropped here. The signup
// route needs exactly two facts: which org to hand the visitor, and whether it
// arrived populated.
//
// SEEDING IS NOT ALLOWED TO FAIL THE SIGNUP. A thin demo is a bad demo; a
// signup that 500s is a broken product. So a missing, throwing or slow seeder
// is logged loudly and reported as `ok: false`, and the caller falls back to
// creating the org plainly under the SAME slug, which is also what makes the
// fallback safe: a seeder that timed out half way through has already created
// the org under that slug, and `ensureOrg` finds it rather than racing it.
//
// There is exactly ONE call site (routes.ts, POST /api/demo/orgs) and exactly
// one place the real implementation is resolved (`loadSeeder` below).
import path from "node:path"
import {
  DEMO_DEFAULT_WORLD,
  type DemoNeed,
  type DemoVariant,
  type DemoWorldId,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { schemaRef } from "~/db/schema-ref"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { DEMO_SEED_DEADLINE_MS } from "~/modules/demo/demo-provisioning"
import { prepareRecordedLaptop } from "~/modules/demo/replay/replay"

const K = () => drizzleSql.raw(schemaRef("kernel"))

const log = rootLogger.child({ module: "demo-seeder" })

/**
 * The fictional company every demo workspace IS. A visitor does not name their
 * workspace: they are handed this company and are its CEO, so the org's display
 * name is the company's, here, once, for the signup route, the reset job and
 * the seed CLI alike.
 */
export const DEMO_COMPANY_NAME = "Resonant Audio Labs"

/** The slug of the reserved org, when nothing on the command line names one. */
export const DEMO_RESERVED_SLUG = "demo"

/**
 * The App Review account.
 *
 * Apple's Beta App Review needs credentials without registering, and types them
 * by hand on a phone off the review notes, so the address is on the demo's own
 * public hostname rather than the per-org `.example` domain the seeded people
 * live on. Nothing ever delivers to it: a demo box has its mail egress locked
 * down, and this is a password login.
 */
export const DEMO_REVIEWER_EMAIL = "appreview@demo.liaison.sh"
export const DEMO_REVIEWER_NAME = "App Review"

/**
 * Thrown when the reserved org is asked for without a password pinned in the
 * environment. A distinct type so a caller can tell "the operator has not
 * configured this box yet" from "the seeder broke".
 */
export class ReservedOwnerPasswordMissingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReservedOwnerPasswordMissingError"
  }
}

/** What an operator has to do, said the same way everywhere it is said. */
export const RESERVED_PASSWORD_INSTRUCTION =
  `Set LIAISON_DEMO_REVIEWER_PASSWORD to the password you will type into App Store Connect ` +
  `for ${DEMO_REVIEWER_EMAIL}, then seed again. It is never generated and never printed: a ` +
  `password only the log has ever seen is a credential nobody has.`

/**
 * The reserved org's owner: the one account on the box with a fixed password.
 *
 * THE PASSWORD IS NOT IN THIS REPO and it is NOT GENERATED. It is read from
 * `LIAISON_DEMO_REVIEWER_PASSWORD`, and when that is unset this REFUSES rather
 * than inventing one.
 *
 * It used to generate one and print it at WARN, which did not work and could
 * not: `password` is in the logger's redact paths (lib/logger.ts), so the line
 * an operator was told to read printed `"password":"[Redacted]"`. The default
 * path therefore created the one account Apple's Beta App Review signs in with
 * on a secret nobody could ever recover, and `ensureUser` never resets an
 * existing password, so the org stayed unreachable for the rest of its life.
 * A reserved org that refuses to seed is an operator reading one sentence; a
 * reserved org that seeds and cannot be signed into is a rejected build.
 *
 * Callers that can destroy data (the nightly reset clears the org before it
 * re-seeds) must call this BEFORE the first delete, so a misconfigured box
 * fails with the workspace still intact.
 */
export function reservedOwner(): { email: string; name: string; password: string } {
  const password = env.LIAISON_DEMO_REVIEWER_PASSWORD.trim()
  if (password === "") {
    throw new ReservedOwnerPasswordMissingError(
      `The reserved App Review org cannot be seeded without a password. ${RESERVED_PASSWORD_INSTRUCTION}`,
    )
  }
  return { email: DEMO_REVIEWER_EMAIL, name: DEMO_REVIEWER_NAME, password }
}

/**
 * Make the App Review account's password the one in the environment, whatever
 * it was before.
 *
 * `ensureUser` never resets an existing password, which is the right rule for
 * every other account and the wrong one for this single reserved credential:
 * an operator who pins a password on a box that was seeded before it existed
 * would otherwise still be locked out, with no shipped way back in. This is the
 * one account that is defined BY the environment variable, so the environment
 * variable is what it holds. Idempotent: the hash is rewritten only when the
 * stored one does not already verify the configured password.
 */
export async function ensureReservedOwnerPassword(orgId: string): Promise<void> {
  const { email, password } = reservedOwner()
  const { hashPassword, verifyPassword } = await import("~/lib/crypto")
  const { withSystemDb } = await import("~/db/privileged")
  await withSystemDb("demo-reserved-owner-password", async (tx) => {
    const rows = await tx.execute(
      drizzleSql`SELECT id, password_hash AS hash FROM ${K()}.users
                 WHERE org_id = ${orgId}::uuid AND email = ${email.toLowerCase()}`,
    )
    const list = (
      Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
    ) as Array<Record<string, unknown>>
    const row = list[0]
    if (!row) {
      log.error({ orgId, email }, "the reserved org has no App Review account to pin a password on")
      return
    }
    const stored = typeof row.hash === "string" ? row.hash : null
    if (stored && (await verifyPassword(password, stored))) return
    const hash = await hashPassword(password)
    await tx.execute(
      drizzleSql`UPDATE ${K()}.users SET password_hash = ${hash}, updated_at = now()
                 WHERE id = ${String(row.id)}::uuid`,
    )
    log.warn(
      { orgId, email },
      "the App Review account's password was re-pinned to LIAISON_DEMO_REVIEWER_PASSWORD",
    )
  })
}

/**
 * Make sure App Review is not the org's LAST admin.
 *
 * "Delete my account" refuses the last admin (the only active user of the org
 * holding the `admin` role), which is the right rule for a real workspace and
 * would be a rejected build here: the review notes send the reviewer through
 * account deletion, on this account. The seeded world already carries its
 * founder as an `admin` (seed-org.ts, `buildConfig`), and this is the guarantee
 * behind that convention rather than a hope: when no OTHER active user holds
 * `admin`, the earliest created active person of the org is given it. That
 * person is a seeded persona with no password, so the seat is a role and never
 * a door. Idempotent: a second run finds the admin and writes nothing.
 */
export async function ensureReservedSecondAdmin(orgId: string): Promise<void> {
  const { withSystemDb } = await import("~/db/privileged")
  await withSystemDb("demo-reserved-second-admin", async (tx) => {
    const rowsOf = (result: unknown): Array<Record<string, unknown>> =>
      (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Array<
        Record<string, unknown>
      >
    const roles = rowsOf(
      await tx.execute(drizzleSql`
        SELECT id FROM ${K()}.roles WHERE org_id = ${orgId}::uuid AND name = 'admin' LIMIT 1`),
    )
    const roleId = roles[0]?.id
    if (!roleId) {
      log.error({ orgId }, "the reserved org has no admin role to give a second admin")
      return
    }
    const others = rowsOf(
      await tx.execute(drizzleSql`
        SELECT 1 FROM ${K()}.user_roles ur
        JOIN ${K()}.users u ON u.id = ur.user_id
        WHERE ur.role_id = ${String(roleId)}::uuid AND u.org_id = ${orgId}::uuid
          AND u.status = 'active' AND lower(u.email) <> ${DEMO_REVIEWER_EMAIL.toLowerCase()}
        LIMIT 1`),
    )
    if (others.length > 0) return
    const candidates = rowsOf(
      await tx.execute(drizzleSql`
        SELECT id FROM ${K()}.users
        WHERE org_id = ${orgId}::uuid AND status = 'active'
          AND lower(email) <> ${DEMO_REVIEWER_EMAIL.toLowerCase()}
        ORDER BY created_at, email LIMIT 1`),
    )
    const userId = candidates[0]?.id
    if (!userId) {
      log.error({ orgId }, "the reserved org has nobody but App Review to hold a second admin seat")
      return
    }
    await tx.execute(drizzleSql`
      INSERT INTO ${K()}.user_roles (user_id, role_id, org_id)
      VALUES (${String(userId)}::uuid, ${String(roleId)}::uuid, ${orgId}::uuid)
      ON CONFLICT DO NOTHING`)
    log.warn(
      { orgId, userId },
      "gave the reserved org a second admin so App Review is not the last",
    )
  })
}

export interface DemoSeedRequest {
  /** Unique, already generated by the caller. The seeder keys the org on it. */
  orgSlug: string
  /** Display name for the new workspace. Always the fictional company's. */
  orgName: string
  /** The demo world to seed. Absent: `products`. */
  worldId?: DemoWorldId
  variant: DemoVariant
  /** BCP 47 tag; the seeder has its own default when this is omitted. */
  locale?: string
  /**
   * The ONE account the seeded org can be signed into with, created as its
   * admin. Omitted only for an org nobody will ever sign into (the nightly
   * reset's throwaway probe), which is then seeded with no login at all.
   */
  owner?: { email: string; name: string; password: string }
  /**
   * What the visitor said they need, in pick order. Absent seeds the whole
   * world (the reserved org and the nightly reset never pass it).
   */
  needs?: readonly DemoNeed[]
}

export interface DemoSeedResult {
  /** True only when EVERY part in the plan landed. False means the seed FAILED. */
  ok: boolean
  /** The seeded org's id, present whenever the org layer got that far. */
  orgId?: string
  /** One short line for the operator's log. Never rendered to the visitor. */
  detail?: string
  /**
   * The parts that failed, by name only (`commerce`, `app:shopify`, `timeout`,
   * ...): safe to record in the workspace's provisioning state, unlike `detail`.
   */
  failedParts?: string[]
}

/**
 * How long the seeder gets before the caller stops waiting on it.
 *
 * It runs BEHIND the signup response (routes.ts hands the visitor the org
 * first), so this is not a latency budget: it is the deadline past which the
 * workspace is reported `failed` rather than left `provisioning` for ever.
 * The composed seeder installs the app set and then writes the whole world, so
 * it is minutes rather than seconds; 120s was the budget for the org layer
 * alone and would have timed out every visitor org the moment the domain
 * layers were added. Whatever the seeder had written by then stays where it is.
 *
 * DERIVED, not restated. This number used to be written here, in
 * demo-provisioning's stale threshold (5 minutes) and in the web poll ceiling
 * (10 minutes), and the three disagreed: a healthy six minute seed was reported
 * failed to the visitor and the poll stopped on that answer. One constant now
 * feeds all three.
 */
const SEED_TIMEOUT_MS = DEMO_SEED_DEADLINE_MS

type SeederFn = (req: DemoSeedRequest) => Promise<DemoSeedResult>

let registered: SeederFn | null = null
let resolved: SeederFn | null | undefined

/**
 * Install a seeder explicitly. The deployment does not need this (the real one
 * is found by path); it exists so a test can assert what the call site passes,
 * and so a failing seeder can be exercised without breaking one on disk.
 */
export function setDemoSeeder(seeder: SeederFn | null): void {
  registered = seeder
  resolved = undefined
}

/**
 * Resolve the real seeder from `seed/tiers/demo/seed-demo.ts`, or null when
 * that module is not on disk. It ships in the api image with the rest of
 * `apps/api`, so this resolves in production exactly as it does locally. The
 * path is built at run time rather than written as a literal specifier, so a
 * missing module is a caught miss rather than a build-time resolution failure.
 */
async function loadSeeder(): Promise<SeederFn | null> {
  if (registered) return registered
  if (resolved !== undefined) return resolved
  const modulePath = path.resolve(import.meta.dir, "../../seed/tiers/demo/seed-demo.ts")
  try {
    const mod = (await import(modulePath)) as {
      seedDemoWorld?: (opts: {
        orgSlug: string
        orgName?: string
        worldId?: DemoWorldId
        variant: DemoVariant
        locale?: string
        owner?: { email: string; name: string; password: string }
        needs?: DemoNeed[]
      }) => Promise<{
        orgId: string
        complete: boolean
        failures: Array<{ layer: string; message: string }>
        org: { failedApps?: string[] }
      }>
    }
    if (typeof mod.seedDemoWorld !== "function") {
      log.error({ modulePath }, "demo seeder module has no seedDemoWorld export")
      resolved = null
      return null
    }
    const seedDemoWorld = mod.seedDemoWorld
    resolved = async (req) => {
      const worldId = req.worldId ?? DEMO_DEFAULT_WORLD
      const result = await seedDemoWorld({
        orgSlug: req.orgSlug,
        orgName: req.orgName,
        worldId,
        variant: req.variant,
        locale: req.locale,
        owner: req.owner,
        ...(req.needs ? { needs: [...req.needs] } : {}),
      })
      const failedApps = result.org.failedApps ?? []
      if (result.complete) return { ok: true, orgId: result.orgId }
      // A part failed: the seed FAILED. The org row exists, so its id still
      // comes back and the caller records the failure against it (the signup
      // route's `failed` state, the pool's retirement); it is never reported
      // as a finished workspace.
      const failedParts = [
        ...result.failures.map((f) => f.layer),
        ...failedApps.map((a) => `app:${a}`),
      ]
      const detail = [
        ...result.failures.map((f) => `${f.layer}: ${f.message}`),
        ...failedApps.map((a) => `app ${a} failed`),
      ].join("; ")
      log.error({ orgSlug: req.orgSlug, failedParts, detail }, "demo org seed failed")
      return { ok: false, orgId: result.orgId, detail, failedParts }
    }
    return resolved
  } catch (err) {
    log.warn({ err, modulePath }, "demo seeder not available; demo orgs will be created empty")
    resolved = null
    return null
  }
}

/**
 * Seed a demo org. Never throws: the caller is a public route that must produce
 * a usable workspace either way.
 */
export async function seedDemoOrgData(req: DemoSeedRequest): Promise<DemoSeedResult> {
  const seeder = await loadSeeder()
  if (!seeder) {
    log.error({ orgSlug: req.orgSlug }, "demo seeder unavailable")
    return { ok: false, detail: "seeder unavailable", failedParts: ["seeder"] }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      seeder(req),
      new Promise<DemoSeedResult>((_, reject) => {
        timer = setTimeout(() => reject(new Error("demo seeding timed out")), SEED_TIMEOUT_MS)
      }),
    ])
    log.info({ orgSlug: req.orgSlug, variant: req.variant, ok: result.ok }, "demo org seeded")
    // The reserved credential is defined by the environment, so it is pinned
    // to the environment on every seed of that org rather than only on the
    // first one. `ensureUser` deliberately never resets a password, which
    // would otherwise leave a box seeded before the variable was set holding
    // an account nobody can sign into. Reserved orgs only: nothing here runs
    // for a visitor org, whose owner is the visitor's own account.
    if (req.variant === "reserved" && result.orgId) {
      await ensureReservedOwnerPassword(result.orgId)
      await ensureReservedSecondAdmin(result.orgId)
    }
    return result
  } catch (err) {
    log.error({ err, orgSlug: req.orgSlug }, "demo seeding failed")
    const timedOut = err instanceof Error && err.message === "demo seeding timed out"
    return {
      ok: false,
      detail: err instanceof Error ? err.message : "seeding failed",
      failedParts: [timedOut ? "timeout" : "seed"],
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ── A scenario's start ───────────────────────────────────────────────────

/** What starting a visitor's scenario writes into their workspace (`seedScenarioStart`). */
export type ScenarioStartFn = (
  orgId: string,
  ownerUserId: string,
  need: DemoNeed,
  worldId?: DemoWorldId,
) => Promise<string[]>

let scenarioStart: ScenarioStartFn | null | undefined

/** Resolve `seedScenarioStart` from the seeder module, or null when it is not on disk. */
async function loadScenarioStart(): Promise<ScenarioStartFn | null> {
  if (scenarioStart !== undefined) return scenarioStart
  const modulePath = path.resolve(import.meta.dir, "../../seed/tiers/demo/seed-demo.ts")
  try {
    const mod = (await import(modulePath)) as { seedScenarioStart?: ScenarioStartFn }
    scenarioStart = typeof mod.seedScenarioStart === "function" ? mod.seedScenarioStart : null
  } catch (err) {
    log.warn({ err, modulePath }, "demo scenario seeder not available")
    scenarioStart = null
  }
  return scenarioStart
}

/**
 * A visitor started the scenario of `need`: write what it brings (its seeded
 * approvals, waiting on them; the developer scenario's recorded laptop).
 * Never throws: a scenario still starts without them.
 */
export async function prepareDemoScenario(
  orgId: string,
  ownerUserId: string,
  need: DemoNeed,
  worldId: DemoWorldId = DEMO_DEFAULT_WORLD,
): Promise<void> {
  // The developer scenario's recorded laptop is there before the visitor asks
  // their agent to send it anything. Each world plays its own recording.
  if (need === "dev") {
    try {
      await prepareRecordedLaptop(orgId, ownerUserId)
    } catch (err) {
      log.error({ err, orgId }, "demo scenario: the recorded laptop could not be prepared")
    }
  }
  const start = await loadScenarioStart()
  if (!start) return
  try {
    const ids = await start(orgId, ownerUserId, need, worldId)
    log.info({ orgId, need, worldId, approvals: ids.length }, "demo scenario prepared")
  } catch (err) {
    log.error({ err, orgId, need }, "demo scenario could not be prepared")
  }
}

// ── A pooled workspace's claim ─────────────────────────────────────────────

/** What fitting a pooled workspace to a visitor's needs does (`fitPooledWorldToNeeds`). */
export type FitPooledWorldFn = (
  orgId: string,
  needs: readonly DemoNeed[],
  worldId?: DemoWorldId,
  ownerUserId?: string,
) => Promise<{ appsOff: string[]; supportRoutineOff: boolean }>

let fitPooledWorld: FitPooledWorldFn | null | undefined

async function loadFitPooledWorld(): Promise<FitPooledWorldFn | null> {
  if (fitPooledWorld !== undefined) return fitPooledWorld
  const modulePath = path.resolve(import.meta.dir, "../../seed/tiers/demo/seed-demo.ts")
  try {
    const mod = (await import(modulePath)) as { fitPooledWorldToNeeds?: FitPooledWorldFn }
    fitPooledWorld =
      typeof mod.fitPooledWorldToNeeds === "function" ? mod.fitPooledWorldToNeeds : null
  } catch (err) {
    log.warn({ err, modulePath }, "demo pool fitter not available")
    fitPooledWorld = null
  }
  return fitPooledWorld
}

/**
 * Fit a claimed pooled workspace to the visitor's needs (the apps they did not
 * pick turned Off) and recompute the owner's stored attention lists. Never
 * throws: a workspace showing an app too many is still a working demo.
 */
export async function fitPooledDemoWorld(
  orgId: string,
  needs: readonly DemoNeed[],
  worldId: DemoWorldId = DEMO_DEFAULT_WORLD,
  ownerUserId?: string,
): Promise<void> {
  const fit = await loadFitPooledWorld()
  if (!fit) return
  try {
    const result = await fit(orgId, needs, worldId, ownerUserId)
    log.info(
      { orgId, needs, worldId, ...result },
      "pooled demo workspace fitted to the visitor's needs",
    )
  } catch (err) {
    log.error({ err, orgId, needs }, "pooled demo workspace could not be fitted to the needs")
  }
}

/** Test seam: forget the resolved module so a test can install its own seeder. */
export const DemoSeederTestAccess = {
  reset(): void {
    registered = null
    resolved = undefined
    scenarioStart = undefined
    fitPooledWorld = undefined
  },
  /** Install what fitting a claimed pooled workspace does (null: nothing). */
  setFitPooledWorld(fn: FitPooledWorldFn | null): void {
    fitPooledWorld = fn
  },
  /** Install what a scenario's start writes (null: nothing). */
  setScenarioStart(fn: ScenarioStartFn | null): void {
    scenarioStart = fn
  },
}
