// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Stripe sync jobs over the REAL app database bridge on Postgres (the
// methods the sandbox gets, on one RLS transaction), with Stripe answered by a
// function: the first import of invoices that predate the connection, and the
// removal of the mirror on disconnect beside invoicing's documents.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { type SystemContext, withRlsContext } from "~/db/rls"
import { registerApps } from "~/modules/apps/runtime"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { insertSql } from "~/seed/factories/org/test-rows"
import { runBackfill } from "../../../../../bundled-apps/stripe/src/sync/backfill"
import type { SyncCtx } from "../../../../../bundled-apps/stripe/src/sync/common"
import { onDisconnect } from "../../../../../bundled-apps/stripe/src/sync/maintenance"

const ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const MANIFEST = JSON.parse(
  readFileSync(join(ROOT, "bundled-apps", "stripe", "app.manifest.json"), "utf8"),
)
const INVOICING = JSON.parse(
  readFileSync(join(ROOT, "bundled-apps", "invoicing", "app.manifest.json"), "utf8"),
)
const ORG = crypto.randomUUID()
const APP = "stripe"
const SCOPES: string[] = [`${APP}:*`]
const actor: SystemContext = { actorType: "system", orgId: ORG, purpose: "job", scopes: SCOPES }

type Fetch = SyncCtx["fetch"]
type Obj = Record<string, unknown>

let emitted: Array<{ entity: string; action: string }> = []

function syncCtx(tx: unknown, fetch: Fetch): SyncCtx & { db: { count: unknown } } {
  const bridge = createRpcBridge(
    APP,
    "system",
    ORG,
    tx as never,
    MANIFEST,
    SCOPES,
    "system",
    undefined,
    {
      actor,
    },
  ) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
  const call = async (name: string, ...args: unknown[]) => {
    const fn = bridge[name]
    if (!fn) throw new Error(`no bridge method ${name}`)
    const out = await fn(...args)
    return typeof out === "string" ? JSON.parse(out) : out
  }
  return {
    fetch,
    emit: async (e) => {
      emitted.push(e)
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
      delete: async (entity, id) => {
        await call("db_delete", entity, id)
      },
      count: (entity: string, opts?: unknown) =>
        call("db_count", entity, JSON.stringify(opts ?? {})),
    },
  }
}

/** Stripe: 50 invoices finalized in October, each paid by one charge; every other list empty. */
const OCT = Date.parse("2026-10-05T10:00:00Z") / 1000
const invoices: Obj[] = Array.from({ length: 50 }, (_, i) => ({
  id: `in_OLD${String(i).padStart(2, "0")}`,
  object: "invoice",
  livemode: false,
  customer: "cus_OLD",
  status: "paid",
  total: 1000 + i,
  amount_paid: 1000 + i,
  amount_due: 1000 + i,
  currency: "eur",
  status_transitions: { finalized_at: OCT + i * 3600, paid_at: OCT + i * 3600 + 60 },
}))
const charges: Obj[] = invoices.map((inv, i) => ({
  id: `ch_OLD${String(i).padStart(2, "0")}`,
  object: "charge",
  livemode: false,
  invoice: inv.id,
  customer: "cus_OLD",
  amount: inv.total,
  currency: "eur",
  status: "succeeded",
  created: OCT + i * 3600 + 60,
}))
const LISTS: Record<string, Obj[]> = { "/v1/invoices": invoices, "/v1/charges": charges }

const stripe: Fetch = async (url) => {
  const u = new URL(url)
  const list = LISTS[u.pathname] ?? []
  const limit = Number(u.searchParams.get("limit") ?? 10)
  const after = u.searchParams.get("starting_after")
  const start = after ? list.findIndex((o) => o.id === after) + 1 : 0
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({
      object: "list",
      data: list.slice(start, start + limit),
      has_more: start + limit < list.length,
    }),
  }
}

const count = async (table: string) =>
  Number(
    (
      await sql.unsafe(`SELECT count(*)::int AS n FROM app_stripe.${table} WHERE org_id = $1`, [
        ORG,
      ])
    )[0]?.n,
  )
const documents = async () =>
  Number(
    (
      await sql.unsafe(`SELECT count(*)::int AS n FROM app_invoicing.documents WHERE org_id = $1`, [
        ORG,
      ])
    )[0]?.n,
  )

beforeAll(async () => {
  await sql.unsafe(
    insertSql("kernel.organizations", {
      id: ORG,
      name: "Stripe sync",
      slug: `stripe-sync-${ORG.slice(0, 8)}`,
    }),
  )
  await registerApps(
    [
      {
        name: MANIFEST.name,
        version: MANIFEST.version,
        _format: "manifest" as const,
        _bundlePath: "/apps/stripe/handlers.js",
        scopes: MANIFEST.scopes,
        roles: MANIFEST.roles,
        schema: MANIFEST.schema,
        events: MANIFEST.events,
      },
      // Invoicing's tables, so its documents sit beside the mirror.
      {
        name: INVOICING.name,
        version: INVOICING.version,
        _format: "manifest" as const,
        _bundlePath: "/apps/invoicing/handlers.js",
        scopes: INVOICING.scopes,
        roles: INVOICING.roles,
        schema: INVOICING.schema,
      },
    ] as never,
    ORG,
  )
})

