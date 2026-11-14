// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `seedDemoWorld` — ONE call that produces ONE org holding the WHOLE demo.
//
// Until this file existed the three layer seeders were only ever run against
// three different orgs, one each, by their own integration tests. Read back out
// of Postgres that looked like this:
//
//   demo-seed-integration            7 users, 11 agents,  0 tickets,  0 invoices
//   demo-support-integration         7 users, 11 agents, 33 tickets,  0 invoices
//   demo-seed-commerce-integration   7 users, 11 agents,  0 tickets, 37 invoices
//
// No org had the product. The signup route called `seedDemoOrg` alone, so a
// visitor got people and agents and an empty company. This entry point is the
// only thing anything should call, and it is used in all three places a demo
// org is filled:
//
//   1. the first deploy, and every deploy after it, through the `demo:seed`
//      package script the deploy hook runs inside the app container;
//   2. the nightly reset, which re-seeds the reserved App Review org to undo
//      whatever a reviewer changed (including the Shopify write overlay);
//   3. every visitor signup, behind the response, through `demo-seeder.ts`.
//
// The SAME path for all three is the point: the org Apple's reviewer opens and
// the org a visitor is handed differ by one field, `variant`, and by who their
// owner is.
//
// ── ORDER ──────────────────────────────────────────────────────────────────
// org -> support -> commerce -> agent native -> accounts. `seedDemoOrg` creates the org, its
// owner and the people and agents every later layer writes AS. Support seeds
// the conversations and the approvals the owner is joined to, so the accounts
// layer runs last or the owner opens onto an empty Chats list.
// Commerce is independent of support and runs between them only so the two
// heavy layers are adjacent in the log. The agent native layer (the org's
// skills, its routines, its sub agent roles and its agents' memory) comes after
// both, because its playbooks and routines are about what they wrote.
//
// ── FAILURE POLICY ─────────────────────────────────────────────────────────
// The ORG layer is load bearing and its failure RETHROWS: there is no org, so
// there is nothing to hand anybody, and the signup route's own `ensureOrg`
// fallback is what covers that case. Every layer after it is caught
// INDIVIDUALLY so the layers after it still run, and recorded in `failures`;
// `complete` then comes back false and the seed has FAILED. There is no
// "partial" success: every part in the plan is expected to land, a failed one
// is an error the CLI exits non-zero on and the signup route reports as the
// `failed` provisioning state, logged at error level.
//
// A part a deployment cannot run is not a failure waiting to happen: it is
// OPT-IN and off unless the deployment turns it on (`DemoSeedPlanOptions`).
// Today that is the warehouse (`LIAISON_DEMO_WAREHOUSE`). Off, it is listed in
// `partsOff` and the log says so; on, its failure is an error like any other.
// Nothing is retried here: the nightly reset re-runs the whole thing anyway,
// and a retry loop behind an HTTP response is how a demo box spends its
// evening seeding the same org.
//
// ── RE-RUNNABLE IS THE RESET ───────────────────────────────────────────────
// Every layer is idempotent on CONTENT, not just on row counts, and that is
// what makes "the nightly reset" nothing more than running this again. The
// Shopify write overlay is reset by `installDemoShopifyConnection` inside the
// org layer, so a visitor's writes against the fixture shop go away too.

