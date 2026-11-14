// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The card-payments stand-in on the real kernel, sandbox and Postgres, for a
// demo-marked org on a box with LIAISON_DEMO_PAYMENTS_FIXTURES set (a private
// walk or year box; the public demo box opens the same door with demo mode).
//
// The payments app runs as it ships: its jobs in the sandbox, its webhook
// handler through `executeManifestWebhook`, its money tools from source with
// their fetch going through the real sandbox egress bridge. The stand-in
// answers from the org's own mirror rows and its outside state in Redis, and a
// recorder where the transport sits proves that nothing reached the processor.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { maskWithNote } from "@liaison/shared"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type SystemContext, type UserContext, withRlsContext } from "~/db/rls"
import { flushEventHandlers, initEventBus } from "~/infra/events/event-bus"
import { dispatchAppJobWithContext } from "~/infra/jobs/job-context"
import { JobsTestAccess } from "~/infra/jobs/jobs"
import { ObjectStorageTestAccess } from "~/infra/storage/object-storage"
import { env } from "~/lib/env"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import { executeTool } from "~/modules/apps/execute-tool"
import { resetInstallTrustCache } from "~/modules/apps/install-trust"
import { reloadOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createEgressMethods } from "~/modules/apps/sandbox/bridge/egress"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { DemoRestrictionError } from "~/modules/demo/demo-egress"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { registerTemplate } from "~/modules/pdf/registry"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { drainOutbox } from "~/tests/helpers/outbox"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  type MoneyCtx,
  refundsCreate,
} from "../../../../../../../../bundled-apps/stripe/src/tools/refunds"
import { subscriptionCancel } from "../../../../../../../../bundled-apps/stripe/src/tools/subscriptions"
import { installDemoPaymentsConnection } from "./connection"
import { deliverDemoPaymentsEvent, settleDemoPaymentsDeliveries, standInEvent } from "./deliver"
import {
  forgetDemoPaymentsOutside,
  outsideObject,
  outsideObjectsOf,
  putOutsideObjects,
} from "./overlay"
import {
  DEMO_PAYMENTS_SENTINEL_KEY,
  KEY_SHAPED,
  PAYMENTS_STANDIN_HOST,
  standInHostedInvoiceUrl,
  standInInstallPermissions,
} from "./sentinel"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..", "..", "..")
const HOST = "api.stripe.com"
type Row = Record<string, unknown>

function manifestOf(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", name, "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
}
const STRIPE = manifestOf("stripe")

function descriptor(name: string): Record<string, unknown> {
  const manifest = manifestOf(name)
  return {
    ...manifest,
    trusted: false,
    _firstParty: true,
    _format: "manifest",
    _bundlePath: join(REPO_ROOT, "bundled-apps", name, String(manifest.version), "bundle.js"),
  }
}

