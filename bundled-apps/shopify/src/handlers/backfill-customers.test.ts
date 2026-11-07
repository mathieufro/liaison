// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B11 — Customer backfill job tests.
//
// Behaviour exercised:
//   - bulkOperationRunQuery, poll currentBulkOperation → COMPLETED
//   - fetchToBlob + iterateJsonl → one resolveContact call per row
//   - cursor checkpoint every batch
//   - resume from cursor (skip already-imported rows)
//   - bulk-op FAILED → status=failed; row persisted; event emitted
//   - cached URL expired (404 on blob fetch) → re-runs bulkOperationRunQuery
//   - empty store → completes cleanly, status=completed
import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import { createEnforcingEmit } from "../lib/emit.testutil"
import { withTimer } from "../lib/timers.testutil"
import { validateFields } from "../lib/validate-fields.testutil"
import { backfillCustomersJob } from "./backfill-customers"

interface FetchResponse {
  status?: number
  body: unknown
}

interface ResolveCall {
  email?: string
  name?: string
  externalId?: string
}

interface DbRow extends Record<string, unknown> {
  id: string
}

interface UpdateLogEntry {
  entity: string
  id: string
  data: Record<string, unknown>
}

function makeCtx(opts: {
  shopifyFetch: FetchResponse[]
  blobs?: Record<string, unknown[]> // url -> JSONL rows
  blobErrors?: Record<string, "404">
  preload?: Record<string, DbRow[]>
}): {
  ctx: AppContext
  resolveContact: { calls: ResolveCall[] }
  updateLog: UpdateLogEntry[]
  events: Array<{ entity: string; action: string; entityId?: string; data?: unknown; metadata?: Record<string, unknown> }>
  tables: Map<string, DbRow[]>
  fetchCount: { current: number }
} {
  const responses = [...opts.shopifyFetch]
  const blobs = opts.blobs ?? {}
  const blobErrors = opts.blobErrors ?? {}
  const resolveCalls: ResolveCall[] = []
  const updateLog: UpdateLogEntry[] = []
  // Enforcing emit: throws if the job emits an `${entity}:${action}` not in the
  // real app.manifest.json. This is the M4 guard — customer:backfill_completed
  // was previously undeclared, so a permissive mock let the drift ship.
  const { emit, emits: events } = createEnforcingEmit()
  const tables = new Map<string, DbRow[]>()
  tables.set("install_metadata", [
    { id: "i1", shopDomain: "demo.myshopify.com", connectionId: "ca1", apiVersion: "2026-04" } as DbRow,
  ])
  if (opts.preload) {
    for (const [k, v] of Object.entries(opts.preload)) tables.set(k, [...v])
  }
  let counter = 1
  const fetchCount = { current: 0 }

  // url → blobId map (deterministic).
  const blobIdByUrl = new Map<string, string>()
  let blobCounter = 1
  function blobIdFor(url: string): string {
    let id = blobIdByUrl.get(url)
    if (!id) {
      id = `blob-${blobCounter++}`
      blobIdByUrl.set(url, id)
    }
    return id
  }

  const ctx = {
    userId: "u",
    orgId: "o",
    db: {
      findMany: async (entity: string, query?: { where?: Record<string, unknown> }) => {
        const rows = tables.get(entity) ?? []
        if (!query?.where) return rows
        return rows.filter((row) => {
          for (const [k, v] of Object.entries(query.where!)) {
            if (row[k] !== v) return false
          }
          return true
        })
      },
      findOne: async (entity: string, id: string) => {
        return (tables.get(entity) ?? []).find((r) => r.id === id) ?? null
      },
      insert: async (entity: string, data: Record<string, unknown>) => {
        // Enforce the kernel's write-path field allowlist (rpc-bridge.ts):
        // undeclared columns throw at runtime, so they must throw here too.
        validateFields(entity, data)
        const id = `${entity}-${counter++}`
        const row = { id, ...data } as DbRow
        tables.set(entity, [...(tables.get(entity) ?? []), row])
        return { id }
      },
      update: async (entity: string, id: string, data: Record<string, unknown>) => {
        validateFields(entity, data)
        updateLog.push({ entity, id, data })
        const rows = tables.get(entity) ?? []
        const idx = rows.findIndex((r) => r.id === id)
        if (idx >= 0) rows[idx] = { ...rows[idx], ...data } as DbRow
      },
      updateMany: async () => ({ count: 0 }),
      delete: async () => undefined,
      count: async () => 0,
    },
    emit,
    enqueueJob: async () => undefined,
    resolveContact: (async (params: ResolveCall) => {
      resolveCalls.push(params)
      return {}
    }) as AppContext["resolveContact"],
    connections: {
      shop: {
        getAccounts: async () => [
          {
            id: "ca1",
            ownerType: "org" as const,
            ownerId: null,
            identifier: "demo.myshopify.com",
            displayName: null,
          },
        ],
        getToken: async () => "test-token",
      },
    },
    fetch: async (_url: string) => {
      fetchCount.current++
      const next = responses.shift() ?? { body: {} }
      return { status: next.status ?? 200, headers: {}, body: JSON.stringify(next.body) }
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agent_run: async () => "{}",
    realtime_publish: async () => "{}",
    grants_setUserScopes: async () => "{}",
    bulk: {
      fetchToBlob: async (url: string) => {
        const err = blobErrors[url]
        if (err === "404") {
          const e = new Error(`blob fetch failed: 404 for ${url}`) as Error & { code?: string; status?: number }
          e.code = "BLOB_FETCH_404"
          e.status = 404
          throw e
        }
        const rows = blobs[url] ?? []
        return { blobId: blobIdFor(url), sizeBytes: JSON.stringify(rows).length }
      },
      iterateJsonl: async function* (blobId: string, iterOpts?: { batchSize?: number }) {
        // Find the URL by reverse lookup.
        const url = [...blobIdByUrl.entries()].find(([, id]) => id === blobId)?.[0]
        const rows = url ? blobs[url] ?? [] : []
        const batchSize = iterOpts?.batchSize ?? 50
        for (let i = 0; i < rows.length; i += batchSize) {
          yield rows.slice(i, i + batchSize)
        }
      },
      deleteBlob: async () => undefined,
    },
  } as unknown as AppContext

  return { ctx, resolveContact: { calls: resolveCalls }, updateLog, events, tables, fetchCount }
}

const bulkRunQueryOk = (id = "bo1"): FetchResponse => ({
  body: {
    data: { bulkOperationRunQuery: { bulkOperation: { id, status: "CREATED" }, userErrors: [] } },
  },
})

const currentBulkCompleted = (id = "bo1", url = "https://cdn/jsonl/bo1.jsonl"): FetchResponse => ({
  body: { data: { currentBulkOperation: { id, status: "COMPLETED", url, errorCode: null } } },
})

const currentBulkFailed = (id = "bo1"): FetchResponse => ({
  body: { data: { currentBulkOperation: { id, status: "FAILED", url: null, errorCode: "INTERNAL_SERVER_ERROR" } } },
})

describe("backfillCustomersJob", () => {
  it("issues bulkOperationRunQuery, awaits completion, streams JSONL via ctx.bulk", async () => {
    const url = "https://cdn/jsonl/bo1.jsonl"
    const { ctx, resolveContact, events } = makeCtx({
      shopifyFetch: [bulkRunQueryOk(), currentBulkCompleted("bo1", url)],
      blobs: { [url]: [{ id: "gid://shopify/Customer/c1", email: "a@b.com" }, { id: "gid://shopify/Customer/c2", email: "c@d.com" }] },
    })
    await backfillCustomersJob({}, ctx)
    expect(resolveContact.calls.length).toBe(2)
    expect(resolveContact.calls[0]!.externalId).toBe("c1")
    expect(resolveContact.calls[0]!.email).toBe("a@b.com")
    expect(resolveContact.calls[1]!.externalId).toBe("c2")
    // M4 — completion emits customer:backfill_completed. The enforcing emit mock
    // would THROW here if that key were missing from app.manifest.json#events.emits.
    expect(events.find((e) => e.entity === "customer" && e.action === "backfill_completed")).toBeDefined()
  })

  it("checkpoints cursor every batch (batchSize=50 → 3 updates for 120 rows)", async () => {
    const url = "https://cdn/jsonl/big.jsonl"
    const rows = Array.from({ length: 120 }, (_, i) => ({
      id: `gid://shopify/Customer/c${i + 1}`,
      email: `c${i + 1}@x`,
    }))
    const { ctx, updateLog } = makeCtx({
      shopifyFetch: [bulkRunQueryOk(), currentBulkCompleted("bo1", url)],
      blobs: { [url]: rows },
    })
    await backfillCustomersJob({}, ctx)
    const progressUpdates = updateLog.filter((u) => u.entity === "backfill_progress")
    // 3 in-batch cursor updates (50, 100, 120) + 1 final status=completed
    expect(progressUpdates.length).toBeGreaterThanOrEqual(3)
    // Final cursor must be c120.
    const lastCursorUpdate = [...progressUpdates].reverse().find((u) => u.data.cursorExternalId)
    expect(lastCursorUpdate?.data.cursorExternalId).toBe("c120")
    // No progress write may carry the kernel-managed updated_at column: the
    // sandbox rejects undeclared fields and the enforcing mock would have
    // thrown above, but assert explicitly so the contract is self-documenting.
    for (const u of progressUpdates) {
      expect(u.data).not.toHaveProperty("updatedAt")
    }
  })

  it("resumes from cursor; rows with external id <= cursor are skipped (numeric ids)", async () => {
    // Realistic Shopify customer ids are numeric (the trailing GID segment), so
    // resume skips every id `<= cursor` rather than depending on observing the
    // exact cursor row — robust to the cursor row being deleted between runs.
    const url = "https://cdn/jsonl/resume.jsonl"
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: `gid://shopify/Customer/${1000 + i + 1}`, // 1001..1100
      email: `c${i + 1}@x`,
    }))
    const { ctx, resolveContact } = makeCtx({
      shopifyFetch: [bulkRunQueryOk(), currentBulkCompleted("bo1", url)],
      blobs: { [url]: rows },
      preload: {
        backfill_progress: [
          { id: "bp1", entityType: "customers", cursorExternalId: "1050", status: "running" } as DbRow,
        ],
      },
    })
    await backfillCustomersJob({}, ctx)
    expect(resolveContact.calls[0]!.externalId).toBe("1051")
    expect(resolveContact.calls.length).toBe(50)
  })

  it("resume is robust when the exact cursor row was deleted between runs", async () => {
    // The cursor id (1050) is absent from the export; everything `> 1050` must
    // still be imported. The previous exact-equality skip would wait forever to
    // observe 1050 and import NOTHING.
    const url = "https://cdn/jsonl/resume-gap.jsonl"
    const rows = [1048, 1049, 1051, 1052, 1053].map((n) => ({
      id: `gid://shopify/Customer/${n}`,
      email: `c${n}@x`,
    }))
    const { ctx, resolveContact } = makeCtx({
      shopifyFetch: [bulkRunQueryOk(), currentBulkCompleted("bo1", url)],
      blobs: { [url]: rows },
      preload: {
        backfill_progress: [
          { id: "bp1", entityType: "customers", cursorExternalId: "1050", status: "running" } as DbRow,
        ],
      },
    })
    await backfillCustomersJob({}, ctx)
    expect(resolveContact.calls.map((c) => c.externalId)).toEqual(["1051", "1052", "1053"])
  })

  it("on bulk-op FAILED, marks backfill_progress.status=failed and emits an event", async () => {
    const { ctx, events, tables } = makeCtx({
      shopifyFetch: [bulkRunQueryOk(), currentBulkFailed()],
    })
    await backfillCustomersJob({}, ctx)
    const row = (tables.get("backfill_progress") ?? []).find((r) => r.entityType === "customers")
    expect(row).toBeDefined()
    expect(row!.status).toBe("failed")
    expect(events.find((e) => e.action === "backfill_failed")).toBeDefined()
  })

  it("empty store → completes cleanly with status=completed and no resolveContact calls", async () => {
    const url = "https://cdn/jsonl/empty.jsonl"
    const { ctx, resolveContact, tables } = makeCtx({
      shopifyFetch: [bulkRunQueryOk(), currentBulkCompleted("bo1", url)],
      blobs: { [url]: [] },
    })
    await backfillCustomersJob({}, ctx)
    expect(resolveContact.calls.length).toBe(0)
    const row = (tables.get("backfill_progress") ?? []).find((r) => r.entityType === "customers")
    expect(row!.status).toBe("completed")
  })

  it("if cached URL expired (404 on blob fetch), re-runs bulkOperationRunQuery and re-streams", async () => {
    const oldUrl = "https://cdn/jsonl/old.jsonl"
    const newUrl = "https://cdn/jsonl/new.jsonl"
    const rows = [{ id: "gid://shopify/Customer/c1", email: "a@b" }]
    const { ctx, resolveContact, fetchCount } = makeCtx({
      shopifyFetch: [
        // First attempt: bulk-op already in COMPLETED state with cached URL.
        { body: { data: { currentBulkOperation: { id: "bo0", status: "COMPLETED", url: oldUrl } } } },
        // Re-run kicks off a fresh bulk-op.
        bulkRunQueryOk("bo2"),
        currentBulkCompleted("bo2", newUrl),
      ],
      blobs: { [newUrl]: rows },
      blobErrors: { [oldUrl]: "404" },
      preload: {
        backfill_progress: [
          { id: "bp1", entityType: "customers", cursorExternalId: null, status: "running" } as DbRow,
        ],
      },
    })
    await backfillCustomersJob({}, ctx)
    expect(resolveContact.calls.length).toBe(1)
    expect(resolveContact.calls[0]!.externalId).toBe("c1")
    expect(fetchCount.current).toBe(3)
  })
})