import {
  DEMO_DEFAULT_WORLD,
  DEMO_WORLDS,
  type DemoNeed,
  type DemoSeedPart,
  type DemoWorldId,
  isDemoWorldId,
} from "@liaison/shared"
import { and, eq, sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { approvalRequests, routines } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { storeApprovalSummaries } from "~/modules/approvals/served-summary"
import { refreshAllAppAttention } from "~/modules/apps/attention-store"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { setOrgAppAccess, setOrgAppStatus } from "~/modules/apps/org-app-service"
import { getOrgAppState } from "~/modules/apps/org-apps"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import { completeDemoOrgReset, resetDemoOrgContent } from "~/modules/demo/demo-reset"
import {
  DEMO_COMPANY_NAME,
  DEMO_RESERVED_SLUG,
  ensureReservedOwnerPassword,
  ensureReservedSecondAdmin,
  reservedOwner,
} from "~/modules/demo/demo-seeder"
import { saasScenarioStart } from "~/modules/demo/worlds/saas/scenario-start"
import { runAsSeed } from "~/modules/notifications/seeded"
import { joinPendingApprovals } from "~/seed/factories/people/membership"
import { demoWorldPack, findDemoWorldPack } from "~/seed/worlds"
import { DEMO_APPS, type DemoSeedPlan, demoSeedPlan } from "./demo-apps"
import { replaceSeededDemoOrg } from "./replace-demo-org"
import { type SeedDemoAccountsResult, seedDemoAccounts } from "./seed-accounts"
import {
  enableScenarioRoutine,
  type SeedDemoAgentNativeResult,
  SUPPORT_SCENARIO_ROUTINE,
  seedDemoAgentNative,
} from "./seed-agent-native"
import { type SeedDemoCommerceResult, seedDemoCommerce } from "./seed-commerce"
import { type SeedDemoOrgOptions, type SeedDemoOrgResult, seedDemoOrg } from "./seed-org"
import { type SeedDemoSupportResult, seedDemoSupport, seedScenarioApprovals } from "./seed-support"
import { type SeedDemoWarehouseResult, seedDemoWarehouse } from "./seed-warehouse"

const seedLog = rootLogger.child({ module: "demo-seed" })

export interface SeedDemoWorldOptions extends SeedDemoOrgOptions {
  /**
   * The demo world to seed (`DEMO_WORLDS`). Defaults to `products`. Its pack
   * gives the org its people, desks, mail domain and name (unless `orgName` is
   * given), and every layer its specs (`seed/worlds`).
   */
  worldId?: DemoWorldId
  /**
   * Anchor every relative offset in the domain layers to this instant. Defaults
   * to the moment of the call, so a freshly seeded org always looks active.
   * Pass a fixed date to reproduce an exact world (the tests do).
   */
  baseTime?: Date
  /**
   * Empty the org's DOMAIN data before writing it again, which is what turns a
   * top up into a true reset: the layer seeders adopt a row they already wrote
   * rather than rewriting it, so a subject or a title a visitor changed would
   * otherwise survive. Off by default here; the CLI turns it on for a reserved
   * run and the nightly job does its own clear. People, roles, agents and the
   * installed apps are never touched.
   */
  resetContent?: boolean
  /**
   * The needs a visitor picked, in pick order. Absent means everything, which
   * is what the reserved org and the nightly reset get, unchanged. Given, the
   * seed writes the baseline world plus each need's apps and parts
   * (`demoSeedPlan`), and the scenarios' own routines and task.
   */
  needs?: readonly DemoNeed[]
  /**
   * Seed the opt-in warehouse part. Defaults to the deployment's
   * `LIAISON_DEMO_WAREHOUSE` (off unless set); never inferred from whether
   * the warehouse's credentials happen to be present.
   */
  warehouse?: boolean
  /**
   * Leave out the commerce part (the shop, its invoices, the carrier, the
   * books), for an org that seeds without the commerce apps installed. Its
   * apps are still offered to the org; only their rows are not written.
   */
  withoutCommerce?: boolean
}

/** One layer's outcome, for the log and for the caller's own reporting. */
export interface SeedLayerFailure {
  layer:
    | "support"
    | "commerce"
    | "warehouse"
    | "world"
    | "agent-native"
    | "accounts"
    | "support-routine"
    | "attention"
  message: string
}

export interface SeedDemoWorldResult {
  orgId: string
  orgSlug: string
  org: SeedDemoOrgResult
  /** Null when the layer threw; see `failures`. */
  support: SeedDemoSupportResult | null
  commerce: SeedDemoCommerceResult | null
  /** The oracle layer: the analytics warehouse plus this org's connection. */
  warehouse: SeedDemoWarehouseResult | null
  agentNative: SeedDemoAgentNativeResult | null
  accounts: SeedDemoAccountsResult | null
  /** True only when every part in the plan landed. False means the seed FAILED. */
  complete: boolean
  failures: SeedLayerFailure[]
  /** Opt-in parts the deployment has off, so they were not seeded (see `DemoSeedPlan`). */
  partsOff: readonly DemoSeedPart[]
}

/** Store the summary of every approval the seed wrote on this org (see seedDemoWorld). */
async function storeSeededApprovalSummaries(orgId: string): Promise<number> {
  const ids = await withPrivilegedDb(orgId, "demo-seed:approval-summary-ids", async (tx) =>
    (
      await tx
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.orgId, orgId),
            sql`${approvalRequests.metadata}->>'seeded' = 'true'`,
          ),
        )
    ).map((r) => r.id),
  )
  if (ids.length === 0) return 0
  await ensureAppsForOrg(orgId)
  return storeApprovalSummaries(orgId, ids)
}

