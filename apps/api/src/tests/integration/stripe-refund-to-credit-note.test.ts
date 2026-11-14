// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A refund made in Stripe, end to end on the real kernel, sandbox and Postgres: a SIGNED webhook
// through the real webhook route (signature, replay claim, app Off gate), the Stripe app's
// handler over the real database bridge (ledger, re-fetch, mirror, typed events into the
// outbox), the outbox delivering `stripe/*` to invoicing's subscribers in the sandbox, and
// invoicing's safety job asking the Stripe app for what an event missed. Stripe's API is a
// function answering by path; every assertion reads persisted rows.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash, createHmac, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "~/app"
import { sql } from "~/db"
import type { SystemContext, UserContext } from "~/db/rls"
import { flushEventHandlers, initEventBus } from "~/infra/events/event-bus"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { dispatchAppJobWithContext } from "~/infra/jobs/job-context"
import { JobsTestAccess } from "~/infra/jobs/jobs"
import { ObjectStorageTestAccess } from "~/infra/storage/object-storage"
import { redis } from "~/lib/redis"
import { resetAppRegistries, webhookHandlers } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { reloadOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { registerTemplate } from "~/modules/pdf/registry"
import { buildVerifyBridge } from "~/modules/webhooks/verify-bridge"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { handleStripeEvent, type IngestCtx } from "../../../../../bundled-apps/stripe/src/dispatch"
import {
  type StripeVerifyBridge,
  verifyStripeDelivery,
} from "../../../../../bundled-apps/stripe/src/verify"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const SECRET = "whsec_endToEndSigningSecret0123456789"
const ENDPOINT = "events"
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
let person: UserContext
let issuerId = ""

// --- Stripe: the objects as they are now, by path ---
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000)
const stripeObjects = new Map<string, Row>()
const refundsOf = (charge: string) =>
  [...stripeObjects.values()].filter((o) => o.object === "refund" && o.charge === charge)

const stripeFetch: IngestCtx["fetch"] = async (url) => {
  const u = new URL(url)
  const ok = (body: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(body) })
  if (u.pathname === "/v1/refunds") {
    return ok({
      object: "list",
      data: refundsOf(u.searchParams.get("charge") ?? ""),
      has_more: false,
    })
  }
  if (u.pathname === "/v1/invoice_payments") {
    const pi = u.searchParams.get("payment[payment_intent]")
    return ok({
      object: "list",
      data: pi === "pi_E1" ? [{ id: "inpay_E1", invoice: "in_E1" }] : [],
      has_more: false,
    })
  }
  const obj = stripeObjects.get(u.pathname)
  return obj
    ? ok({ livemode: false, ...obj })
    : { status: 404, headers: {}, body: JSON.stringify({ error: { message: "No such object" } }) }
}

function setRefund(id: string, amount: number, status: string): void {
  stripeObjects.set(`/v1/refunds/${id}`, {
    id,
    object: "refund",
    charge: "ch_E1",
    amount,
    currency: "eur",
    status,
    created: at("2026-11-16T09:00:00Z"),
  })
  const charge = stripeObjects.get("/v1/charges/ch_E1") as Row
  charge.amount_refunded = refundsOf("ch_E1")
    .filter((r) => r.status === "succeeded" || r.status === "pending")
    .reduce((s, r) => s + Number(r.amount), 0)
}

// --- The webhook route, signed ---
const actor = (): SystemContext => ({
  actorType: "system",
  orgId: ORG,
  purpose: "webhook",
  scopes: ["stripe:*"],
})

function ingestCtx(tx: unknown): IngestCtx {
  const bridge = createRpcBridge(
    "stripe",
    "system",
    ORG,
    tx as never,
    STRIPE as never,
    ["stripe:*"],
    "system",
    undefined,
    { actor: actor() },
  ) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
  const call = async (name: string, ...args: unknown[]) => {
    const fn = bridge[name]
    if (!fn) throw new Error(`no bridge method ${name}`)
    const out = await fn(...args)
    return typeof out === "string" ? JSON.parse(out) : out
  }
  return {
    fetch: stripeFetch,
    emit: async (e) => {
      await call("emit", JSON.stringify(e))
    },
    db: {
      findMany: (entity, opts) =>
        call("db_findMany", entity, JSON.stringify(opts ?? {})) as Promise<unknown[]>,
      insert: (entity, data) =>
        call("db_insert", entity, JSON.stringify(data)) as Promise<{ id: string }>,
      update: async (entity, id, data) => {
        await call("db_update", entity, id, JSON.stringify(data))
      },
      updateMany: (entity, opts) =>
        call("db_updateMany", entity, JSON.stringify(opts)) as Promise<{ count: number }>,
    },
  }
}

