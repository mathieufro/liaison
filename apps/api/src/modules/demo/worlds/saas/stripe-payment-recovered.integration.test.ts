// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The money scenario's world beat on the real kernel: the software world
// seeded as a visitor org, then the customer whose card failed adds a new
// card. The injector writes the outside state and hands the processor's
// events to the payments app's own webhook handler (never the public webhook
// route); the app re-reads each object from the stand-in and writes its
// mirror, invoicing marks its document paid, and the figures move as the
// payments home and the tour read them. The reminder waiting on Home is then
// stopped by its own send check: the invoice it is about is paid.
//
//   bun run scripts/test-run.ts demo-seed --file src/modules/demo/worlds/saas/stripe-payment-recovered.integration.test.ts
import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SAAS_PAYMENT_RECOVERED_INJECTOR } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { flushEventHandlers, initEventBus } from "~/infra/events/event-bus"
import { decideApproval } from "~/modules/approvals/decide"
import { aggregateAttentionItems } from "~/modules/apps/attention-aggregator"
import { executeTool } from "~/modules/apps/execute-tool"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { writeAuditLog } from "~/modules/audit/service"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { worldInjectors } from "~/modules/demo/world/registry"
import { seedContext } from "~/seed/context"
import { actorFor } from "~/seed/factories/people/actors"
import {
  type SeedDemoWorldResult,
  seedDemoWorld,
  seedScenarioStart,
} from "~/seed/tiers/demo/seed-demo"
import { SAAS_ARLON_SUBSCRIPTION } from "~/seed/worlds/saas/plan"
import { drainOutbox } from "~/tests/helpers/outbox"
import { seededApps } from "~/tests/helpers/seeded-app-rows"
import { installFromDist } from "../../../../../test-support/seed/install-dist-apps"
import { paymentRecoveredInjector, recoveredCard } from "./payment-recovered"
import { settleDemoPaymentsDeliveries } from "./payments/deliver"
import { forgetDemoPaymentsOutside } from "./payments/overlay"

const CATALOG_WORLD_APPS = ["invoicing", "stripe"]
/** The catalog activations this file makes, undone at its end (no later file inherits them). */
const activated = seededApps()
const BOARD_DATE = new Date("2026-11-09T08:30:00.000Z")
const ORG_SLUG = `saas-card-recovered-${Date.now().toString(36)}`
const OWNER = {
  email: `owner@${ORG_SLUG}.example`,
  name: "Visitor Owner",
  password: "SaasWorld1!Owner",
}

type Row = Record<string, unknown>
let world: SeedDemoWorldResult
let appsRoot: string | null = null
const onTheWire: string[] = []

async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
  return withPrivilegedDb(world.orgId, "saas-card-recovered-test", async (tx) => {
    const r = await tx.execute(query)
    return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Row[]
  })
}

async function owner(): Promise<UserContext> {
  return actorFor(
    seedContext({ orgId: world.orgId, now: BOARD_DATE }),
    world.org.ownerUserId as string,
  )
}

interface MrrLine {
  mrrMinor: number
  pastDueMinor: number
  activeCount: number
}
async function mrr(): Promise<MrrLine> {
  const r = await executeTool<{ lines: MrrLine[] }>({
    toolName: "stripe:mrr_query",
    orgId: world.orgId,
    actor: await owner(),
    params: {},
    origin: "human-ui",
  })
  return (r.data as { lines: MrrLine[] }).lines[0] as MrrLine
}

/**
 * What the public webhook route leaves behind: it writes one audit row per
 * delivery, named for the endpoint. The app's own handler, called directly,
 * writes none, so a recovery that went through the route shows up here.
 */
const routeDeliveries = async () =>
  Number(
    (
      await rows(
        sql`SELECT count(*)::int AS n FROM kernel.audit_log
            WHERE org_id = ${world.orgId} AND app = 'stripe' AND entity_type = 'webhook'`,
      )
    )[0]?.n,
  )