/**
 * Recompute the apps' stored attention lists of the org, every app provider for every active
 * person (or only `userIds`), the way the minute tick does (`refreshAllAppAttention`). The Home
 * feed reads only those stored lists for an app (attention-store.ts), so a workspace the seed just
 * wrote shows empty queues until they are computed. The org's apps are registered in this process
 * first, the way a server registers them at boot.
 */
export async function refreshSeededAttention(
  orgId: string,
  userIds?: readonly string[],
): Promise<void> {
  await ensureAppsForOrg(orgId)
  await refreshAllAppAttention(orgId, userIds ? { userIds: [...userIds] } : {})
}

function message(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  // A failed query's wrapper names the SQL only; the database's own reason
  // is on its cause, and a recorded failure without it can't be diagnosed.
  const cause = err.cause instanceof Error ? err.cause.message : null
  return cause ? `${err.message}\ncause: ${cause}` : err.message
}

/**
 * The picks decide what the visitor sees: every demo app they did not pick is
 * turned Off, every other one is On and open to everyone (Everything and an
 * untailored seed turn none Off in `products`; another world also turns Off the
 * demo apps it does not have). A re-seed puts back whatever an earlier visitor
 * turned Off, removed or restricted; an app already as planned is left
 * untouched. Apps the plan does not name are not touched. Returns the apps
 * turned Off.
 */
async function applyAppPlan(
  orgId: string,
  plan: Pick<DemoSeedPlan, "apps" | "offApps">,
): Promise<string[]> {
  const off = new Set(plan.offApps)
  const governed = new Set([...plan.apps, ...plan.offApps])
  for (const app of DEMO_APPS.filter((a) => governed.has(a))) {
    // An app not registered in this deployment has no row to set.
    const state = await getOrgAppState(orgId, app)
    if (!state) continue
    const status = off.has(app) ? "disabled" : "active"
    if (state.status !== status) await setOrgAppStatus(orgId, app, status)
    if (state.accessMode !== "everyone") {
      await setOrgAppAccess(orgId, app, { mode: "everyone", roleIds: [], userIds: [] })
    }
  }
  return [...off]
}

/**
 * Fit a POOLED workspace to the needs of the visitor who claims it.
 *
 * The warm pool (apps/api/src/modules/demo/demo-pool.ts) seeds every pooled
 * org with every need, which is the world a visitor who picks Everything gets.
 * A visitor who picked fewer then sees exactly the apps a tailored seed would
 * have installed for them: the apps their picks do not need are turned Off,
 * the same switch `seedDemoWorld` flips, and the support scenario's routine,
 * which the full seed switches on, goes back Off unless they picked support,
 * so nothing in an app they never asked for runs behind their back. The other
 * seeded content of the apps turned Off stays in place, out of sight, which is
 * what an app turned Off already means. Last, the claiming owner's stored
 * attention lists are recomputed (`ownerUserId`), so the Home they land on
 * holds the queues as of the claim, not as of the pool's seed. Cheap on
 * purpose: a few row updates and one person's lists inside the claim, never a
 * seed.
 */