beforeEach(async () => {
  emitted = []
  for (const t of Object.keys(MANIFEST.schema))
    await sql.unsafe(`DELETE FROM app_stripe.${t} WHERE org_id = $1`, [ORG])
  await sql.unsafe(
    insertSql("app_stripe.install_metadata", {
      org_id: ORG,
      state: "waiting_first_event",
      livemode: false,
      permissions: "{}",
      connected_at: "2026-11-01T00:00:00Z",
    }),
  )
})

afterAll(async () => {
  for (const t of Object.keys(MANIFEST.schema))
    await sql.unsafe(`DELETE FROM app_stripe.${t} WHERE org_id = $1`, [ORG])
  await sql`DELETE FROM app_invoicing.documents WHERE org_id = ${ORG}`
  await sql`DELETE FROM app_invoicing.issuer_profiles WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.apps WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("stripe sync jobs on the real bridge", () => {
  it("fifty invoices finalized before the connection are mirrored and make no document and no unmatched payment", async () => {
    const before = await documents()
    const res = await withRlsContext(actor, (tx) => runBackfill(syncCtx(tx, stripe)))
    expect(res.outcome).toBe("done")
    expect(await count("stripe_invoices")).toBe(50)
    expect(await count("stripe_payments")).toBe(50)
    const issuers = (await sql.unsafe(
      `SELECT issuer, count(*)::int AS n FROM app_stripe.stripe_invoices WHERE org_id = $1 GROUP BY issuer`,
      [ORG],
    )) as unknown as Array<{ issuer: string; n: number }>
    expect(issuers).toEqual([{ issuer: "before_connection", n: 50 }])
    // Nothing announced: no invoice event for invoicing, no unmatched payment, no document.
    expect(emitted).toEqual([])
    expect(await documents()).toBe(before)
    const states = (await sql.unsafe(
      `SELECT resource, status, done_count FROM app_stripe.sync_state WHERE org_id = $1 ORDER BY resource`,
      [ORG],
    )) as unknown as Array<{ resource: string; status: string; done_count: number }>
    expect(states.find((s) => s.resource === "invoices")).toEqual({
      resource: "invoices",
      status: "done",
      done_count: 50,
    })
    expect(states.every((s) => s.status === "done")).toBe(true)
  })

  it("disconnecting deletes every mirror row and keeps every invoicing document", async () => {
    await withRlsContext(actor, (tx) => runBackfill(syncCtx(tx, stripe)))
    await sql.unsafe(
      insertSql("app_stripe.webhook_deliveries", {
        org_id: ORG,
        event_id: "evt_D1",
        topic: "invoice.paid",
        status: "processed",
        received_at: "2026-11-09T00:00:00Z",
      }),
    )
    await sql.unsafe(
      insertSql("app_stripe.stripe_mrr_events", {
        org_id: ORG,
        stripe_event_id: "evt_D1",
        subscription_id: "sub_1",
        customer_id: "cus_OLD",
        at: "2026-11-09T00:00:00Z",
        kind: "new",
        delta_minor: 4900,
        before_minor: 0,
        after_minor: 4900,
        currency: "eur",
        source: "webhook",
      }),
    )
    const issuer = crypto.randomUUID()
    await sql.unsafe(
      insertSql("app_invoicing.issuer_profiles", {
        id: issuer,
        org_id: ORG,
        legal_name: "Acme Example SAS",
        country: "FR",
        default_currency: "EUR",
      }),
    )
    for (let i = 0; i < 3; i++) {
      await sql.unsafe(
        insertSql("app_invoicing.documents", {
          org_id: ORG,
          type: "invoice",
          status: "issued",
          issuer_profile_id: issuer,
          currency: "EUR",
        }),
      )
    }
    for (const t of [
      "stripe_invoices",
      "stripe_payments",
      "sync_state",
      "install_metadata",
      "webhook_deliveries",
      "stripe_mrr_events",
    ]) {
      expect(await count(t)).toBeGreaterThan(0)
    }

    const res = await withRlsContext(actor, (tx) =>
      onDisconnect({ data: { appName: "stripe" } }, syncCtx(tx, stripe)),
    )
    expect(res?.done).toBe(true)
    for (const t of Object.keys(MANIFEST.schema))
      expect({ t, n: await count(t) }).toEqual({ t, n: 0 })
    expect(await documents()).toBe(3)
  })
})