async function registerTemplates(): Promise<void> {
  for (const kind of ["invoice", "credit_note"]) {
    const build = Bun.spawnSync(
      [
        process.execPath,
        "build",
        join(REPO_ROOT, "bundled-apps", "invoicing", "templates", `${kind}.ts`),
        "--target",
        "bun",
        "--external",
        "node:*",
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    if (build.exitCode !== 0)
      throw new Error(`template ${kind} build failed: ${build.stderr.toString()}`)
    let js = build.stdout.toString()
    const block = /export\s*\{([^}]*)\};?\s*$/.exec(js)
    const local = block?.[1]
      ?.split(",")
      .map((x) => x.trim())
      .map(
        (x) => /^(\w+)\s+as\s+renderTemplate$/.exec(x)?.[1] ?? (x === "renderTemplate" ? x : null),
      )
      .find((x) => x)
    if (!block || !local) throw new Error(`template ${kind} exports no renderTemplate`)
    js = `${js.slice(0, block.index)}\nglobalThis.renderTemplate = ${local};\n`
    registerTemplate("invoicing", `invoicing:${kind}_v1`, js)
  }
}

let ORG = ""
let ADMIN = ""
let person: UserContext
const onTheWire: string[] = []
const notes: Array<{ tool: string; params: Row }> = []
const flagBefore = env.LIAISON_DEMO_PAYMENTS_FIXTURES

const DAY = 86_400_000
const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString()
const NOW = Date.now()

// --- The org's mirror, as the demo seeder writes it (whole-second instants) ---
async function seedMirror(): Promise<void> {
  const row = (table: string, r: Row) =>
    sql.unsafe(
      insertSql(`app_stripe.${table}`, {
        id: randomUUID(),
        org_id: ORG,
        stripe_updated: iso(NOW - 10 * DAY),
        ...r,
      }),
    )
  for (const [id, email, name] of [
    ["cus_SIarlon", "claire@maison-arlon.example", "Maison Arlon"],
    ["cus_SIombre", "compta@cafe-ombre.example", "Café Ombre"],
  ] as const) {
    await row("stripe_customers", {
      stripe_id: id,
      email,
      name,
      currency: "eur",
      delinquent: false,
      address: JSON.stringify({
        country: "FR",
        line1: "3 rue Neuve",
        line2: null,
        postal_code: "69001",
        city: "Lyon",
      }),
      tax_ids: null,
      deleted_at: null,
      created_at_stripe: iso(NOW - 200 * DAY),
    })
  }
  const items = [
    {
      price_id: "price_SIteam",
      product_name: "Team",
      unit_amount: 39000,
      currency: "eur",
      interval: "month",
      interval_count: 1,
      quantity: 1,
      usage_type: "licensed",
      tax_behavior: "exclusive",
      tax_percent: 20,
    },
  ]
  for (const [id, customer, status] of [
    ["sub_SIarlon", "cus_SIarlon", "past_due"],
    ["sub_SIombre", "cus_SIombre", "active"],
  ] as const) {
    await row("stripe_subscriptions", {
      stripe_id: id,
      customer_id: customer,
      status,
      plan_name: "Team",
      items: JSON.stringify(items),
      discount_percent: null,
      discount_amount_minor: null,
      mrr_minor: 39000,
      currency: "eur",
      current_period_start: iso(NOW - 5 * DAY),
      current_period_end: iso(NOW + 25 * DAY),
      trial_end: null,
      cancel_at: null,
      canceled_at: null,
      // As the mirror keeps it: the day the processor started the subscription.
      started_at: iso(NOW - 400 * DAY),
    })
  }
  await row("stripe_invoices", {
    stripe_id: "in_SIarlonOpen",
    customer_id: "cus_SIarlon",
    subscription_id: "sub_SIarlon",
    number: "TF-0101",
    status: "open",
    total_minor: 46800,
    tax_minor: 7800,
    amount_paid_minor: 0,
    amount_due_minor: 46800,
    currency: "eur",
    period_start: iso(NOW - 5 * DAY),
    period_end: iso(NOW + 25 * DAY),
    billing_reason: "subscription_cycle",
    hosted_invoice_url: standInHostedInvoiceUrl("in_SIarlonOpen"),
    next_payment_attempt: iso(NOW + 2 * DAY),
    finalized_at: iso(NOW - 5 * DAY),
    paid_at: null,
  })
  await row("stripe_invoices", {
    stripe_id: "in_SIombrePaid",
    customer_id: "cus_SIombre",
    subscription_id: "sub_SIombre",
    number: "TF-0102",
    status: "paid",
    total_minor: 46800,
    tax_minor: 7800,
    amount_paid_minor: 46800,
    amount_due_minor: 0,
    currency: "eur",
    period_start: iso(NOW - 5 * DAY),
    period_end: iso(NOW + 25 * DAY),
    billing_reason: "subscription_cycle",
    hosted_invoice_url: standInHostedInvoiceUrl("in_SIombrePaid"),
    next_payment_attempt: null,
    finalized_at: iso(NOW - 5 * DAY),
    paid_at: iso(NOW - 5 * DAY + 60_000),
  })
  await row("stripe_payments", {
    stripe_id: "ch_SIombre",
    payment_intent: "pi_SIombre",
    invoice_id: "in_SIombrePaid",
    customer_id: "cus_SIombre",
    amount_minor: 46800,
    refunded_minor: 0,
    currency: "eur",
    status: "succeeded",
    failure_code: null,
    failure_message: null,
    card_brand: "visa",
    card_last4: "4242",
    card_exp: "04/29",
    created_at_stripe: iso(NOW - 5 * DAY + 60_000),
    disputed: false,
  })
  await row("stripe_payments", {
    stripe_id: "ch_SIarlonFailed",
    payment_intent: "pi_SIarlon",
    invoice_id: "in_SIarlonOpen",
    customer_id: "cus_SIarlon",
    amount_minor: 46800,
    refunded_minor: 0,
    currency: "eur",
    status: "failed",
    failure_code: "card_declined",
    failure_message: "Your card was declined.",
    card_brand: "mastercard",
    card_last4: "5108",
    card_exp: "02/27",
    created_at_stripe: iso(NOW - 5 * DAY + 60_000),
    disputed: false,
  })
  await sql.unsafe(
    insertSql("app_stripe.install_metadata", {
      org_id: ORG,
      state: "connected",
      livemode: false,
      account_id: "acct_SIstandin",
      account_name: "Stand-in",
      permissions: JSON.stringify(standInInstallPermissions(iso(NOW - 30 * DAY))),
      connected_at: iso(NOW - 30 * DAY),
      webhook_confirmed_at: iso(NOW - 30 * DAY),
      last_event_at: iso(NOW - 60_000),
    }),
  )
}

// --- The app's own calls, with their fetch through the real egress bridge ---
const actor = (): SystemContext => ({
  actorType: "system",
  orgId: ORG,
  purpose: "job",
  scopes: ["stripe:*"],
})

function moneyCtx(tx: unknown, approvalId: string): MoneyCtx {
  const bridge = createRpcBridge(
    "stripe",
    "system",
    ORG,
    tx as never,
    STRIPE as never,
    ["stripe:*"],
    "system",
    undefined,
    {
      actor: actor(),
    },
  ) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
  const call = async (name: string, ...args: unknown[]) => {
    const fn = bridge[name]
    if (!fn) throw new Error(`no bridge method ${name}`)
    const out = await fn(...args)
    return typeof out === "string" ? JSON.parse(out) : out
  }
  const egress = createEgressMethods({
    orgId: ORG,
    userId: ADMIN,
    appName: "stripe",
    actorType: "system",
    egress: async () => ({ allowedDomains: [HOST], manifest: { name: "stripe" } }),
    callerScopes: [],
    inheritedActor: { actorType: "system" as const },
    manifest: { name: "stripe" },
    txDb: null,
    resolveCredentials: async () => ({}),
  } as unknown as BridgeContext)
  return {
    // The host adds the stored key; here the demo connection's key, the sentinel.
    fetch: async (url, o) => {
      const raw = (await egress.fetch(
        url,
        JSON.stringify({
          method: o?.method ?? "GET",
          headers: { ...(o?.headers ?? {}), Authorization: `Bearer ${DEMO_PAYMENTS_SENTINEL_KEY}` },
          body: o?.body,
        }),
      )) as string
      return JSON.parse(raw) as { status: number; headers: Record<string, string>; body: string }
    },
    emit: async (e) => {
      await call("emit", JSON.stringify(e))
    },
    db: {
      findMany: (entity: string, opts?: unknown) =>
        call("db_findMany", entity, JSON.stringify(opts ?? {})) as Promise<unknown[]>,
      insert: (entity: string, data: unknown) =>
        call("db_insert", entity, JSON.stringify(data)) as Promise<{ id: string }>,
      update: async (entity: string, id: string, data: unknown) => {
        await call("db_update", entity, id, JSON.stringify(data))
      },
      updateMany: (entity: string, opts: unknown) =>
        call("db_updateMany", entity, JSON.stringify(opts)) as Promise<{ count: number }>,
      count: async () => 0,
    } as never,
    executeTool: async (tool, params) => {
      notes.push({ tool, params })
      return { status: "completed", result: { ok: true } } as never
    },
    approval: {
      approvalRequestId: approvalId,
      approvalDeciderId: ADMIN,
      toolName: "stripe:refunds_create",
    },
    approval_recordStarted: async () => {},
    approval_recordSucceeded: async () => {},
    approval_recordFailedNoEffect: async () => {},
    approval_recordAmbiguous: async () => {},
  }
}

/** The app's call in the RLS transaction a sandboxed call holds (not a privileged one). */
function asSystem<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
  return withRlsContext(actor(), (tx) => fn(tx), { pool: "jobs" })
}