const verifyBridge = buildVerifyBridge({
  readConfig: async (key) => (key === "webhookSigningSecret" ? SECRET : null),
  secretConfigKeys: ["webhookSigningSecret", "webhookSigningSecretPrevious"],
  workersRun: true,
}) as unknown as StripeVerifyBridge

function registerWebhook(): void {
  webhookHandlers.set([ORG, "stripe", ENDPOINT], {
    appName: "stripe",
    orgId: ORG,
    verify: async (req: Request) => {
      const body = await req.text()
      return verifyStripeDelivery(
        {
          headers: Object.fromEntries(req.headers.entries()),
          body,
          method: req.method,
          query: {},
        },
        verifyBridge,
      )
    },
    handler: async (payload: unknown, ctx: { db: unknown }) =>
      handleStripeEvent(payload, ingestCtx(ctx.db)),
  } as never)
}

const replayKeys: string[] = []
let seq = 0

/** One Stripe event, signed with the endpoint's secret, through the route; then the outbox drains. */
async function deliver(type: string, objectId: string): Promise<number> {
  const id = `evt_e2e_${++seq}_${ORG.slice(0, 6)}`
  replayKeys.push(
    `webhook:replay:${ORG}:stripe:${ENDPOINT}:${createHash("sha256").update(id).digest("hex")}`,
  )
  const body = JSON.stringify({
    id,
    object: "event",
    type,
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: objectId } },
  })
  const t = Math.floor(Date.now() / 1000)
  const v1 = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")
  const res = await app.request(`/webhooks/${ORG}/stripe/${ENDPOINT}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${t},v1=${v1}` },
    body,
  })
  await drain()
  return res.status
}

async function drain(): Promise<void> {
  await flushEventHandlers()
  for (let i = 0; i < 20; i++) if (!(await processOutboxBatch())) break
  await flushEventHandlers()
}

async function setAppStatus(name: string, status: "active" | "disabled"): Promise<void> {
  await sql`UPDATE kernel.apps SET status = ${status} WHERE org_id = ${ORG} AND name = ${name}`
  await reloadOrgApps(ORG, { fresh: true })
  registerWebhook()
}

async function creditNotes(): Promise<Row[]> {
  return sql<Row[]>`
    SELECT external_ref, grand_total_minor::text AS total
    FROM app_invoicing.documents
    WHERE org_id = ${ORG} AND type = 'credit_note'
    ORDER BY external_ref`
}