export async function fitPooledWorldToNeeds(
  orgId: string,
  needs: readonly DemoNeed[],
  worldId: DemoWorldId = DEMO_DEFAULT_WORLD,
  ownerUserId?: string,
): Promise<{ appsOff: string[]; supportRoutineOff: boolean }> {
  const fit = pooledFitPlan(needs, worldId)
  const appsOff = await applyAppPlan(orgId, fit)
  let supportRoutineOff = false
  if (fit.routinesOff.includes(SUPPORT_SCENARIO_ROUTINE)) {
    const ids = await withPrivilegedDb(orgId, "demo-pool:support-routine-off", async (tx) =>
      (
        await tx
          .update(routines)
          .set({ enabled: false, updatedAt: sql`now()` })
          .where(
            and(
              eq(routines.orgId, orgId),
              eq(routines.name, SUPPORT_SCENARIO_ROUTINE),
              eq(routines.enabled, true),
            ),
          )
          .returning({ id: routines.id })
      ).map((r) => r.id),
    )
    if (ids.length > 0) {
      const { disposeEventRoutineSubscription } = await import(
        "~/infra/jobs/event-routine-subscriber"
      )
      for (const id of ids) await disposeEventRoutineSubscription(id)
      supportRoutineOff = true
    }
  }
  if (ownerUserId) await refreshSeededAttention(orgId, [ownerUserId])
  return { appsOff, supportRoutineOff }
}

/**
 * What fitting a pooled workspace of `worldId` to `needs` does, short of
 * writing it: the world's plan for those needs gives the apps left On and
 * turned Off, and the support scenario's routine goes Off unless support was
 * picked. Every other routine the world seeded stays as it is.
 */
export function pooledFitPlan(
  needs: readonly DemoNeed[],
  worldId: DemoWorldId,
): { apps: readonly string[]; offApps: readonly string[]; routinesOff: string[] } {
  // Only the apps and the support routine are read here, neither depends on the warehouse.
  const plan = demoSeedPlan(needs, { warehouse: env.LIAISON_DEMO_WAREHOUSE }, worldId)
  return {
    apps: plan.apps,
    offApps: plan.offApps,
    routinesOff: plan.parts.has("support-routine") ? [] : [SUPPORT_SCENARIO_ROUTINE],
  }
}

/**
 * Seed one demo org from nothing, or top an existing one back up, through
 * every layer. Throws only when the org layer itself fails.
 *
 * The whole seed runs as a seed (`runAsSeed`): every event its writes queue is
 * marked as the seed's own, so no event routine reacts to the seeded world. The
 * outbox delivers those events after the routines are switched on, and the
 * support routine used to run (or, refused on an unverified workspace, pause
 * itself) on the seeded backlog. Only what happens after the seed fires them.
 */
export function seedDemoWorld(opts: SeedDemoWorldOptions): Promise<SeedDemoWorldResult> {
  return runAsSeed(() => seedDemoWorldLayers(opts))
}