async function drain(): Promise<void> {
  await settleDemoPaymentsDeliveries()
  await flushEventHandlers()
  // Until the outbox is empty: run beside other seeded files in one process,
  // their events sit ahead of this org's, far more than a few batches' worth.
  await drainOutbox({ maxRounds: 2000 })
}

async function runJob(job: string): Promise<void> {
  const handler = JobsTestAccess.getHandler("stripe", job)
  if (!handler) throw new Error(`${job} is not registered`)
  await dispatchAppJobWithContext(handler, { orgId: ORG }, actor(), "session")
}

const MIRROR = [
  "stripe_customers",
  "stripe_subscriptions",
  "stripe_invoices",
  "stripe_payments",
  "stripe_refunds",
  "stripe_disputes",
  "stripe_mrr_events",
]

/** The mirror's content: every row of every mirror table, without the write instants. */
async function mirrorSnapshot(): Promise<Record<string, Row[]>> {
  const out: Record<string, Row[]> = {}
  for (const table of MIRROR) {
    const rows = await sql.unsafe(
      `SELECT * FROM app_stripe.${table} WHERE org_id = $1 ORDER BY id`,
      [ORG],
    )
    out[table] = (rows as unknown as Row[]).map((r) => {
      const { stripe_updated: _s, updated_at: _u, created_at: _c, ...rest } = r
      return rest
    })
  }
  return out
}

