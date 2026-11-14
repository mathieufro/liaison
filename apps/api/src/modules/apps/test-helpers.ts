// SPDX-License-Identifier: FSL-1.1-ALv2
// Test-only helper that builds a deterministic `AppContext` for unit-testing app
// handlers (the `example` reference app, future plugin apps).
//
// `mockAppContext()` returns a value that IS assignable to the real
// `@liaison/app-sdk` `AppContext` — the production code path and the test path
// share one contract, so a handler that compiles against the mock compiles
// against the real runtime. Side-effects (emitted events, enqueued jobs, db
// inserts) are tracked so tests can assert them.
import { type Mock, mock } from "bun:test"
import type {
  AppContext,
  ConnectionClient,
  DbClient,
  Logger,
  StoreClient,
  StoreDocument,
} from "@liaison/app-sdk"
import { applyMockBatch } from "@liaison/test-helpers/mock-db"

export interface MockAppContext extends AppContext {
  emit: Mock<(event: Parameters<AppContext["emit"]>[0]) => Promise<void>>
  resolveContact: Mock<(params: Parameters<AppContext["resolveContact"]>[0]) => Promise<unknown>>
  /** Tracked side-effects for assertions. */
  _dbInserts: Array<{ entity: string; data: Record<string, unknown> }>
  /** Jobs enqueued (`enqueueJob`, `jobs.enqueue`) and timers (`timers.wakeIn`, with `delaySeconds`). */
  _jobs: Array<{ name: string; payload: unknown; opts?: unknown; delaySeconds?: number }>
}

export interface MockAppContextOpts {
  orgId: string
  userId?: string
  /** Partial connections — `getAccounts`/`getCredentials` get empty defaults. */
  connections?: Record<
    string,
    {
      getToken: (identifier?: string) => Promise<string>
      getAccounts?: ConnectionClient["getAccounts"]
      getCredentials?: ConnectionClient["getCredentials"]
      getSettings?: ConnectionClient["getSettings"]
    }
  >
  fetchMock?: AppContext["fetch"]
  /** Stub `ctx.config.get(key)` — defaults to returning null for every key. */
  config?: { get: AppContext["config"]["get"] }
}