async function seedDemoWorldLayers(opts: SeedDemoWorldOptions): Promise<SeedDemoWorldResult> {
  const log = opts.log ?? (() => {})
  const baseTime = opts.baseTime ?? new Date()
  const failures: SeedLayerFailure[] = []

  // Which world, and what this seed writes of it: everything (no needs), or a
  // visitor's picks.
  const worldId = opts.worldId ?? DEMO_DEFAULT_WORLD
  const pack = demoWorldPack(worldId)
  const plan = demoSeedPlan(
    opts.needs,
    { warehouse: opts.warehouse ?? env.LIAISON_DEMO_WAREHOUSE },
    worldId,
  )
  const wants = (part: DemoSeedPart) =>
    plan.parts.has(part) && !(part === "commerce" && opts.withoutCommerce === true)
  if (opts.withoutCommerce === true) log("world: the commerce part is left out on request")
  if (plan.partsOff.length > 0) {
    log(`world: opt-in parts off on this deployment: ${plan.partsOff.join(", ")}`)
  }
  const org = await seedDemoOrg({
    ...opts,
    orgName: opts.orgName ?? pack.orgName,
    world: opts.world ?? pack.world,
    roleAgents: opts.roleAgents ?? pack.roleAgents,
    deskTeams: opts.deskTeams ?? pack.deskTeams,
    emailDomain: opts.emailDomain ?? pack.emailDomain,
    apps: opts.apps ?? plan.apps,
    includeDomainData: true,
  })
  log(`world: org '${org.orgSlug}' (${worldId}) ready with ${org.people.length} people`)

  const off = await applyAppPlan(org.orgId, plan)
  if (off.length > 0) log(`world: turned Off the apps not picked: ${off.join(", ")}`)

  // `resetDemoOrgContent` REFUSES (it throws) unless demo mode is on and the
  // org row itself carries a demo marker. It also raises an interrupted-reset
  // flag on the org, which stays up until every layer below has landed, so a
  // process that dies between the clear and the seed leaves a workspace that
  // says so instead of a thin one nobody can tell from a quiet one.
  if (opts.resetContent === true) {
    const cleared = await resetDemoOrgContent(org.orgId)
    const rows = Object.values(cleared).reduce((n, v) => n + v, 0)
    log(
      `world: cleared ${rows} rows across ${Object.keys(cleared).length} tables before re-seeding`,
    )
  }

  let support: SeedDemoSupportResult | null = null
  try {
    support = await seedDemoSupport(org, {
      now: baseTime,
      log,
      specs: {
        support: pack.supportSpecs,
        knowledge: pack.knowledgeSpecs,
        threads: pack.threadSpecs,
      },
      ...(plan.tailored
        ? {
            tailored: {
              parts: plan.parts,
              installedApps: new Set(opts.apps ?? plan.apps),
              shortBacklog: (opts.needs?.length ?? 0) > 1,
            },
          }
        : {}),
    })
  } catch (err) {
    failures.push({ layer: "support", message: message(err) })
    log(`world: the support layer failed: ${message(err)}`)
  }

  // The world's own layer: `products` writes its shop and its warehouse below,
  // any other world its pack's layer (`pack.layer`), after support so its rows
  // can name the people, contacts and conversations support wrote.
  const products = worldId === "products"
  if (!products && pack.layer) {
    try {
      await pack.layer({ org, baseTime, plan, log })
      log(`world: the ${worldId} layer is seeded`)
    } catch (err) {
      failures.push({ layer: "world", message: message(err) })
      log(`world: the ${worldId} layer failed: ${message(err)}`)
    }
  } else if (!products) {
    log(`world: the ${worldId} pack has no layer of its own yet`)
  }

  let commerce: SeedDemoCommerceResult | null = null
  try {
    if (products && wants("commerce")) {
      commerce = await seedDemoCommerce({
        org,
        baseTime,
        ...(plan.tailored ? { pendingApprovals: false } : {}),
      })
    }
    if (commerce) log(`world: commerce seeded ${commerce.counts.documents} documents`)
  } catch (err) {
    failures.push({ layer: "commerce", message: message(err) })
    log(`world: the commerce layer failed: ${message(err)}`)
  }

  // The ORACLE layer: the read-only analytics warehouse behind the `database`
  // connector. It is independent of support and commerce (its data is generated
  // from the same `world.ts`, not read back out of them), and it runs before
  // the agent native layer so a routine or a skill that mentions the oracle is
  // written against an org that already has one.
  let warehouse: SeedDemoWarehouseResult | null = null
  try {
    if (products && wants("warehouse")) {
      warehouse = await seedDemoWarehouse(org, { baseTime, log })
      const rows = Object.values(warehouse.counts).reduce((n, v) => n + v, 0)
      log(`world: the oracle holds ${rows} warehouse rows`)
    }
  } catch (err) {
    failures.push({ layer: "warehouse", message: message(err) })
    log(`world: the warehouse layer failed: ${message(err)}`)
  }

  // The agent native layer runs AFTER the two domain layers: its playbooks and
  // its routines are about the tickets, the invoices and the shipments those
  // layers wrote, and a routine's scope ceiling is clamped to what its owner
  // holds, which needs the apps installed and the roles granted first.
  let agentNative: SeedDemoAgentNativeResult | null = null
  try {
    agentNative = await seedDemoAgentNative(org, {
      baseTime,
      log,
      specs: pack.agentNative,
      ...(plan.tailored ? { scenarioParts: plan.parts } : {}),
    })
  } catch (err) {
    failures.push({ layer: "agent-native", message: message(err) })
    log(`world: the agent native layer failed: ${message(err)}`)
  }

  let accounts: SeedDemoAccountsResult | null = null
  try {
    accounts = await seedDemoAccounts(org, { log })
  } catch (err) {
    failures.push({ layer: "accounts", message: message(err) })
    log(`world: the special accounts failed: ${message(err)}`)
  }

  // The seed writes its approvals straight into the table, with no summary. Each one's summary is
  // stored now, from its tool's own summarizer, so serving the cards runs none (served-summary.ts
  // keeps the read-time fill as the fallback). The org's apps are registered in this process the
  // way a server registers them at boot; a server that already has them skips that.
  try {
    const stored = await storeSeededApprovalSummaries(org.orgId)
    log(`world: stored ${stored} approval summaries`)
  } catch (err) {
    seedLog.error({ err, orgId: org.orgId }, "demo seed: storing approval summaries failed")
    log(`world: approval summaries not stored, they are filled when served: ${message(err)}`)
  }

  // The kernel's stored approval summaries are in; the apps' stored attention lists are computed
  // now from what every layer wrote, so the workspace's Home opens with its queues full.
  try {
    await refreshSeededAttention(org.orgId)
    log("world: the apps' attention lists are stored")
  } catch (err) {
    failures.push({ layer: "attention", message: message(err) })
    log(`world: the apps' attention lists could not be stored: ${message(err)}`)
  }

  // The support scenario's routine goes on LAST, once every seeded ticket is
  // written. Their events reach the outbox later than that, which is why the
  // seed runs as one (`runAsSeed` above): the subscriber drops them, and only
  // the live ticket fires the routine.
  const supportRoutineId = agentNative?.routineIdsByName[SUPPORT_SCENARIO_ROUTINE]
  if (plan.tailored && wants("support-routine") && support && supportRoutineId) {
    try {
      await enableScenarioRoutine(org, supportRoutineId)
      log(`world: '${SUPPORT_SCENARIO_ROUTINE}' is on`)
    } catch (err) {
      failures.push({ layer: "support-routine", message: message(err) })
      log(`world: the support routine could not be switched on: ${message(err)}`)
    }
  }

  const complete = failures.length === 0 && org.failedApps.length === 0
  // The flag comes down only when the world really went back. A failed re-seed
  // leaves it up on purpose: the next nightly run reads it, says so in the log
  // and heals the org instead of clearing it again.
  if (opts.resetContent === true && complete) await completeDemoOrgReset(org.orgId)
  if (complete) {
    log(`world: org '${org.orgSlug}' is complete`)
  } else {
    const failed = [...failures.map((f) => f.layer), ...org.failedApps.map((a) => `app:${a}`)]
    seedLog.error(
      { orgId: org.orgId, orgSlug: org.orgSlug, failures, failedApps: org.failedApps },
      "demo seed failed",
    )
    log(`world: org '${org.orgSlug}' FAILED (${failed.join(", ")})`)
  }

  return {
    orgId: org.orgId,
    orgSlug: org.orgSlug,
    org,
    support,
    commerce,
    warehouse,
    agentNative,
    accounts,
    complete,
    failures,
    partsOff: plan.partsOff,
  }
}