describe("backfillCustomersJob poll pacing", () => {
  const running = (id = "bo1"): FetchResponse => ({
    body: { data: { currentBulkOperation: { id, status: "RUNNING", url: null, errorCode: null } } },
  })
  const url = "https://cdn/jsonl/bo1.jsonl"
  const rows = [{ id: "gid://shopify/Customer/c1", email: "a@b.com" }]

  it("backs off 250, 500, 1000 ms between polls where the runtime has a timer", async () => {
    const { ctx, resolveContact } = makeCtx({
      shopifyFetch: [bulkRunQueryOk(), running(), running(), running(), currentBulkCompleted("bo1", url)],
      blobs: { [url]: rows },
    })
    const delays = await withTimer("recording", async (d) => {
      await backfillCustomersJob({}, ctx)
      return d
    })
    expect(delays).toEqual([250, 500, 1000])
    expect(resolveContact.calls.length).toBe(1)
  })

  it("polls without waiting where the runtime has no timer", async () => {
    const { ctx, resolveContact, fetchCount } = makeCtx({
      shopifyFetch: [bulkRunQueryOk(), running(), running(), currentBulkCompleted("bo1", url)],
      blobs: { [url]: rows },
    })
    await withTimer("absent", () => backfillCustomersJob({}, ctx))
    expect(fetchCount.current).toBe(4)
    expect(resolveContact.calls.length).toBe(1)
  })
})