export function mockAppContext(opts: MockAppContextOpts): MockAppContext {
  const tables: Record<string, Array<Record<string, unknown>>> = {}
  const sequences = new Map<string, number>()
  const inserts: Array<{ entity: string; data: Record<string, unknown> }> = []
  const jobs: MockAppContext["_jobs"] = []
  const effects = new Map<string, { done: boolean; result: unknown }>()

  function matches(row: Record<string, unknown>, where?: Record<string, unknown>): boolean {
    if (!where) return true
    return Object.entries(where).every(([k, v]) => row[k] === v)
  }

  const db: DbClient = {
    findMany: async (entity, queryOpts) => {
      const rows = (tables[entity] ?? []).filter((r) => matches(r, queryOpts?.where))
      return queryOpts?.limit
        ? rows.slice(queryOpts.offset ?? 0, (queryOpts.offset ?? 0) + queryOpts.limit)
        : rows
    },
    findOne: async (entity, id) => (tables[entity] ?? []).find((r) => r.id === id) ?? null,
    insert: async (entity, data) => {
      const id = typeof data.id === "string" ? data.id : crypto.randomUUID()
      const row = { ...data, id }
      tables[entity] ??= []
      tables[entity].push(row)
      inserts.push({ entity, data: row })
      return { id }
    },
    update: async (entity, id, data) => {
      const row = (tables[entity] ?? []).find((r) => r.id === id)
      if (row) Object.assign(row, data)
    },
    updateMany: async (entity, queryOpts) => {
      const rows = (tables[entity] ?? []).filter((r) => matches(r, queryOpts.where))
      for (const r of rows) Object.assign(r, queryOpts.data)
      return { count: rows.length }
    },
    delete: async (entity, id) => {
      tables[entity] = (tables[entity] ?? []).filter((r) => r.id !== id)
    },
    count: async (entity, queryOpts) =>
      (tables[entity] ?? []).filter((r) => matches(r, queryOpts?.where)).length,
    batch: async (spec) =>
      (await applyMockBatch(
        {
          findOne: (e, id) => db.findOne(e, id),
          insert: (e, d) => db.insert(e, d),
          update: (e, id, d) => db.update(e, id, d),
          delete: (e, id) => db.delete(e, id),
          updateMany: (e, o) => db.updateMany(e, o),
          count: (e, o) => db.count(e, o),
          allocate: async (key) => {
            const next = (sequences.get(key) ?? 0) + 1
            sequences.set(key, next)
            return next
          },
          snapshot: () => {
            const saved = structuredClone(tables)
            const seqs = new Map(sequences)
            return () => {
              for (const k of Object.keys(tables)) delete tables[k]
              Object.assign(tables, saved)
              sequences.clear()
              for (const [k, v] of seqs) sequences.set(k, v)
            }
          },
        },
        spec,
      )) as Awaited<ReturnType<DbClient["batch"]>>,
  }

  // Complete each partial connection with a default `getAccounts` so the value
  // satisfies the real `ConnectionClient` interface.
  const connections: Record<string, ConnectionClient> = {}
  for (const [name, conn] of Object.entries(opts.connections ?? {})) {
    connections[name] = {
      getToken: conn.getToken,
      getAccounts: conn.getAccounts ?? (async () => []),
      getCredentials: conn.getCredentials ?? (async () => ({})),
      getSettings: conn.getSettings ?? (async () => ({ values: {}, missing: [] })),
    }
  }

  // An in-memory `ctx.store` (equality filters only, no cursor): enough for a
  // handler test; the real store's query semantics are tested in data-store/.
  const docs = new Map<string, StoreDocument>()
  const storeKey = (c: string, id: string) => `${c}\0${id}`
  const conflict = (id: string) =>
    Object.assign(new Error(`version conflict on '${id}'`), {
      status: 409,
      code: "version_conflict",
    })
  const checkVersion = (id: string, current: StoreDocument | undefined, ifVersion?: number) => {
    if (ifVersion === undefined) return
    if ((current?.version ?? 0) !== ifVersion) throw conflict(id)
  }
  const inCollection = (c: string, where?: Record<string, unknown>) =>
    [...docs.entries()]
      .filter(([k]) => k.startsWith(`${c}\0`))
      .map(([, d]) => d)
      .filter((d) =>
        Object.entries(where ?? {}).every(([f, v]) => (d.data as Record<string, unknown>)[f] === v),
      )
  const store: StoreClient = {
    get: async (c, id) => (docs.get(storeKey(c, id)) ?? null) as never,
    set: async (c, id, data, o) => {
      const current = docs.get(storeKey(c, id))
      checkVersion(id, current, o?.ifVersion)
      const doc = {
        id,
        data: data as Record<string, unknown>,
        version: (current?.version ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      }
      docs.set(storeKey(c, id), doc)
      return doc as never
    },
    update: async (c, id, patch, o) => {
      const current = docs.get(storeKey(c, id))
      checkVersion(id, current, o?.ifVersion)
      if (!current)
        throw Object.assign(new Error(`'${id}' not found`), { status: 404, code: "not_found" })
      return store.set(c, id, { ...current.data, ...(patch as object) }) as never
    },
    delete: async (c, id, o) => {
      checkVersion(id, docs.get(storeKey(c, id)), o?.ifVersion)
      return { deleted: docs.delete(storeKey(c, id)) }
    },
    query: async (c, q) => ({
      items: inCollection(c, q?.where as Record<string, unknown>).slice(0, q?.limit ?? 50) as never,
      nextCursor: null,
    }),
    count: async (c, where) => inCollection(c, where as Record<string, unknown>).length,
  }

  const logger: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }

  return {
    userId: opts.userId ?? "test-user",
    orgId: opts.orgId,
    db,
    store,
    emit: mock(async (_event: Parameters<AppContext["emit"]>[0]) => undefined),
    enqueueJob: async (name: string, payload: unknown, o?: unknown) => {
      jobs.push({ name, payload, ...(o !== undefined ? { opts: o } : {}) })
    },
    jobs: {
      enqueue: async (name, payload, o) => {
        jobs.push({ name, payload: payload ?? {}, ...(o !== undefined ? { opts: o } : {}) })
      },
    },
    timers: {
      wakeIn: async (seconds, name, payload, o) => {
        jobs.push({
          name,
          payload: payload ?? {},
          delaySeconds: seconds,
          ...(o !== undefined ? { opts: o } : {}),
        })
      },
    },
    // A page handle names the page and its params; nothing is stored.
    pages: {
      link: async (page, params) => ({
        handle: `lpg_test-${page}-${new URLSearchParams(
          Object.entries(params ?? {}).map(([k, v]): [string, string] => [k, String(v)]),
        )}`,
        app: "test-app",
        page,
        expiresInSeconds: 300,
      }),
    },
    // No shared limiter in a unit test: a pause is answered as set, nothing waits.
    limiter: {
      pause: async (_connection, ms) => ms,
    },
    // In one process: the chunks run back to back until done (no budget), kept
    // in the mock store's `liaison_steps` collection like the host does; a chunk
    // that answers `wakeIn` stops the run as `scheduled`.
    steps: {
      run: async (name, _o, chunk) => {
        const saved = await store.get<{ cursor: unknown; done: boolean }>("liaison_steps", name)
        if (saved?.data.done)
          return { state: "done", cursor: saved.data.cursor as never, chunks: 0 }
        let cursor = (saved?.data.cursor ?? null) as never
        let chunks = 0
        for (;;) {
          const out = await chunk(cursor)
          chunks++
          cursor = (out.cursor ?? null) as never
          await store.set("liaison_steps", name, { cursor, done: out.done })
          if (out.done) return { state: "done", cursor, chunks }
          if (out.wakeIn !== undefined) return { state: "scheduled", cursor, chunks }
        }
      },
      get: async (name) => {
        const d = await store.get<{ cursor: unknown; done: boolean }>("liaison_steps", name)
        return d
          ? {
              cursor: d.data.cursor as never,
              done: d.data.done,
              running: false,
              updatedAt: d.updatedAt,
            }
          : null
      },
      reset: async (name) => ({ reset: (await store.delete("liaison_steps", name)).deleted }),
    },
    // The platform-held reads answer "nothing connected" by default; a test that
    // needs rows replaces the member it calls.
    sql: {
      query: async () => ({ error: { code: "not_connected", message: "No connection (mock)" } }),
      reads: async () => ({ adapter: "none", reads: {}, domains: {} }),
      schema: async () => ({ tables: [] }),
      probe: async () => ({ ok: true, mode: "direct", warnings: [] }),
    },
    // No API connection declared: every member answers that way.
    api: new Proxy({} as AppContext["api"], {
      get: () => async () => ({
        error: { code: "not_connected", message: "No API connection (mock)" },
      }),
    }),
    accounts: {
      list: async () => [],
      setMetadata: async () => {
        throw Object.assign(new Error("no such account (mock)"), { status: 404, code: "not_found" })
      },
    },
    kernel: {
      findOne: async () => null,
      findByIds: async () => [],
      caller: async () => ({ kind: "system" as const, holds: {} }),
      roles: async () => [],
      findUsersByEmail: async () => [],
    },
    resolveContact: mock(async (_params: Parameters<AppContext["resolveContact"]>[0]) => undefined),
    listContactsByExternalId: mock(async (_limit?: number, _cursor?: string) => ({
      contacts: [] as Array<{ id: string; externalId: string | null }>,
      nextCursor: null as string | null,
    })),
    connections,
    fetch: opts.fetchMock ?? (async () => ({ status: 200, headers: {}, body: "" })),
    logger,
    config: {
      get: opts.config?.get ?? (async (_key: string) => null),
      has: async (key: string) => {
        const v = await (opts.config?.get ?? (async () => null))(key)
        return v !== undefined && v !== null && v !== ""
      },
      setSecret: async () => {},
    },
    // SDK platform-capability surfaces (2026-05-23). Return shape mirrors the
    // host bridge: JSON-stringified envelopes. Tests that exercise these
    // surfaces should re-stub them inline; the defaults below let
    // mockAppContext callers that don't touch them keep type-checking.
    agent_run: mock(async (_paramsJson: string) =>
      JSON.stringify({
        result: { messageId: "test-msg", creditCost: "0", finishReason: "stop" },
        userMessageId: "test-user-msg",
      }),
    ),
    realtime_publish: mock(async (_channel: string, _payloadJson: string) =>
      JSON.stringify({ ok: true }),
    ),
    // Phase 16 Task A1 — default stub for the SDK scope-grant surface.
    grants_setUserScopes: mock(async (_userId: string, _scopesJson: string) =>
      JSON.stringify({ ok: true }),
    ),
    // Phase 16 Task A7 — default stub for the SDK bulk-blob surface. Tests
    // that exercise bulk ingest should re-stub these inline.
    bulk: {
      fetchToBlob: mock(async (_url: string, _opts?: { headers?: Record<string, string> }) => ({
        blobId: "test-blob",
        sizeBytes: 0,
      })),
      iterateJsonl: ((_blobId: string, _opts?: { batchSize?: number }) => {
        async function* gen(): AsyncIterable<unknown[]> {
          // no batches by default
        }
        return gen()
      }) as AppContext["bulk"]["iterateJsonl"],
      deleteBlob: mock(async (_blobId: string) => undefined),
    },
    // Phase 17 Task A1 — default stubs for the new K1/K2/K3 capability surfaces.
    // Tests that exercise these surfaces should re-stub them inline.
    messages: {
      post: mock(async (_params: Parameters<AppContext["messages"]["post"]>[0]) => ({
        message_id: "test-msg",
        thread_id: _params.thread_id ?? "test-thread",
      })),
    },
    pdf: {
      render: mock(async (_params: Parameters<AppContext["pdf"]["render"]>[0]) => ({
        file_id: "test-file",
        byte_size: 0,
        page_count: 1,
      })),
    },
    sequences: {
      allocate: mock(async (_params: Parameters<AppContext["sequences"]["allocate"]>[0]) => ({
        value: 1,
      })),
    },
    // UTC, like the host answers for an org with no zone.
    time: {
      civil: mock(async (params: Parameters<AppContext["time"]["civil"]>[0]) => {
        const at = params.at === undefined ? new Date() : new Date(params.at)
        const iso = at.toISOString()
        return {
          date: iso.slice(0, 10),
          year: at.getUTCFullYear(),
          month: at.getUTCMonth() + 1,
          day: at.getUTCDate(),
          hour: at.getUTCHours(),
          minute: at.getUTCMinutes(),
          weekday: at.getUTCDay() || 7,
          zone: params.timezone,
        }
      }),
    },
    // A person's own turn with no agent, unless a test says otherwise.
    turn: {
      get: mock(async () => ({ agentId: null, hasPerson: true })),
    },
    approvals: {
      restagePayload: mock(
        async (
          approvalId: string,
          _fields: Record<string, unknown>,
          _note?: string,
        ): ReturnType<AppContext["approvals"]["restagePayload"]> => ({
          ok: true,
          approval_id: approvalId,
          payload_hash: "",
          changed: true,
        }),
      ),
    },
    // An in-memory effect ledger: claimed, then done or released.
    effects: {
      claim: mock(async (key: string) => {
        const row = effects.get(key)
        if (!row) {
          effects.set(key, { done: false, result: null })
          return { state: "claimed" as const }
        }
        return row.done
          ? { state: "done" as const, result: row.result }
          : { state: "in_flight" as const }
      }),
      complete: mock(async (key: string, resultJson: string) => {
        const row = effects.get(key)
        if (!row || row.done) return { ok: false }
        effects.set(key, { done: true, result: JSON.parse(resultJson) })
        return { ok: true }
      }),
      release: mock(async (key: string) => {
        if (effects.get(key)?.done === false) effects.delete(key)
        return { ok: true }
      }),
      settleUnknown: mock(async (_key: string, _decisionJson: string) => ({ ok: false })),
      markUnknown: mock(async (_key: string) => ({ ok: false })),
    },
    _dbInserts: inserts,
    _jobs: jobs,
  }
}
