// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Self-heal coverage for `ensureInstallMetadata`.
//
// A connection is established on the kernel side (an active `shop`
// connected_account), but the app's `install_metadata` row is missing because
// the one-shot `kernel/connected_account:create` event was lost (best-effort
// pub/sub delivery raced app-subscriber registration and never replayed). Every
// Shopify tool then failed closed with the opaque `install_metadata row not
// found`. `ensureInstallMetadata` recovers by reconstructing the row from the
// live connection so reads proceed without a re-OAuth.
//
// The persisting heal lives on the job path only. Every read path (getShopifyClient, the read
// tools, home_load) resolves the row without writing, deriving it in memory from the connection
// when it is missing: scope taint refuses any tool that is not readOnly, and a read that inserts
// cannot be readOnly.
import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import { home_load } from "../handlers/home"
import { scanUnfulfilledOrdersJob } from "../handlers/scan-unfulfilled"
import { orders_search } from "../reads"
import { ensureInstallMetadata, getShopifyClient } from "./get-client"

const SHOP = "demo.myshopify.com"
const ORG = "00000000-0000-0000-0000-000000000001"
const ACCOUNT_ID = "00000000-0000-0000-0000-000000000003"

type StoredRow = { id: string } & Record<string, unknown>

interface Spy {
  inserts: Array<{ entity: string; data: Record<string, unknown> }>
  rows: Map<string, StoredRow[]>
}

function makeCtx(opts: {
  accounts?: Array<{ id?: string; identifier: string; status?: string }> | null
  seedMetadata?: Record<string, unknown> | null
  insertThrows?: boolean
}): { ctx: AppContext; spy: Spy } {
  const spy: Spy = { inserts: [], rows: new Map() }
  if (opts.seedMetadata) spy.rows.set("install_metadata", [{ id: "meta-1", ...opts.seedMetadata }])
  let nextId = 100
  const ctx = {
    orgId: ORG,
    db: {
      findMany: async (entity: string) => spy.rows.get(entity) ?? [],
      insert: async (entity: string, data: Record<string, unknown>) => {
        if (opts.insertThrows) throw new Error("read-only / unique violation")
        spy.inserts.push({ entity, data })
        const id = `row-${nextId++}`
        const arr = spy.rows.get(entity) ?? []
        arr.push({ id, ...data })
        spy.rows.set(entity, arr)
        return { id }
      },
    },
    // Flat sandbox connections bridge: getAccounts returns a JSON string.
    connections:
      opts.accounts === null
        ? {}
        : {
            getAccounts: async () => JSON.stringify(opts.accounts ?? []),
            getToken: async () => "token",
          },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    // Every Shopify GraphQL call answers with an empty connection page.
    fetch: async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ data: { orders: { edges: [], pageInfo: { hasNextPage: false } } } }),
    }),
    emit: async () => undefined,
  } as unknown as AppContext
  return { ctx, spy }
}

describe("ensureInstallMetadata — connected-but-uninitialised self-heal", () => {
  it("returns the existing row without inserting when metadata is present", async () => {
    const { ctx, spy } = makeCtx({ seedMetadata: { shop_domain: SHOP, connection_status: "connected" } })
    const meta = await ensureInstallMetadata(ctx)
    expect(meta?.shopDomain).toBe(SHOP)
    expect(spy.inserts).toHaveLength(0)
  })

  it("backfills install_metadata from the active shop connection when the row is missing", async () => {
    const { ctx, spy } = makeCtx({
      accounts: [{ id: ACCOUNT_ID, identifier: SHOP, status: "active" }],
    })
    const meta = await ensureInstallMetadata(ctx)
    expect(meta?.shopDomain).toBe(SHOP)
    expect(spy.inserts).toHaveLength(1)
    expect(spy.inserts[0]!.entity).toBe("install_metadata")
    expect(spy.inserts[0]!.data.shopDomain).toBe(SHOP)
    expect(spy.inserts[0]!.data.connectionId).toBe(ACCOUNT_ID)
    expect(spy.inserts[0]!.data.connectionStatus).toBe("connected")
  })

  it("returns null and does not insert when there is no connection at all", async () => {
    const { ctx, spy } = makeCtx({ accounts: null })
    const meta = await ensureInstallMetadata(ctx)
    expect(meta).toBeNull()
    expect(spy.inserts).toHaveLength(0)
  })

  it("does not heal from a non-Shopify identifier", async () => {
    const { ctx, spy } = makeCtx({ accounts: [{ id: ACCOUNT_ID, identifier: "not-a-shop" }] })
    const meta = await ensureInstallMetadata(ctx)
    expect(meta).toBeNull()
    expect(spy.inserts).toHaveLength(0)
  })

  it("still resolves the domain in-memory when the persist write is blocked", async () => {
    const { ctx } = makeCtx({
      accounts: [{ id: ACCOUNT_ID, identifier: SHOP }],
      insertThrows: true,
    })
    const meta = await ensureInstallMetadata(ctx)
    expect(meta?.shopDomain).toBe(SHOP)
    expect(meta?.connectionId).toBe(ACCOUNT_ID)
    expect(meta?.connectionStatus).toBe("connected")
  })
})