/**
 * What starting a scenario writes, per world: the approval ids written.
 *
 * - `products`: each scenario's seeded approvals (`seedScenarioApprovals`).
 * - `saas`: the money decisions (the card reminder, the refund) are seeded with
 *   the workspace, on Home from the start, so the money scenario brings
 *   nothing more. The support, projects and sales scenarios write what they
 *   need when they start (`modules/demo/worlds/saas/scenario-start.ts`: the
 *   support routine, the visitor's task, the sales routine); the others bring
 *   nothing. None seeds an approval.
 * - `studio`: no scenario yet.
 *
 * A world never writes another world's approvals.
 */
async function startWorldScenario(
  worldId: DemoWorldId,
  orgId: string,
  need: DemoNeed,
  ownerUserId: string,
): Promise<string[]> {
  switch (worldId) {
    case "products":
      return seedScenarioApprovals(orgId, need)
    case "saas":
      return saasScenarioStart(orgId, need, ownerUserId)
    case "studio":
      return []
  }
}

/**
 * What a visitor's scenario brings into their workspace when they start it:
 * that scenario's seeded approvals, waiting on them (`seedScenarioApprovals`).
 * The signup seed writes none pending, so the queue holds at most the
 * scenario in progress's. Returns the approval ids written.
 */
export async function seedScenarioStart(
  orgId: string,
  ownerUserId: string,
  need: DemoNeed,
  worldId: DemoWorldId = DEMO_DEFAULT_WORLD,
): Promise<string[]> {
  const ids = await startWorldScenario(worldId, orgId, need, ownerUserId)
  if (ids.length === 0) return ids
  await joinPendingApprovals(orgId, ownerUserId)
  await ensureAppsForOrg(orgId)
  await storeApprovalSummaries(orgId, ids)
  return ids
}

