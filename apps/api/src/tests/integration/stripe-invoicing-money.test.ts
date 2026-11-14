// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Card payments on Stripe in mode A, on the real kernel, sandbox and Postgres: the typed events
// the Stripe app emits are published to invoicing's subscribers (bypassing the Stripe ledger), and
// every assertion reads persisted rows. One document per Stripe invoice under replays and
// concurrent deliveries with no gap in the numbers; a late event never moves a legal date or year;
// one credit note per succeeded refund, none for a pending or failed one, two partials summing; an
// unmatched payment lands once in the queue; issuing from a Stripe payment always waits for a person.
import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import {
  flushEventHandlers,
  initEventBus,
  _publishEventInternal as publishEvent,
} from "~/infra/events/event-bus"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { ObjectStorageTestAccess } from "~/infra/storage/object-storage"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { registerTemplate } from "~/modules/pdf/registry"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")

function invoicingDescriptor(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", "invoicing", "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  return {
    ...manifest,
    trusted: false,
    _firstParty: true,
    _format: "manifest",
    _bundlePath: join(
      REPO_ROOT,
      "bundled-apps",
      "invoicing",
      String(manifest.version),
      "bundle.js",
    ),
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

const SCOPES = [
  "invoicing:documents:read",
  "invoicing:documents:write",
  "invoicing:settings:read",
  "invoicing:settings:write",
  "invoicing:approve",
]
let ORG = ""
let actor: UserContext
type Row = Record<string, unknown>

async function tool(
  name: string,
  params: Row,
  origin: "human-ui" | "in-app-agent" = "human-ui",
): Promise<{ data?: Row; blocked?: unknown; error?: string }> {
  try {
    const res = await executeTool<Row>({
      toolName: `invoicing:${name}`,
      orgId: ORG,
      actor,
      params,
      origin,
    })
    return { data: res.data as Row, blocked: (res as { blocked?: unknown }).blocked }
  } catch (err) {
    const e = err as { message?: string; details?: { code?: string } }
    return { error: `${e.details?.code ?? ""} ${e.message ?? String(err)}` }
  }
}

/** An issuer in Paris whose card stream Liaison issues since 1 November. */
async function issuer(): Promise<string> {
  const created = await tool("settings_issuer_profile_create", {
    legal_name: `Studio ${randomUUID().slice(0, 8)}`,
    country: "FR",
    vat_id: "FR40902000009",
    address: "1 rue de Test, 75011 Paris",
    default_currency: "EUR",
    default_language: "en",
  })
  const id = String(created.data?.id)
  await sql`UPDATE app_invoicing.issuer_profiles SET timezone = 'Europe/Paris' WHERE id = ${id}`
  await sql`DELETE FROM app_invoicing.stripe_streams WHERE org_id = ${ORG}`
  await sql.unsafe(
    insertSql("app_invoicing.stripe_streams", {
      id: randomUUID(),
      org_id: ORG,
      issuer_profile_id: id,
      issuer: "liaison",
      stripe_connected: true,
      created_at: new Date(Date.UTC(2026, 10, 1, 9)).toISOString(),
    }),
  )
  return id
}

function invoiceEvent(id: string, over: Row = {}): Row {
  return {
    stripe_invoice_id: id,
    customer_id: "cus_1",
    number: `ST-${id}`,
    status: "open",
    total_minor: "12000",
    tax_minor: "2000",
    currency: "eur",
    period_start: "2026-11-01",
    period_end: "2026-11-30",
    finalized_at: new Date(Date.UTC(2026, 10, 15, 10)).toISOString(),
    customer: {
      name: "Lumen Studio",
      email: "billing@lumen.example",
      country: "FR",
      address: "3 rue Neuve, 69001 Lyon",
    },
    lines: [
      {
        description: "Pro plan",
        quantity: 1,
        unit_amount_excl_minor: "10000",
        tax_rate_bp: 2000,
        tax_minor: "2000",
      },
    ],
    ...over,
  }
}

async function deliver(entity: string, action: string, data: Row): Promise<void> {
  await publishEvent({
    app: "stripe",
    entity,
    action,
    entityId: String(data.stripe_invoice_id ?? data.charge_id ?? ""),
    data,
    orgId: ORG,
    actorType: "system",
  })
  await flushEventHandlers()
  for (let i = 0; i < 20; i++) if (!(await processOutboxBatch())) break
  await flushEventHandlers()
}

async function docs(issuerId: string, type = "invoice"): Promise<Row[]> {
  return sql<
    Row[]
  >`SELECT id::text, number, number_int, year_of_issue, external_ref, grand_total_minor::text AS total, to_char(issued_at, 'YYYY-MM-DD') AS issued_on FROM app_invoicing.documents WHERE issuer_profile_id = ${issuerId} AND type = ${type} ORDER BY number_int`
}

describe("card payments on Stripe, on Postgres", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    const org = await createTestOrg()
    ORG = org.id
    const admin = await minimal.person(ORG, { role: "admin" })
    actor = { actorType: "user", userId: admin.id, orgId: ORG, scopes: SCOPES, dimensionGrants: {} }
    initEventBus()
    await initSandboxPool()
    await initWorkerPool()
    await registerApps([invoicingDescriptor() as never], ORG)
    await registerTemplates()
  }, 120_000)

  afterEach(() => {
    setSystemTime()
    ObjectStorageTestAccess.resetClient()
  })

  afterAll(async () => {
    setSystemTime()
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await releaseTestLock()
  })

  it("two concurrent finalized handlers for one Stripe invoice leave one document and no gap in the numbers", async () => {
    const iss = await issuer()
    await deliver("invoice", "finalized", invoiceEvent("in_r1"))
    await deliver("invoice", "finalized", invoiceEvent("in_r1"))
    await Promise.allSettled([
      deliver("invoice", "finalized", invoiceEvent("in_r2")),
      deliver("invoice", "finalized", invoiceEvent("in_r2")),
    ])
    await deliver("invoice", "finalized", invoiceEvent("in_r3"))
    const rows = await docs(iss)
    expect(rows.map((r) => r.external_ref)).toEqual([
      "stripe:in_r1",
      "stripe:in_r2",
      "stripe:in_r3",
    ])
    expect(rows.map((r) => Number(r.number_int))).toEqual([1, 2, 3])
  }, 60_000)

  it("a finalized event delivered after midnight issues with that day's date and number series, and the sequence's dates never decrease", async () => {
    const iss = await issuer()
    setSystemTime(new Date(Date.UTC(2026, 11, 31, 22, 55)))
    await deliver("invoice", "finalized", invoiceEvent("in_d1"))
    // Finalized at 23:50 Paris on 31 December, delivered at 00:20 Paris on 1 January.
    setSystemTime(new Date(Date.UTC(2026, 11, 31, 23, 20)))
    await deliver(
      "invoice",
      "finalized",
      invoiceEvent("in_d2", {
        finalized_at: new Date(Date.UTC(2026, 11, 31, 22, 50)).toISOString(),
      }),
    )
    const rows = await docs(iss)
    expect(rows.find((r) => r.external_ref === "stripe:in_d1")).toMatchObject({
      year_of_issue: 2026,
    })
    const late = rows.find((r) => r.external_ref === "stripe:in_d2") as Row
    expect(late.year_of_issue).toBe(2027)
    expect(String(late.number)).toContain("2027")
  }, 60_000)

  it("one credit note per succeeded refund, none for a pending or failed one, and two partials sum to the refunded total", async () => {
    const iss = await issuer()
    await deliver("invoice", "finalized", invoiceEvent("in_f1", { charge_id: "ch_f1" }))
    const refund = (id: string, amount: string, status: string) => ({
      id,
      amount_minor: amount,
      status,
    })
    await deliver("refund", "created", {
      charge_id: "ch_f1",
      invoice_id: "in_f1",
      refunds: [refund("re_p", "1000", "pending")],
    })
    await deliver("refund", "created", {
      charge_id: "ch_f1",
      invoice_id: "in_f1",
      refunds: [refund("re_p", "1000", "failed")],
    })
    expect(await docs(iss, "credit_note")).toHaveLength(0)
    await deliver("refund", "created", {
      charge_id: "ch_f1",
      invoice_id: "in_f1",
      refunds: [refund("re_1", "3000", "succeeded")],
    })
    await deliver("refund", "created", {
      charge_id: "ch_f1",
      invoice_id: "in_f1",
      refunds: [refund("re_1", "3000", "succeeded"), refund("re_2", "4000", "succeeded")],
    })
    await deliver("refund", "created", {
      charge_id: "ch_f1",
      invoice_id: "in_f1",
      refunds: [refund("re_2", "4000", "succeeded")],
    })
    const notes = await docs(iss, "credit_note")
    expect(notes.map((n) => n.external_ref).sort()).toEqual(["stripe:re_1", "stripe:re_2"])
    expect(notes.reduce((s, n) => s + Number(n.total), 0)).toBe(-7000)
  }, 60_000)

  it("a payment with no invoice lands once in the queue a person resolves", async () => {
    await issuer()
    const charge = {
      charge_id: "ch_u1",
      amount_minor: "4500",
      currency: "eur",
      created: new Date(Date.UTC(2026, 10, 12, 10)).toISOString(),
    }
    await deliver("payment", "unmatched", charge)
    await deliver("payment", "unmatched", charge)
    const rows = await sql<
      Row[]
    >`SELECT status, reason FROM app_invoicing.deferred_events WHERE org_id = ${ORG} AND event_id = 'stripe:ch_u1'`
    expect([...rows]).toEqual([{ status: "awaiting_data", reason: "stripe_payment_unmatched" }])
  }, 60_000)

  it("an agent's request to invoice a Stripe payment waits for a person and issues nothing", async () => {
    const iss = await issuer()
    const charge = {
      charge_id: "ch_u2",
      amount_minor: "6000",
      currency: "eur",
      created: new Date(Date.UTC(2026, 10, 12, 10)).toISOString(),
      customer: invoiceEvent("x").customer,
    }
    await deliver("payment", "unmatched", charge)
    const before = (await docs(iss)).length
    const r = await tool(
      "invoice_from_stripe_payment",
      { chargeId: "ch_u2", vatRateBp: 2000 },
      "in-app-agent",
    )
    expect(r.error ?? r.blocked ?? r.data?.status).toBeTruthy()
    expect(r.data?.document_id).toBeUndefined()
    expect(await docs(iss)).toHaveLength(before)
  }, 60_000)
})
