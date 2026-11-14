// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Stripe deliveries through the REAL webhook route (Redis replay claim, app Off
// gate, retry scheduling, status mapping) and the REAL app database bridge on
// Postgres. The app's handler runs host-side here (the route's function-handler
// path) over a bridge built on the delivery's own transaction, exactly the
// methods the sandbox gets; Stripe's API is a function answering by path.
//
// Also the mirror's write order under real concurrency: two transactions on two
// connections, held at a barrier so they commit in the reverse order of their
// re-fetches.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "~/app"
import { sql } from "~/db/connection"
import { type SystemContext, withRlsContext } from "~/db/rls"
import * as jobsModule from "~/infra/jobs/jobs"
import { redis } from "~/lib/redis"
import { resetAppRegistries, webhookHandlers } from "~/modules/apps/app-registries"
import { reloadOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { insertSql } from "~/seed/factories/org/test-rows"
import { handleStripeEvent, type IngestCtx } from "../../../../../bundled-apps/stripe/src/dispatch"
import { writeMirror } from "../../../../../bundled-apps/stripe/src/mirror"

const ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const MANIFEST = JSON.parse(
  readFileSync(join(ROOT, "bundled-apps", "stripe", "app.manifest.json"), "utf8"),
)
const ORG = crypto.randomUUID()
const APP = "stripe"
const ENDPOINT = "events"
// What the route gives a first-party handler that asks for nothing: the app's namespace.
const SCOPES: string[] = [`${APP}:*`]
const actor: SystemContext = { actorType: "system", orgId: ORG, purpose: "webhook", scopes: SCOPES }

type Fetch = IngestCtx["fetch"]

/** The app's ctx over the real bridge on `tx`, with Stripe answered by `fetch`. */
function ingestCtx(tx: unknown, fetch: Fetch): IngestCtx {
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

/** Stripe: the current invoice, with a status to answer once instead. */
let invoiceTotal = 2
const failNext: number[] = []
let stripeCalls = 0
const stripePaths: string[] = []
const stripe: Fetch = async (url) => {
  stripeCalls++
  stripePaths.push(new URL(url).pathname)
  const forced = failNext.shift()
  if (forced)
    return { status: forced, headers: {}, body: JSON.stringify({ error: { message: "down" } }) }
  const id = new URL(url).pathname.split("/").pop()
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({
      id,
      object: "invoice",
      livemode: false,
      customer: "cus_R1",
      status: "paid",
      total: invoiceTotal,
      amount_paid: invoiceTotal,
      amount_due: invoiceTotal,
      currency: "eur",
      status_transitions: { finalized_at: 1767229200, paid_at: 1767229300 },
    }),
  }
}

let handlerRuns = 0
const replayKeys: string[] = []

function register(): void {
  webhookHandlers.set([ORG, APP, ENDPOINT], {
    appName: APP,
    orgId: ORG,
    // The signature itself is covered by the verifier's tests; here the route
    // gets the replay key the verifier returns (the event id).
    verify: async (req: Request) => ({
      valid: true as const,
      replayKey: JSON.parse(await req.text()).id,
    }),
    handler: async (payload: unknown, ctx: { db: unknown }) => {
      handlerRuns++
      return handleStripeEvent(payload, ingestCtx(ctx.db, stripe))
    },
  } as never)
}

function deliver(id: string, type = "invoice.paid") {
  const key = `webhook:replay:${ORG}:${APP}:${ENDPOINT}:${createHash("sha256").update(id).digest("hex")}`
  replayKeys.push(key)
  return {
    key,
    res: app.request(`/webhooks/${ORG}/${APP}/${ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        type,
        livemode: false,
        created: 1767229300,
        data: { object: { id: "in_R1", total: 1 } },
      }),
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
const deliveries = async () =>
  (await sql.unsafe(
    `SELECT event_id, status, failure_count FROM app_stripe.webhook_deliveries WHERE org_id = $1 ORDER BY event_id`,
    [ORG],
  )) as unknown as Array<{ event_id: string; status: string; failure_count: number }>

beforeAll(async () => {
  await sql.unsafe(
    insertSql("kernel.organizations", {
      id: ORG,
      name: "Stripe ingest",
      slug: `stripe-ingest-${ORG.slice(0, 8)}`,
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
    ] as never,
    ORG,
  )
  await sql.unsafe(
    insertSql(
      "kernel.apps",
      {
        id: crypto.randomUUID(),
        org_id: ORG,
        name: APP,
        version: MANIFEST.version,
        status: "active",
      },
      { onConflictDoNothing: true },
    ),
  )
})

beforeEach(async () => {
  for (const t of Object.keys(MANIFEST.schema))
    await sql.unsafe(`DELETE FROM app_stripe.${t} WHERE org_id = $1`, [ORG])
  await sql.unsafe(
    insertSql("app_stripe.install_metadata", {
      org_id: ORG,
      state: "connected",
      livemode: false,
      permissions: "{}",
      connected_at: "2026-11-01T00:00:00Z",
      webhook_confirmed_at: "2026-11-02T00:00:00Z",
    }),
  )
  await sql`UPDATE kernel.apps SET status = 'active' WHERE org_id = ${ORG} AND name = ${APP}`
  await reloadOrgApps(ORG, { fresh: true })
  register()
  handlerRuns = 0
  stripeCalls = 0
  stripePaths.length = 0
  invoiceTotal = 2
  failNext.length = 0
})

afterAll(async () => {
  for (const key of replayKeys) await redis.del(key)
  webhookHandlers.delete([ORG, APP, ENDPOINT])
  resetAppRegistries()
  for (const t of Object.keys(MANIFEST.schema))
    await sql.unsafe(`DELETE FROM app_stripe.${t} WHERE org_id = $1`, [ORG])
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.apps WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

/** The stored deliveries of the test org, oldest first. */
async function inboxStatuses(): Promise<string[]> {
  const rows = await sql<{ status: string }[]>`
    SELECT status FROM kernel.webhook_inbox WHERE org_id = ${ORG} ORDER BY created_at`
  return rows.map((r) => r.status)
}

describe("stripe deliveries through the webhook route", () => {
  it("a handler failure releases the claim, queues the stored delivery's replay, answers 500 and the retry converges with no duplicate row", async () => {
    const enqueue = spyOn(jobsModule, "enqueueAppJob").mockResolvedValue(undefined as never)
    try {
      failNext.push(500)
      const first = deliver("evt_retry1")
      const res = await first.res
      expect(res.status).toBe(500)
      expect(await redis.exists(first.key)).toBe(0)
      // The delivery is stored before the handler runs; its replay is woken.
      expect(enqueue).toHaveBeenCalledWith(
        "kernel",
        "webhook-inbox-replay",
        expect.objectContaining({ orgId: ORG, inboxId: expect.any(String) }),
        expect.anything(),
      )
      expect(await inboxStatuses()).toEqual(["pending"])
      expect(await deliveries()).toEqual([
        { event_id: "evt_retry1", status: "failed", failure_count: 1 },
      ])
      expect(await count("stripe_invoices")).toBe(0)

      // The retry (Stripe's redelivery, the claim being free) converges.
      const again = await deliver("evt_retry1").res
      expect(again.status).toBe(200)
      expect(await deliveries()).toEqual([
        { event_id: "evt_retry1", status: "processed", failure_count: 1 },
      ])
      expect(await count("stripe_invoices")).toBe(1)
      expect(handlerRuns).toBe(2)
      expect(await inboxStatuses()).toEqual(["done"])
    } finally {
      enqueue.mockRestore()
    }
  })

  it("with the app off a delivery answers 200 and writes nothing", async () => {
    await sql`UPDATE kernel.apps SET status = 'disabled' WHERE org_id = ${ORG} AND name = ${APP}`
    await reloadOrgApps(ORG, { fresh: true })
    const { res } = deliver("evt_off1")
    const r = await res
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual(expect.objectContaining({ dropped: expect.any(String) }))
    expect(handlerRuns).toBe(0)
    expect(stripeCalls).toBe(0)
    expect(await count("webhook_deliveries")).toBe(0)
    expect(await count("stripe_invoices")).toBe(0)
  })

  it("a duplicate event within its window is answered as a duplicate from the stored delivery, with no claim and no handler run", async () => {
    const first = deliver("evt_dup1")
    expect((await first.res).status).toBe(200)
    await redis.del(first.key)
    const second = await deliver("evt_dup1").res
    expect(second.status).toBe(200)
    expect(((await second.json()) as { data: unknown }).data).toEqual({
      received: true,
      duplicate: true,
    })
    expect(handlerRuns).toBe(1)
    expect(await count("stripe_invoices")).toBe(1)
  })

  it("a duplicate event changes nothing once the replay claim and the stored delivery are gone, because the ledger stops it", async () => {
    const first = deliver("evt_dup2")
    expect((await first.res).status).toBe(200)
    const mirror = await sql.unsafe(`SELECT * FROM app_stripe.stripe_invoices WHERE org_id = $1`, [
      ORG,
    ])
    expect(mirror.length).toBe(1)
    const fetchesBefore = stripeCalls
    const eventsBefore = Number(
      (await sql`SELECT count(*)::int AS n FROM kernel.pending_events WHERE org_id = ${ORG}`)[0]?.n,
    )

    // The claim expires (or the cache is reset) and the stored delivery is past its
    // dedup window: the second delivery reaches the handler.
    await redis.del(first.key)
    await sql`DELETE FROM kernel.webhook_inbox WHERE org_id = ${ORG}`
    invoiceTotal = 999
    const second = await deliver("evt_dup2").res
    expect(second.status).toBe(200)
    expect(handlerRuns).toBe(2)
    expect(stripeCalls).toBe(fetchesBefore)
    expect(
      await sql.unsafe(`SELECT * FROM app_stripe.stripe_invoices WHERE org_id = $1`, [ORG]),
    ).toEqual(mirror)
    expect(
      Number(
        (await sql`SELECT count(*)::int AS n FROM kernel.pending_events WHERE org_id = ${ORG}`)[0]
          ?.n,
      ),
    ).toBe(eventsBefore)
    expect(await deliveries()).toEqual([
      { event_id: "evt_dup2", status: "processed", failure_count: 0 },
    ])
  })

  it("two deliveries of one event at the same moment apply it once", async () => {
    // Two connections: the second insert of the ledger row waits on the first's
    // unique entry, then finds it processed.
    const run = () =>
      withRlsContext(actor, (tx) =>
        handleStripeEvent(
          {
            id: "evt_same",
            type: "invoice.paid",
            livemode: false,
            data: { object: { id: "in_R1" } },
          },
          ingestCtx(tx, stripe),
        ),
      )
    const results = await Promise.all([run(), run()])
    // Either may win; exactly one applies it and the other finds it handled.
    expect(results.map((r) => `${r.status} ${r.body ?? "applied"}`).sort()).toEqual([
      "200 Event evt_same was already handled; nothing changed.",
      "200 applied",
    ])
    // One application's fetches only: the invoice re-fetch, then its customer for the
    // invoicing payload. The run that found it handled fetched nothing.
    expect(stripePaths).toEqual(["/v1/invoices/in_R1", "/v1/customers/cus_R1"])
    expect(await count("stripe_invoices")).toBe(1)
    expect(await deliveries()).toEqual([
      { event_id: "evt_same", status: "processed", failure_count: 0 },
    ])
  })
})

describe("mirror write order", () => {
  it("two re-fetches committing in reverse order leave the later state", async () => {
    await sql.unsafe(
      insertSql("app_stripe.stripe_invoices", {
        org_id: ORG,
        stripe_id: "in_ORDER",
        customer_id: "cus_R1",
        status: "draft",
        total_minor: 100,
        tax_minor: 0,
        amount_paid_minor: 0,
        amount_due_minor: 100,
        currency: "eur",
        stripe_updated: "2026-11-10T11:00:00.000Z",
      }),
    )
    const row = (status: string) => ({
      stripe_id: "in_ORDER",
      customer_id: "cus_R1",
      status,
      total_minor: 100,
      tax_minor: 0,
      amount_paid_minor: status === "paid" ? 100 : 0,
      amount_due_minor: 100,
      currency: "eur",
    })
    let release!: () => void
    const bothRead = new Promise<void>((r) => {
      let n = 0
      release = () => {
        if (++n === 2) r()
      }
    })
    let newerUpdated!: () => void
    const newerHoldsLock = new Promise<void>((r) => {
      newerUpdated = r
    })
    let olderTried = false

    // The OLDER re-fetch (started 12:00:01, saw "open") reads first, then waits
    // until the newer one holds the row lock, then writes: its UPDATE waits on
    // that lock and re-checks its WHERE after the newer one commits.
    const older = withRlsContext(actor, async (tx) => {
      const ctx = ingestCtx(tx, stripe)
      let reads = 0
      const db = {
        ...ctx.db,
        findMany: async (e: string, o?: { where?: Record<string, unknown>; limit?: number }) => {
          const out = await ctx.db.findMany(e, o)
          if (reads++ === 0) {
            release()
            await bothRead
            await newerHoldsLock
          }
          return out
        },
        updateMany: async (
          e: string,
          o: { where: Record<string, unknown>; data: Record<string, unknown> },
        ) => {
          olderTried = true
          return ctx.db.updateMany(e, o)
        },
      }
      return writeMirror(db, "stripe_invoices", row("open"), "2026-11-10T12:00:01.000Z")
    })
    // The NEWER re-fetch (started 12:00:02, saw "paid") writes and commits last-but-first.
    const newer = withRlsContext(actor, async (tx) => {
      const ctx = ingestCtx(tx, stripe)
      const db = {
        ...ctx.db,
        findMany: async (e: string, o?: { where?: Record<string, unknown>; limit?: number }) => {
          const out = await ctx.db.findMany(e, o)
          release()
          await bothRead
          return out
        },
        updateMany: async (
          e: string,
          o: { where: Record<string, unknown>; data: Record<string, unknown> },
        ) => {
          const r = await ctx.db.updateMany(e, o)
          newerUpdated()
          // Keep the transaction (and its row lock) open while the older one tries.
          await new Promise((res) => setTimeout(res, 300))
          return r
        },
      }
      return writeMirror(db, "stripe_invoices", row("paid"), "2026-11-10T12:00:02.000Z")
    })
    // Mutation caught: an unconditional write (WHERE on the id alone) lets the older state win.
    const [o, n] = await Promise.all([older, newer])
    expect(olderTried).toBe(true)
    expect(n).toBe("updated")
    expect(o).toBe("stale")
    const [final] = (await sql.unsafe(
      `SELECT status, stripe_updated FROM app_stripe.stripe_invoices WHERE org_id = $1 AND stripe_id = 'in_ORDER'`,
      [ORG],
    )) as unknown as Array<{ status: string; stripe_updated: Date }>
    expect(final?.status).toBe("paid")
    expect(new Date(final?.stripe_updated as Date).toISOString()).toBe("2026-11-10T12:00:02.000Z")
  })
})