// ── CLI ────────────────────────────────────────────────────────────────────
//
// `bun run demo:seed` on the demo box (the deploy hook runs exactly this,
// inside the app container). With no arguments it seeds the RESERVED org, the
// one non-public workspace handed to Apple's Beta App Review.
//
//   liaison seed --tier demo                 (a true reset of the reserved org)
//   liaison seed --tier demo --no-reset      (top up, adopt what is there)
//   liaison seed --tier demo --slug acme --variant visitor
//
// A RESERVED RUN RESETS. The deploy hook runs `demo:seed` with no arguments and
// its comment has always claimed that a redeploy converges every layer; without
// a clear it never did, because every layer ADOPTS the row it already wrote, so
// a subject a reviewer rewrote survived every deploy. Converging that org is the
// whole point of re-running the seed, so the clear is the default there and
// `--no-reset` is how you ask for a top up. A `visitor` run never clears: that
// org belongs to somebody who is probably still looking at it.
//
// The reserved org's OWNER is the App Review account, and its password comes
// from `LIAISON_DEMO_REVIEWER_PASSWORD`: `reservedOwner()` refuses when it is
// unset, and a reserved run re-pins the account to it after seeding (see
// `runSeedDemoCli`). A `visitor` run from the CLI gets no owner at all: the
// account a visitor signs in with is created by the signup route, which passes
// it through, and an operator seeding a visitor org by hand is making fixture
// data rather than a door.
//
// There is no flag to seed an existing org that is not already a demo org: the
// seeder refuses it outright (see `demoMarkRefusal` in seed-org.ts).
//
// `--passwords <pw>` gives the seven seeded people that password instead of no
// password at all, so a QA tester on a PRIVATE box can sign in as any of them
// and walk the desk the world was written around. It is refused outright on a
// box running in demo mode, where those accounts are public: see
// `SeedDemoOrgOptions.personaPassword`.
//
//   liaison seed --tier demo --no-reset --passwords "<pw>"
//
// `--passwords-env <VAR>` reads the same password from that environment
// variable, so it never shows in a process list or a shell history. A variable
// that is not set exits 2 before anything is seeded.
//
// `--world <id>` seeds another demo world (`DEMO_WORLDS`) from its pack, as a
// `visitor` org only: the reserved App Review org is always `products`, so a
// world other than `products` on a reserved run is refused (exit 2), as is an
// unknown world or one with no seed pack yet.
//
//   liaison seed --tier demo --world saas --slug acme --variant visitor

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1]
  const inline = argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : undefined
}