async function drain(): Promise<void> {
  await settleDemoPaymentsDeliveries()
  await flushEventHandlers()
  // Until the outbox is empty: run beside other seeded files in one process,
  // their events sit ahead of this org's, far more than a few batches' worth.
  await drainOutbox({ maxRounds: 2000 })
}

const pastDueCount = async () =>
  Number(
    (
      await rows(
        sql`SELECT count(*)::int AS n FROM app_stripe.stripe_subscriptions
            WHERE org_id = ${world.orgId} AND status = 'past_due'`,
      )
    )[0]?.n,
  )

const reminder = async () =>
  (
    await rows(
      sql`SELECT id, status FROM kernel.approval_requests
          WHERE org_id = ${world.orgId} AND handle = 'demo-arlon-card-reminder'`,
    )
  )[0] as { id: string; status: string }

async function homeItem(entityId: string) {
  setSystemTime(BOARD_DATE)
  try {
    const feed = await aggregateAttentionItems({ orgId: world.orgId, actor: await owner() })
    return feed.items.find((i) => i.entityId === entityId)
  } finally {
    setSystemTime()
  }
}

beforeAll(async () => {
  DemoModeTestAccess.set(true)
  // Nothing reaches the processor: the stand-in answers every payments call.
  SandboxBridgeTestAccess.setFetch((async (input: unknown) => {
    onTheWire.push(String(input))
    return new Response("{}", { status: 599 })
  }) as unknown as typeof fetch)
  if (!process.env.LIAISON_APPS_DIR) {
    appsRoot = mkdtempSync(path.join(tmpdir(), "saas-card-recovered-"))
    process.env.LIAISON_APPS_DIR = path.join(appsRoot, "apps")
  }
  for (const app of CATALOG_WORLD_APPS) {
    activated.track(app)
    await installFromDist(app, crypto.randomUUID())
  }
  initEventBus()
  world = await seedDemoWorld({
    orgSlug: ORG_SLUG,
    worldId: "saas",
    variant: "visitor",
    owner: OWNER,
    baseTime: BOARD_DATE,
  })
}, 2_400_000)

afterAll(async () => {
  if (world) await forgetDemoPaymentsOutside(world.orgId)
  await activated.cleanup()
  SandboxBridgeTestAccess.setFetch(null)
  DemoModeTestAccess.set(null)
  if (appsRoot) rmSync(appsRoot, { recursive: true, force: true })
})

