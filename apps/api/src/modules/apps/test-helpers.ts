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
import type { AppContext, ConnectionClient, DbClient, Logger } from "@liaison/app-sdk"

export interface MockAppContext extends AppContext {
  emit: Mock<(event: Parameters<AppContext["emit"]>[0]) => Promise<void>>
  resolveContact: Mock<(params: Parameters<AppContext["resolveContact"]>[0]) => Promise<unknown>>
  /** Tracked side-effects for assertions. */
  _dbInserts: Array<{ entity: string; data: Record<string, unknown> }>
  _jobs: Array<{ name: string; payload: unknown }>
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
  const inserts: Array<{ entity: string; data: Record<string, unknown> }> = []
  const jobs: Array<{ name: string; payload: unknown }> = []
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
    emit: mock(async (_event: Parameters<AppContext["emit"]>[0]) => undefined),
    enqueueJob: async (name: string, payload: unknown) => {
      jobs.push({ name, payload })
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