export interface SeedDemoCliDeps {
  /** The world seeder. Replaced only by the CLI's own test. */
  seedWorld?: (opts: SeedDemoWorldOptions) => Promise<SeedDemoWorldResult>
}

/**
 * The CLI's whole run, short of exiting: parse the flags, seed, and on a
 * RESERVED run pin the App Review credential to the environment and make sure
 * that account is not the org's last admin. The nightly reset and the signup
 * path get the same two guarantees from `seedDemoOrgData`; the deploy hook's
 * `demo:seed` comes through here, and without them a box whose reviewer
 * password changed stayed locked out until the next nightly run.
 */
export async function runSeedDemoCli(
  argv: string[],
  deps: SeedDemoCliDeps = {},
): Promise<{ result: SeedDemoWorldResult | null; exitCode: 0 | 1 | 2 }> {
  const seedWorld = deps.seedWorld ?? seedDemoWorld
  const variant = flag(argv, "variant") === "visitor" ? "visitor" : "reserved"
  const world = flag(argv, "world") ?? DEMO_DEFAULT_WORLD
  if (!isDemoWorldId(world)) {
    console.error(`[demo-seed] unknown world '${world}': expected one of ${DEMO_WORLDS.join(", ")}`)
    return { result: null, exitCode: 2 }
  }
  if (world !== "products" && variant === "reserved") {
    console.error(
      `[demo-seed] the reserved org is always the products world: seed '${world}' ` +
        "with --variant visitor",
    )
    return { result: null, exitCode: 2 }
  }
  if (!findDemoWorldPack(world)) {
    console.error(`[demo-seed] the '${world}' world has no seed pack yet`)
    return { result: null, exitCode: 2 }
  }
  const passwordsEnv = flag(argv, "passwords-env")
  const personaPassword = passwordsEnv ? process.env[passwordsEnv] : flag(argv, "passwords")
  if (passwordsEnv && !personaPassword) {
    console.error(`[demo-seed] --passwords-env names ${passwordsEnv}, which is not set`)
    return { result: null, exitCode: 2 }
  }
  let resetContent = argv.includes("--no-reset")
    ? false
    : argv.includes("--reset") || variant === "reserved"
  const slug = flag(argv, "slug") ?? DEMO_RESERVED_SLUG
  // A private box (demo mode off) has no visitors and no reaper, and the
  // in-place content reset is a demo box's own: a visitor org it seeded before
  // is deleted and seeded fresh instead, as the lively tier's --replace does.
  // An org without the demo marker is refused there, before anything is deleted.
  if (resetContent && variant === "visitor" && !isDemoModeEnabled()) {
    await replaceSeededDemoOrg(slug, (msg) => console.log(`[demo-seed] ${msg}`), {
      who: "demo-seed",
      tier: "demo",
    })
    resetContent = false
  }
  const result = await seedWorld({
    orgSlug: slug,
    orgName: flag(argv, "name") ?? (world === "products" ? DEMO_COMPANY_NAME : undefined),
    worldId: world,
    variant,
    owner: variant === "reserved" ? reservedOwner() : undefined,
    locale: flag(argv, "locale"),
    personaPassword,
    resetContent,
    log: (msg) => console.log(`[demo-seed] ${msg}`),
  })
  // Pinned whether or not every layer landed, as `seedDemoOrgData` does: the
  // org layer got far enough to return an id, so the account exists.
  if (variant === "reserved") {
    await ensureReservedOwnerPassword(result.orgId)
    await ensureReservedSecondAdmin(result.orgId)
  }
  if (!result.complete) {
    console.error(
      `[demo-seed] FAILED: ${result.failures.map((f) => `${f.layer}: ${f.message}`).join("; ")}`,
    )
    return { result, exitCode: 1 }
  }
  const off =
    result.partsOff.length > 0 ? ` (off on this deployment: ${result.partsOff.join(", ")})` : ""
  console.log(`[demo-seed] org ${result.orgSlug} (${result.orgId}) seeded in full${off}`)
  return { result, exitCode: 0 }
}