describe("read path: a missing install_metadata row is derived in memory, never written", () => {
  const connected = { accounts: [{ id: ACCOUNT_ID, identifier: SHOP, status: "active" }] }

  it("getShopifyClient builds a client from the connection record without inserting", async () => {
    const { ctx, spy } = makeCtx(connected)
    const client = await getShopifyClient(ctx)
    expect(client).toBeDefined()
    expect(spy.inserts).toHaveLength(0)
  })

  it("a read tool (orders_search) succeeds from the connection record without inserting", async () => {
    const { ctx, spy } = makeCtx(connected)
    const out = await orders_search({}, ctx)
    expect(Array.isArray(out.results)).toBe(true)
    expect(spy.inserts).toHaveLength(0)
  })

  it("home_load reports the connected shop without inserting", async () => {
    const { ctx, spy } = makeCtx(connected)
    const bundle = await home_load({}, ctx).catch(() => null)
    expect(spy.inserts).toHaveLength(0)
    expect(bundle?.connection.shopDomain).toBe(SHOP)
  })

  it("with neither a row nor a connection the read raises INSTALL_METADATA_MISSING", async () => {
    const { ctx, spy } = makeCtx({ accounts: null })
    await expect(getShopifyClient(ctx)).rejects.toMatchObject({ code: "INSTALL_METADATA_MISSING" })
    expect(spy.inserts).toHaveLength(0)
  })

  it("the hourly unfulfilled scan job persists the heal", async () => {
    const { ctx, spy } = makeCtx(connected)
    await scanUnfulfilledOrdersJob({}, ctx)
    expect(spy.inserts).toHaveLength(1)
    expect(spy.inserts[0]!.entity).toBe("install_metadata")
    expect(spy.inserts[0]!.data).toMatchObject({ shopDomain: SHOP, connectionId: ACCOUNT_ID })
  })
})

describe("throttle watermark: one org's back-pressure never reaches another", () => {
  const LOW_BUCKET = JSON.stringify({
    data: { ok: true },
    extensions: { cost: { throttleStatus: { currentlyAvailable: 1, restoreRate: 50 } } },
  })
  const OK_BUCKET = JSON.stringify({ data: { ok: true } })

  function ctxFor(orgId: string | undefined, body: string): AppContext {
    const { ctx } = makeCtx({ seedMetadata: { shop_domain: "shared-shop.myshopify.com", connection_status: "connected" }, accounts: [{ id: ACCOUNT_ID, identifier: "shared-shop.myshopify.com" }] })
    return Object.assign(ctx, { orgId, fetch: async () => ({ status: 200, headers: {}, body }) })
  }

  it("org A's low bucket throttles org A only, for the same shop domain", async () => {
    const orgA = "00000000-0000-0000-0000-0000000000aa"
    const orgB = "00000000-0000-0000-0000-0000000000bb"
    // Org A drains its bucket: the watermark is now set for (A, shop).
    await (await getShopifyClient(ctxFor(orgA, LOW_BUCKET))).query("query { ok }")
    // A fail-fast client (timeoutMs set) refuses at once when its watermark says wait.
    await expect(
      (await getShopifyClient(ctxFor(orgA, OK_BUCKET), { timeoutMs: 1_000 })).query("query { ok }"),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" })
    // Org B, same shop domain, starts with no watermark.
    const r = await (await getShopifyClient(ctxFor(orgB, OK_BUCKET), { timeoutMs: 1_000 })).query<{ ok: boolean }>(
      "query { ok }",
    )
    expect(r.ok).toBe(true)
  })

  it("a run without an org id neither writes nor reads a watermark", async () => {
    await (await getShopifyClient(ctxFor(undefined, LOW_BUCKET))).query("query { ok }")
    const r = await (await getShopifyClient(ctxFor(undefined, OK_BUCKET), { timeoutMs: 1_000 })).query<{ ok: boolean }>(
      "query { ok }",
    )
    expect(r.ok).toBe(true)
  })
})