describe("a Stripe refund becomes a credit note, end to end", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    ORG = (await createTestOrg()).id
    const admin = await minimal.person(ORG, { role: "admin" })
    person = {
      actorType: "user",
      userId: admin.id,
      orgId: ORG,
      scopes: ["invoicing:settings:write", "invoicing:documents:write", "invoicing:documents:read"],
      dimensionGrants: {},
    }
    initEventBus()
    await initSandboxPool()
    await initWorkerPool()
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
    await setAppStatus("stripe", "active")
    await setAppStatus("invoicing", "active")

    // An issuer in Paris whose card stream Liaison issues since 1 November.
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
    issuerId = String((created.data as Row).id)
    await sql`UPDATE app_invoicing.issuer_profiles SET timezone = 'Europe/Paris' WHERE id = ${issuerId}`
    await sql`DELETE FROM app_invoicing.stripe_streams WHERE org_id = ${ORG}`
    await sql.unsafe(
      insertSql("app_invoicing.stripe_streams", {
        id: randomUUID(),
        org_id: ORG,
        issuer_profile_id: issuerId,
        issuer: "liaison",
        stripe_connected: true,
        created_at: "2026-11-01T09:00:00.000Z",
      }),
    )
    await sql.unsafe(
      insertSql("app_stripe.install_metadata", {
        org_id: ORG,
        state: "connected",
        livemode: false,
        permissions: "{}",
        connected_at: "2026-11-01T09:00:00Z",
        webhook_confirmed_at: "2026-11-01T10:00:00Z",
      }),
    )

    // Stripe: a customer, a finalized and paid invoice of 120.00 (100.00 + 20% VAT), its charge.
    stripeObjects.set("/v1/customers/cus_E1", {
      id: "cus_E1",
      object: "customer",
      name: "Lumen Studio",
      email: "billing@lumen.example",
      address: { country: "FR", line1: "3 rue Neuve", postal_code: "69001", city: "Lyon" },
      created: at("2026-11-02T09:00:00Z"),
    })
    stripeObjects.set("/v1/invoices/in_E1", {
      id: "in_E1",
      object: "invoice",
      customer: "cus_E1",
      number: "ST-0001",
      status: "paid",
      total: 12000,
      amount_paid: 12000,
      amount_due: 12000,
      currency: "eur",
      total_taxes: [{ amount: 2000 }],
      period_start: at("2026-11-01T00:00:00Z"),
      period_end: at("2026-12-01T00:00:00Z"),
      status_transitions: {
        finalized_at: at("2026-11-15T10:00:00Z"),
        paid_at: at("2026-11-15T10:01:00Z"),
      },
      lines: {
        object: "list",
        has_more: false,
        data: [
          {
            id: "il_E1",
            description: "Pro plan",
            quantity: 1,
            amount: 10000,
            period: { start: at("2026-11-01T00:00:00Z"), end: at("2026-12-01T00:00:00Z") },
            taxes: [
              {
                amount: 2000,
                taxable_amount: 10000,
                tax_behavior: "exclusive",
                tax_rate_details: { tax_rate: { percentage: 20 } },
              },
            ],
          },
        ],
      },
    })
    stripeObjects.set("/v1/charges/ch_E1", {
      id: "ch_E1",
      object: "charge",
      amount: 12000,
      amount_refunded: 0,
      currency: "eur",
      customer: "cus_E1",
      payment_intent: "pi_E1",
      status: "succeeded",
      created: at("2026-11-15T10:01:00Z"),
    })
  }, 180_000)

  afterAll(async () => {
    for (const key of replayKeys) await redis.del(key)
    webhookHandlers.delete([ORG, "stripe", ENDPOINT])
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    ObjectStorageTestAccess.resetClient()
    await releaseTestLock()
  })

  it("a finalized invoice delivered as a signed webhook becomes one Liaison invoice from its lines and buyer", async () => {
    expect(await deliver("invoice.finalized", "in_E1")).toBe(200)
    expect(await deliver("charge.succeeded", "ch_E1")).toBe(200)
    const docs = await sql<Row[]>`
      SELECT external_ref, grand_total_minor::text AS total, counterparty_name AS buyer
      FROM app_invoicing.documents WHERE org_id = ${ORG} AND type = 'invoice'`
    expect([...docs]).toEqual([
      { external_ref: "stripe:in_E1", total: "12000", buyer: "Lumen Studio" },
    ])
    // A charge its invoice explains is not an unmatched payment.
    const unmatched =
      await sql`SELECT 1 FROM app_invoicing.deferred_events WHERE org_id = ${ORG} AND reason = 'stripe_payment_unmatched'`
    expect(unmatched).toHaveLength(0)
  }, 60_000)

  it("a partial refund and then a second one each make one credit note, summing to what was refunded; a redelivery adds none", async () => {
    setRefund("re_E1", 3000, "succeeded")
    expect(await deliver("charge.refunded", "ch_E1")).toBe(200)
    expect(await creditNotes()).toEqual([{ external_ref: "stripe:re_E1", total: "-3000" }])
    setRefund("re_E2", 4000, "succeeded")
    expect(await deliver("charge.refunded", "ch_E1")).toBe(200)
    expect(await deliver("charge.refunded", "ch_E1")).toBe(200)
    const notes = await creditNotes()
    expect(notes.map((n) => n.external_ref)).toEqual(["stripe:re_E1", "stripe:re_E2"])
    expect(notes.reduce((s, n) => s + Number(n.total), 0)).toBe(-7000)
  }, 60_000)

  it("a refund that fails makes no credit note", async () => {
    setRefund("re_E3", 1000, "pending")
    expect(await deliver("charge.refunded", "ch_E1")).toBe(200)
    setRefund("re_E3", 1000, "failed")
    expect(await deliver("charge.refund.updated", "re_E3")).toBe(200)
    expect((await creditNotes()).map((n) => n.external_ref)).toEqual([
      "stripe:re_E1",
      "stripe:re_E2",
    ])
    const failed = await sql<Row[]>`
      SELECT reason FROM app_invoicing.deferred_events
      WHERE org_id = ${ORG} AND event_id = 'stripe:re_E3:failed'`
    expect([...failed]).toEqual([{ reason: "refund_failed" }])
  }, 60_000)

  it("a refund made while invoicing was off gets its credit note from the safety job once invoicing is on", async () => {
    await setAppStatus("invoicing", "disabled")
    setRefund("re_E4", 2000, "succeeded")
    expect(await deliver("charge.refunded", "ch_E1")).toBe(200)
    await setAppStatus("invoicing", "active")
    await drain()
    expect((await creditNotes()).map((n) => n.external_ref)).not.toContain("stripe:re_E4")

    const handler = JobsTestAccess.getHandler("invoicing", "reconcile-stripe-payments")
    if (!handler) throw new Error("reconcile-stripe-payments is not registered")
    await dispatchAppJobWithContext(
      handler,
      { orgId: ORG },
      { actorType: "system", orgId: ORG, purpose: "job", scopes: ["invoicing:*"] },
      "session",
    )
    await drain()
    const notes = await creditNotes()
    expect(notes.map((n) => n.external_ref)).toEqual([
      "stripe:re_E1",
      "stripe:re_E2",
      "stripe:re_E4",
    ])
    expect(notes.reduce((s, n) => s + Number(n.total), 0)).toBe(-9000)
  }, 90_000)
})