async function install(): Promise<Row> {
  const [row] = await sql<Row[]>`SELECT * FROM app_stripe.install_metadata WHERE org_id = ${ORG}`
  return row as Row
}

describe("the card-payments stand-in on the real kernel", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    env.LIAISON_DEMO_PAYMENTS_FIXTURES = true
    DemoModeTestAccess.set(false)
    SandboxBridgeTestAccess.setFetchInterceptsHost(() => true)
    SandboxBridgeTestAccess.setFetch((async (input: unknown) => {
      onTheWire.push(String(input))
      return new Response("{}", { status: 599 })
    }) as unknown as typeof fetch)
    ORG = (await createTestOrg()).id
    const admin = await minimal.person(ORG, { role: "admin" })
    ADMIN = admin.id
    person = {
      actorType: "user",
      userId: admin.id,
      orgId: ORG,
      scopes: [
        "invoicing:settings:write",
        "invoicing:documents:write",
        "invoicing:documents:read",
        "stripe:*",
      ],
      dimensionGrants: {},
    }
    initEventBus()
    await initSandboxPool()
    await initWorkerPool()
    // Both apps run here as the in-tree apps they are. A catalog activation of
    // either name left in this database by an earlier file (an install whose
    // record is gone) would make the egress read the app as installed with no
    // grant, and refuse every host before the stand-in sees the call.
    await sql`DELETE FROM kernel.apps_active_version WHERE name IN ('invoicing', 'stripe')`
    resetInstallTrustCache()
    await registerApps([descriptor("invoicing") as never, descriptor("stripe") as never], ORG)
    await registerTemplates()
    for (const name of ["invoicing", "stripe"]) {
      await sql.unsafe(
        insertSql(
          "kernel.apps",
          {
            id: randomUUID(),
            org_id: ORG,
            name,
            version: String(manifestOf(name).version),
            status: "active",
          },
          { onConflictDoNothing: true },
        ),
      )
    }
    await reloadOrgApps(ORG, { fresh: true })
    await markOrgAsDemo(ORG, visitorMarker(24))
    await installDemoPaymentsConnection({ orgId: ORG, createdByUserId: ADMIN })

    // Liaison issues the card stream's invoices (mode A), from an issuer in Paris.
    const created = await executeTool<Row>({
      toolName: "invoicing:settings_issuer_profile_create",
      orgId: ORG,
      actor: person,
      origin: "human-ui",
      params: {
        legal_name: `Studio ${randomUUID().slice(0, 8)}`,
        country: "FR",
        vat_id: "FR40902000009",
        address: "1 rue de Test, 75011 Paris",
        default_currency: "EUR",
        default_language: "en",
      },
    })
    const issuerId = String((created.data as Row).id)
    await sql`DELETE FROM app_invoicing.stripe_streams WHERE org_id = ${ORG}`
    await sql.unsafe(
      insertSql("app_invoicing.stripe_streams", {
        id: randomUUID(),
        org_id: ORG,
        issuer_profile_id: issuerId,
        issuer: "liaison",
        stripe_connected: true,
        created_at: iso(NOW - 30 * DAY),
      }),
    )
    await seedMirror()
  }, 240_000)

  afterAll(async () => {
    env.LIAISON_DEMO_PAYMENTS_FIXTURES = flagBefore
    DemoModeTestAccess.set(null)
    SandboxBridgeTestAccess.setFetch(null)
    SandboxBridgeTestAccess.setFetchInterceptsHost(null)
    await forgetDemoPaymentsOutside(ORG)
    invalidateDemoMarker()
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    ObjectStorageTestAccess.resetClient()
    await releaseTestLock()
  })

  it("two runs of reconcile and of the upstream probe leave the mirror equal and no stalled state", async () => {
    const before = await mirrorSnapshot()
    for (let i = 0; i < 2; i++) {
      await runJob("reconcile")
      await runJob("probe-webhook-upstream")
    }
    expect(await mirrorSnapshot()).toEqual(before)
    const state = String((await install()).state)
    expect(state).toBe("connected")
    expect(state).not.toContain("stalled")
    expect(onTheWire.filter((u) => u.includes(HOST))).toEqual([])
  }, 120_000)

  it("the card update link in a demo org points at the stand-in host", async () => {
    const out = await executeTool<Row>({
      toolName: "stripe:card_update_link",
      orgId: ORG,
      actor: person,
      origin: "human-ui",
      params: { customerId: "cus_SIarlon" },
    })
    const data = out.data as Row
    expect(String(data.url)).toBe(`https://${PAYMENTS_STANDIN_HOST}/i/in_SIarlonOpen`)
    expect(data.kind).toBe("hosted_invoice")
  }, 60_000)

  it("an event whose object exists only in the outside state is mirrored after the app's handler runs", async () => {
    await putOutsideObjects(ORG, [
      {
        id: "cus_SIoutside",
        object: "customer",
        livemode: false,
        email: "finance@new-client.example",
        name: "New Client",
        currency: "eur",
        delinquent: false,
        address: null,
        tax_ids: null,
        created: Math.floor(NOW / 1000),
      },
    ])
    await deliverDemoPaymentsEvent(
      ORG,
      standInEvent("customer.created", { id: "cus_SIoutside", object: "customer" }),
    )
    await drain()
    const [row] = await sql<
      Row[]
    >`SELECT email, name FROM app_stripe.stripe_customers WHERE org_id = ${ORG} AND stripe_id = 'cus_SIoutside'`
    expect(row).toEqual({ email: "finance@new-client.example", name: "New Client" })
    expect(String((await install()).state)).toBe("connected")
  }, 60_000)

  it("the connection stays connected after an outside renewal", async () => {
    const at = Math.floor(NOW / 1000)
    await putOutsideObjects(ORG, [
      {
        id: "in_SIombreRenewal",
        object: "invoice",
        livemode: false,
        customer: "cus_SIombre",
        parent: {
          type: "subscription_details",
          subscription_details: { subscription: "sub_SIombre" },
        },
        number: "TF-0103",
        status: "paid",
        total: 46800,
        total_taxes: [{ amount: 7800 }],
        amount_paid: 46800,
        amount_due: 0,
        currency: "eur",
        period_start: at,
        period_end: at + 30 * 86400,
        billing_reason: "subscription_cycle",
        hosted_invoice_url: standInHostedInvoiceUrl("in_SIombreRenewal"),
        status_transitions: { finalized_at: at, paid_at: at },
      },
    ])
    await deliverDemoPaymentsEvent(
      ORG,
      standInEvent("invoice.paid", { id: "in_SIombreRenewal", object: "invoice" }),
    )
    await drain()
    const [row] = await sql<
      Row[]
    >`SELECT status, number FROM app_stripe.stripe_invoices WHERE org_id = ${ORG} AND stripe_id = 'in_SIombreRenewal'`
    expect(row).toEqual({ status: "paid", number: "TF-0103" })
    expect(String((await install()).state)).toBe("connected")
  }, 60_000)

  it("an approved refund on the stand-in issues one credit note citing the original number and date and updates the ticket", async () => {
    // The paid invoice is issued in Liaison first, as its finalisation would have issued it.
    await deliverDemoPaymentsEvent(
      ORG,
      standInEvent("invoice.finalized", { id: "in_SIombrePaid", object: "invoice" }),
    )
    await deliverDemoPaymentsEvent(
      ORG,
      standInEvent("charge.succeeded", { id: "ch_SIombre", object: "charge" }),
    )
    await drain()
    const [original] = await sql<Row[]>`
      SELECT id, number, issued_at FROM app_invoicing.documents
      WHERE org_id = ${ORG} AND type = 'invoice' AND external_ref = 'stripe:in_SIombrePaid'`
    expect(original?.number).toBeTruthy()

    const result = (await asSystem((tx) =>
      refundsCreate(
        {
          chargeId: "ch_SIombre",
          amountMinor: 46800,
          ticketId: "TICK-398",
          reason: "Charged twice",
        },
        moneyCtx(tx, "apr_SIrefund1"),
      ),
    )) as Row
    expect(result.status).toBe("succeeded")
    await drain()

    const notesNow = await sql<Row[]>`
      SELECT external_ref, original_document_id, grand_total_minor::text AS total FROM app_invoicing.documents
      WHERE org_id = ${ORG} AND type = 'credit_note'`
    expect(notesNow).toHaveLength(1)
    expect(notesNow[0]).toMatchObject({
      external_ref: `stripe:${result.refundId}`,
      original_document_id: original?.id,
      total: "-46800",
    })
    // The ticket gets the app's internal note naming the refund.
    expect(notes.filter((n) => n.tool === "tickets:addNote").map((n) => n.params.ticketId)).toEqual(
      ["TICK-398"],
    )
    // The mirror moved through the app's own webhook handler.
    const [charge] = await sql<
      Row[]
    >`SELECT refunded_minor::text AS refunded FROM app_stripe.stripe_payments WHERE org_id = ${ORG} AND stripe_id = 'ch_SIombre'`
    expect(charge?.refunded).toBe("46800")
    expect(onTheWire.filter((u) => u.includes(HOST))).toEqual([])
  }, 120_000)

  it("a second approval of the same refund issues nothing more", async () => {
    const again = (await asSystem((tx) =>
      refundsCreate(
        { chargeId: "ch_SIombre", amountMinor: 46800, ticketId: "TICK-398" },
        moneyCtx(tx, "apr_SIrefund1"),
      ),
    )) as Row
    expect(String(again.summary)).toContain("already made for this approval")
    await drain()
    expect(await outsideObjectsOf(ORG, "refund")).toHaveLength(1)
    const credit =
      await sql`SELECT 1 FROM app_invoicing.documents WHERE org_id = ${ORG} AND type = 'credit_note'`
    expect(credit).toHaveLength(1)
  }, 120_000)

  it("cancel at period end writes the overlay and the mirror", async () => {
    const out = (await asSystem((tx) =>
      subscriptionCancel(
        { subscriptionId: "sub_SIombre", atPeriodEnd: true },
        moneyCtx(tx, "apr_SIcancel1"),
      ),
    )) as Row
    expect(String(out.summary)).toContain("stays active until")
    await drain()
    expect(await outsideObject(ORG, "sub_SIombre")).toMatchObject({ cancel_at_period_end: true })
    const [row] = await sql<
      Row[]
    >`SELECT cancel_at, current_period_end FROM app_stripe.stripe_subscriptions WHERE org_id = ${ORG} AND stripe_id = 'sub_SIombre'`
    expect(row?.cancel_at).toEqual(row?.current_period_end)
  }, 120_000)

  it("no mirror row or fixture holds a key-shaped string, and emails are on .example with last 4 of 4242 or 5108 only", async () => {
    const snapshot = await mirrorSnapshot()
    const outside = []
    for (const kind of [
      "customer",
      "subscription",
      "invoice",
      "charge",
      "refund",
      "dispute",
      "event",
    ] as const) {
      outside.push(...(await outsideObjectsOf(ORG, kind)))
    }
    expect(KEY_SHAPED.test(JSON.stringify(snapshot))).toBe(false)
    expect(KEY_SHAPED.test(JSON.stringify(outside))).toBe(false)
    expect(KEY_SHAPED.test(JSON.stringify(await install()))).toBe(false)
    for (const c of snapshot.stripe_customers ?? [])
      expect(String(c.email)).toMatch(/@[a-z0-9.-]+\.example$/)
    for (const p of snapshot.stripe_payments ?? [])
      expect(["4242", "5108"]).toContain(String(p.card_last4))
    const [conn] = await sql<Row[]>`
      SELECT metadata FROM kernel.connected_accounts WHERE org_id = ${ORG} AND app_name = 'stripe'`
    expect(conn?.metadata).toMatchObject({ demo: true })
  }, 60_000)

  it("a key typed in a demo org is refused by the connector sentence and stored masked", async () => {
    DemoModeTestAccess.set(true)
    invalidateDemoMarker()
    try {
      const typed = `connect the real one: rk_live_${"51HxQzA9bC3dE4fG5hI6jK7lM8nO9pQrS"}`
      // What a message stores: the shared mask the message post applies, so a key pasted in chat is kept masked.
      expect(KEY_SHAPED.test(maskWithNote(typed).text)).toBe(false)
      let refused: unknown = null
      try {
        await withPrivilegedDb(ORG, "standin-typed-key", (tx) =>
          createCredentialConnection(tx, ORG, ADMIN, "stripe", "stripe", {
            identifier: "typed",
            ownerType: "org",
            credentials: { restrictedKey: `rk_live_${"51HxQzA9bC3dE4fG5hI6jK7lM8nO9pQrS"}` },
          }),
        )
      } catch (err) {
        refused = err
      }
      expect(refused).toBeInstanceOf(DemoRestrictionError)
      expect((refused as Error).message).toContain("cannot store real connector credentials")
      const [conn] = await sql<Row[]>`
        SELECT identifier FROM kernel.connected_accounts WHERE org_id = ${ORG} AND app_name = 'stripe'`
      expect(conn?.identifier).toBe("demo-payments")
    } finally {
      DemoModeTestAccess.set(false)
      invalidateDemoMarker()
    }
  }, 60_000)
})