describe("the money scenario's recovered card", () => {
  it("the recovery is the software world's injector and runs no agent, so it needs no verification", () => {
    expect(world.failures).toEqual([])
    const injector = worldInjectors().get(SAAS_PAYMENT_RECOVERED_INJECTOR)
    expect(injector).toBe(paymentRecoveredInjector)
    expect(injector?.world).toBe("saas")
    expect(injector?.spends).toBe(false)
  })

  it("starting the money scenario in the software world writes no other world's approvals", async () => {
    const count = async () =>
      Number(
        (
          await rows(
            sql`SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${world.orgId}`,
          )
        )[0]?.n,
      )
    const before = await count()
    const ids = await seedScenarioStart(
      world.orgId,
      world.org.ownerUserId as string,
      "money",
      "saas",
    )
    expect(ids).toEqual([])
    expect(await count()).toBe(before)
  }, 120_000)

  it("after the recovered card the past due count is 6 at 191,700, MRR stays 8,470,800, the invoice is paid, the attention resolves and the reminder's guard stops a later send", async () => {
    // Before: seven past due at 336,700, and the reminder waits on the visitor's Home.
    expect(await pastDueCount()).toBe(7)
    const before = await mrr()
    expect([before.mrrMinor, before.pastDueMinor, before.activeCount]).toEqual([
      8_470_800, 336_700, 169,
    ])
    const waiting = await reminder()
    expect(waiting.status).toBe("pending")
    expect((await homeItem(waiting.id))?.metadata?.placement).toBe("standing_in")

    await paymentRecoveredInjector.injectWorldEvent({
      orgId: world.orgId,
      ownerUserId: world.org.ownerUserId as string,
      tourId: "kernel.scenario-saas-money",
      beatId: "card-updated",
      run: 0,
      runStartedAt: new Date(),
    })
    await drain()

    // The mirror, written by the app's own handler from the stand-in's answers.
    expect(await pastDueCount()).toBe(6)
    const after = await mrr()
    expect([after.mrrMinor, after.pastDueMinor, after.activeCount]).toEqual([
      8_470_800, 191_700, 169,
    ])
    const [sub] = await rows(
      sql`SELECT status, card_last4, card_exp FROM app_stripe.stripe_subscriptions
          WHERE org_id = ${world.orgId} AND stripe_id = ${SAAS_ARLON_SUBSCRIPTION}`,
    )
    // Its row leaves the payments home's failed payments.
    expect(sub?.status).toBe("active")
    // The card it bills is the new one, no longer the expired card.
    const card = recoveredCard(new Date())
    expect([sub?.card_last4, sub?.card_exp]).toEqual([
      card.last4,
      `12/${String((card.exp_year as number) % 100).padStart(2, "0")}`,
    ])
    const [invoice] = await rows(
      sql`SELECT status, amount_paid_minor FROM app_stripe.stripe_invoices
          WHERE org_id = ${world.orgId} AND subscription_id = ${SAAS_ARLON_SUBSCRIPTION}
          ORDER BY finalized_at DESC LIMIT 1`,
    )
    expect(invoice?.status).toBe("paid")
    expect(Number(invoice?.amount_paid_minor)).toBe(174_000)
    // Invoicing heard it: its document for that invoice is paid.
    const [doc] = await rows(
      sql`SELECT payment_status FROM app_invoicing.documents
          WHERE org_id = ${world.orgId} AND number = 'F-2026-0418'`,
    )
    expect(doc?.payment_status).toBe("paid")

    // The reminder asked again at the moment it would leave: the invoice is
    // paid, so approving it sends nothing and closes it, and Home lets it go.
    let refusal = ""
    try {
      await decideApproval({
        orgId: world.orgId,
        requestId: waiting.id,
        actor: await owner(),
        decision: "approve",
      })
    } catch (err) {
      refusal = JSON.stringify({
        message: (err as Error).message,
        details: (err as { details?: unknown }).details,
      })
    }
    const closed = await reminder()
    expect({ status: closed.status, why: refusal.includes("invoice_paid") }).toEqual({
      status: "cancelled",
      why: true,
    })
    expect(await homeItem(waiting.id)).toBeUndefined()
    expect(onTheWire).toEqual([])
    // The events reached the app's handler directly: the public route saw none.
    expect(await routeDeliveries()).toBe(0)
  }, 300_000)

  it("a second pass of the recovery changes nothing more", async () => {
    await paymentRecoveredInjector.injectWorldEvent({
      orgId: world.orgId,
      ownerUserId: world.org.ownerUserId as string,
      tourId: "kernel.scenario-saas-money",
      beatId: "card-updated",
      run: 0,
      runStartedAt: new Date(),
    })
    await drain()
    expect(await pastDueCount()).toBe(6)
    expect((await mrr()).pastDueMinor).toBe(191_700)
  }, 120_000)

  it("notices a delivery that went through the public webhook route", async () => {
    // The route's own audit write, as it makes it after a delivery.
    const before = await routeDeliveries()
    await withPrivilegedDb(world.orgId, "saas-card-recovered-test-route", (tx) =>
      writeAuditLog(tx, {
        orgId: world.orgId,
        actorType: "system",
        actorId: null,
        app: "stripe",
        entityType: "webhook",
        action: "webhook.events",
        metadata: { endpointName: "events" },
      }),
    )
    expect(await routeDeliveries()).toBe(before + 1)
  })
})
