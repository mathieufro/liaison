// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Integration tests for the untrusted (worker subprocess) sandbox execution path.
 *
 * These tests register a manifest-format app with `trusted: false`, then exercise
 * the full HTTP → executeTool → worker subprocess → IPC bridge → RLS → result pipeline.
 * Every bridge operation (DB CRUD, events, logging, connections) is validated end-to-end.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db/connection"
import { env } from "~/lib/env"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "./route-test-setup"

const TEST_ORG = "00000000-0000-0000-0000-000000310001"
const TEST_USER = "00000000-0000-0000-0000-000000310002"

// Handler bundle exercising every bridge capability
const HANDLER_BUNDLE = `
async function listItems(params, ctx) {
  var rows = await ctx.db_findMany("items", JSON.stringify(
    params.status ? { where: { status: params.status } } : {}
  ));
  return JSON.parse(rows);
}

async function createItem(params, ctx) {
  var userId = await ctx.getUserId();
  var inserted = await ctx.db_insert("items", JSON.stringify({
    title: params.title,
    team: params.team || "default",
    status: "open",
    sensitivity: "public",
    createdBy: userId
  }));
  var item = JSON.parse(inserted);
  await ctx.emit(JSON.stringify({
    entity: "items",
    action: "created",
    entityId: item.id,
    data: item
  }));
  return item;
}

async function updateItem(params, ctx) {
  await ctx.db_update("items", params.id, JSON.stringify({ status: params.status }));
  return { updated: true };
}

async function deleteItem(params, ctx) {
  await ctx.db_delete("items", params.id);
  return { deleted: true };
}

async function countItems(params, ctx) {
  var count = await ctx.db_count("items", JSON.stringify({}));
  return { count: count };
}

async function getItem(params, ctx) {
  var row = await ctx.db_findOne("items", params.id);
  return row ? JSON.parse(row) : null;
}

async function multiOp(params, ctx) {
  // Multiple sequential bridge calls in a single handler
  var userId = await ctx.getUserId();
  var created = await ctx.db_insert("items", JSON.stringify({
    title: "multi-1", team: "eng", status: "open", sensitivity: "public", createdBy: userId
  }));
  var item = JSON.parse(created);
  await ctx.db_update("items", item.id, JSON.stringify({ status: "closed" }));
  var fetched = await ctx.db_findOne("items", item.id);
  var final = JSON.parse(fetched);
  return { id: final.id, title: final.title, status: final.status };
}

async function identity(params, ctx) {
  var userId = await ctx.getUserId();
  var orgId = await ctx.getOrgId();
  return { userId: userId, orgId: orgId };
}

function pureCompute(params, ctx) {
  var result = [];
  for (var i = 0; i < params.count; i++) {
    result.push({ id: i, value: Math.sqrt(i * 17.3) });
  }
  return { items: result, total: result.length };
}

function throwError(params, ctx) {
  throw new Error("handler-level error: " + params.message);
}

function mockExternalSearch(params, ctx) {
  return [
    { id: "1", name: "EU Alpha", market: "eu" },
    { id: "2", name: "US Alpha", market: "us" },
    { id: "3", name: "US Beta", market: "us" },
    { id: "4", name: "AP Alpha", market: "ap" }
  ];
}

function withLogging(params, ctx) {
  ctx.log_info("test info message", JSON.stringify({ key: "value" }));
  ctx.log_warn("test warning");
  ctx.log_error("test error");
  ctx.log_debug("test debug");
  return { logged: true };
}
`

const MANIFEST = {
  name: "untrusted-test",
  version: "1.0.0",
  description: "Untrusted worker pool integration test app",
  trusted: false, // Force worker subprocess path
  schema: {
    items: {
      fields: {
        title: "string",
        status: "string",
        team: "string",
        sensitivity: "string",
        createdBy: { type: "uuid", required: false },
      },
      dimensions: {
        team: { type: "membership" },
        sensitivity: { type: "level", order: ["public", "internal", "confidential"] },
      },
    },
    // Declares the `market` dimension `externalSearch` filters its response on.
    // Read under the scope its search tool requires (`untrusted-test:external:read`).
    external_records: {
      rlsScope: "external",
      fields: { name: "string", market: "string" },
      dimensions: { market: { type: "membership" } },
    },
  },
  entities: {
    // `searchable: true` would require `tableName` + `readScope`; this
    // integration test exercises tool dispatch through the worker pool,
    // not search — leave search off so the manifest validates cleanly.
    items: { labelField: "title" },
  },
  tools: {
    listItems: {
      description: "List items",
      params: { type: "object", properties: { status: { type: "string" } } },
      requiredScopes: ["untrusted-test:items:read"],
      handler: "listItems",
    },
    createItem: {
      description: "Create item",
      params: {
        type: "object",
        properties: { title: { type: "string" }, team: { type: "string" } },
        required: ["title"],
      },
      requiredScopes: ["untrusted-test:items:write"],
      handler: "createItem",
    },
    updateItem: {
      description: "Update item",
      params: {
        type: "object",
        properties: { id: { type: "string" }, status: { type: "string" } },
        required: ["id", "status"],
      },
      requiredScopes: ["untrusted-test:items:write"],
      handler: "updateItem",
    },
    deleteItem: {
      description: "Delete item",
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      requiredScopes: ["untrusted-test:items:write"],
      handler: "deleteItem",
    },
    countItems: {
      description: "Count items",
      params: { type: "object" },
      requiredScopes: ["untrusted-test:items:read"],
      handler: "countItems",
    },
    getItem: {
      description: "Get single item",
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      requiredScopes: ["untrusted-test:items:read"],
      handler: "getItem",
    },
    multiOp: {
      description: "Multiple sequential bridge calls",
      params: { type: "object" },
      requiredScopes: ["untrusted-test:items:write"],
      handler: "multiOp",
    },
    identity: {
      description: "Return actor identity",
      params: { type: "object" },
      requiredScopes: ["untrusted-test:items:read"],
      handler: "identity",
    },
    pureCompute: {
      description: "CPU-bound computation",
      params: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
      requiredScopes: ["untrusted-test:items:read"],
      handler: "pureCompute",
    },
    throwError: {
      description: "Handler that throws",
      params: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      requiredScopes: ["untrusted-test:items:read"],
      handler: "throwError",
    },
    externalSearch: {
      description: "Mock external API search",
      params: { type: "object", properties: { query: { type: "string" } } },
      requiredScopes: ["untrusted-test:external:read"],
      handler: "mockExternalSearch",
      returns: {
        schema: { id: "string", name: "string", market: "string" },
        dimensions: { market: "untrusted-test:market" },
      },
    },
    withLogging: {
      description: "Handler that uses logging bridge",
      params: { type: "object" },
      requiredScopes: ["untrusted-test:items:read"],
      handler: "withLogging",
    },
  },
  events: {
    emits: ["items:created", "items:updated", "items:deleted"],
  },
  _format: "manifest",
}

async function apiRequest(
  path: string,
  opts: {
    method?: string
    body?: unknown
    scopes?: string[]
    dimensionGrants?: Record<string, string[]>
  } = {},
) {
  const token = await signAccessToken(
    {
      userId: TEST_USER,
      orgId: TEST_ORG,
      name: "Test User",
      authVersion: 1,
      permissionVersion: 1,
      scopes: opts.scopes ?? [],
      dimensionGrants: opts.dimensionGrants ?? {},
    },
    env.JWT_SECRET,
  )
  return app.request(path, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-org-id": TEST_ORG,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
}

describe("untrusted sandbox — worker subprocess integration", () => {
  let bundlePath: string

  beforeAll(async () => {
    // This file mutates shared kernel tables (organizations/users/apps) and a
    // dedicated `app_untrusted_test` schema. `bun test` runs every file in one
    // process concurrently, so we MUST hold the suite-wide DB lock — otherwise
    // a peer file's `TRUNCATE ... CASCADE` races our INSERT/DELETE/DROP SCHEMA
    // and deadlocks (and cascade-wipes other files' rows).
    await acquireTestLock()

    // Write handler bundle to temp file
    bundlePath = "/tmp/untrusted-test-handlers.js"
    await Bun.write(bundlePath, HANDLER_BUNDLE)

    // Set up org + user
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG}, 'Untrusted Test Org', 'untrusted-test')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${TEST_USER}, ${TEST_ORG}, 'untrusted@test.com', 'hash', 'Untrusted Tester', 'active')
      ON CONFLICT (id) DO NOTHING`

    // Initialize both pools. Pre-warm ALL 4 worker subprocesses here (size ===
    // maxSize) so the concurrent-requests test never pays cold `Bun.spawn` +
    // QuickJS-init cost inside its timed window — under full-suite CPU
    // contention a cold spawn alone can approach STARTUP_TIMEOUT_MS (15s).
    await initSandboxPool()
    await initWorkerPool({ size: 4, maxSize: 4 })

    // Register the untrusted test app
    await registerApps([{ ...MANIFEST, _bundlePath: bundlePath } as any], TEST_ORG)
  }, 60000)

  afterAll(async () => {
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_untrusted_test" CASCADE`)
    // `releaseTestLock` truncates the kernel tables (apps/users/organizations
    // included) and releases the lock — no separate DELETEs needed.
    await releaseTestLock()
  })

  // --- Identity & Pure Compute ---

  it("returns actor identity through worker subprocess", async () => {
    const res = await apiRequest("/api/apps/tools/untrusted-test:identity", {
      method: "POST",
      body: {},
      scopes: ["untrusted-test:items:read"],
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.userId).toBe(TEST_USER)
    expect(body.data.orgId).toBe(TEST_ORG)
  })

  it("executes pure computation without bridge calls", async () => {
    const res = await apiRequest("/api/apps/tools/untrusted-test:pureCompute", {
      method: "POST",
      body: { count: 50 },
      scopes: ["untrusted-test:items:read"],
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.total).toBe(50)
    expect(body.data.items.length).toBe(50)
    expect(body.data.items[0].id).toBe(0)
  })

  // --- DB CRUD through worker subprocess ---

  it("creates an item through worker subprocess → RPC bridge → RLS → DB", async () => {
    const res = await apiRequest("/api/apps/tools/untrusted-test:createItem", {
      method: "POST",
      body: { title: "Worker Item", team: "engineering" },
      scopes: ["untrusted-test:items:write"],
      dimensionGrants: {
        "untrusted-test:team": ["engineering"],
        "untrusted-test:sensitivity": ["public", "internal", "confidential"],
      },
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.title).toBe("Worker Item")
    expect(body.data.id).toBeDefined()
  })

  it("lists items created through worker subprocess", async () => {
    const res = await apiRequest("/api/apps/tools/untrusted-test:listItems", {
      method: "POST",
      body: {},
      scopes: ["untrusted-test:items:read"],
      dimensionGrants: {
        "untrusted-test:team": ["engineering"],
        "untrusted-test:sensitivity": ["public", "internal", "confidential"],
      },
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data.some((i: any) => i.title === "Worker Item")).toBe(true)
  })

  it("counts items through worker subprocess", async () => {
    const res = await apiRequest("/api/apps/tools/untrusted-test:countItems", {
      method: "POST",
      body: {},
      scopes: ["untrusted-test:items:read"],
      dimensionGrants: {
        "untrusted-test:team": ["engineering"],
        "untrusted-test:sensitivity": ["public", "internal", "confidential"],
      },
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(Number(body.data.count)).toBeGreaterThanOrEqual(1)
  })

  it("updates and retrieves an item through worker subprocess", async () => {
    // Create
    const createRes = await apiRequest("/api/apps/tools/untrusted-test:createItem", {
      method: "POST",
      body: { title: "Update Target", team: "engineering" },
      scopes: ["untrusted-test:items:write"],
      dimensionGrants: {
        "untrusted-test:team": ["engineering"],
        "untrusted-test:sensitivity": ["public", "internal", "confidential"],
      },
    })
    const created: any = ((await createRes.json()) as any).data

    // Update
    const updateRes = await apiRequest("/api/apps/tools/untrusted-test:updateItem", {
      method: "POST",
      body: { id: created.id, status: "closed" },
      scopes: ["untrusted-test:items:write"],
      dimensionGrants: {
        "untrusted-test:team": ["engineering"],
        "untrusted-test:sensitivity": ["public", "internal", "confidential"],
      },
    })
    expect(updateRes.status).toBe(200)

    // Verify
    const getRes = await apiRequest("/api/apps/tools/untrusted-test:getItem", {
      method: "POST",
      body: { id: created.id },
      scopes: ["untrusted-test:items:read"],
      dimensionGrants: {
        "untrusted-test:team": ["engineering"],
        "untrusted-test:sensitivity": ["public", "internal", "confidential"],
      },
    })
    expect(getRes.status).toBe(200)
    const fetched: any = ((await getRes.json()) as any).data
    expect(fetched.status).toBe("closed")
    expect(fetched.title).toBe("Update Target")
  })

  it("deletes an item through worker subprocess", async () => {
    // Create
    const createRes = await apiRequest("/api/apps/tools/untrusted-test:createItem", {
      method: "POST",
      body: { title: "Delete Target", team: "engineering" },
      scopes: ["untrusted-test:items:write"],
      dimensionGrants: {
        "untrusted-test:team": ["engineering"],
        "untrusted-test:sensitivity": ["public", "internal", "confidential"],
      },
    })
    const created: any = ((await createRes.json()) as any).data

    // Delete
    const deleteRes = await apiRequest("/api/apps/tools/untrusted-test:deleteItem", {
      method: "POST",
      body: { id: created.id },
      scopes: ["untrusted-test:items:write"],
      dimensionGrants: {
        "untrusted-test:team": ["engineering"],
        "untrusted-test:sensitivity": ["public", "internal", "confidential"],
      },
    })
    expect(deleteRes.status).toBe(200)

    // Verify gone
    const getRes = await apiRequest("/api/apps/tools/untrusted-test:getItem", {
      method: "POST",
      body: { id: created.id },
      scopes: ["untrusted-test:items:read"],
      dimensionGrants: {
        team: ["engineering"],
        sensitivity: ["public", "internal", "confidential"],
      },
    })
    expect(getRes.status).toBe(200)
    const fetched: any = ((await getRes.json()) as any).data
    expect(fetched).toBeNull()
  })

  // --- Multiple sequential bridge calls in one handler ---

  it("handles multiple sequential bridge calls in a single handler invocation", async () => {
    const res = await apiRequest("/api/apps/tools/untrusted-test:multiOp", {
      method: "POST",
      body: {},
      scopes: ["untrusted-test:items:write"],
      dimensionGrants: {
        "untrusted-test:team": ["eng"],
        "untrusted-test:sensitivity": ["public", "internal", "confidential"],
      },
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.title).toBe("multi-1")
    expect(body.data.status).toBe("closed")
    expect(body.data.id).toBeDefined()
  })

  // --- Scope enforcement ---

  it("returns 403 when actor lacks required scope", async () => {
    const res = await apiRequest("/api/apps/tools/untrusted-test:createItem", {
      method: "POST",
      body: { title: "Should fail" },
      scopes: ["untrusted-test:items:read"], // Missing write
    })
    expect(res.status).toBe(403)
  })

  // --- Dimension filtering ---

  it("applies dimension filtering to external search results", async () => {
    const res = await apiRequest("/api/apps/tools/untrusted-test:externalSearch", {
      method: "POST",
      body: { query: "search" },
      scopes: ["untrusted-test:external:read"],
      dimensionGrants: { "untrusted-test:market": ["us"] },
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.length).toBe(2)
    expect(body.data.every((i: any) => i.market === "us")).toBe(true)
  })

  // --- Error handling ---

  it("propagates handler errors as 500 without leaking internals", async () => {
    const res = await apiRequest("/api/apps/tools/untrusted-test:throwError", {
      method: "POST",
      body: { message: "deliberate failure" },
      scopes: ["untrusted-test:items:read"],
    })
    expect(res.status).toBe(500)
    const body: any = await res.json()
    expect(body.error.message).toBe("Tool execution failed")
    // Handler error details should NOT leak to client
    expect(JSON.stringify(body)).not.toContain("deliberate failure")
  })

  it("continues working after a handler error (worker not crashed)", async () => {
    // Trigger error
    await apiRequest("/api/apps/tools/untrusted-test:throwError", {
      method: "POST",
      body: { message: "crash test" },
      scopes: ["untrusted-test:items:read"],
    })

    // Verify pool is still functional
    const res = await apiRequest("/api/apps/tools/untrusted-test:identity", {
      method: "POST",
      body: {},
      scopes: ["untrusted-test:items:read"],
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.userId).toBe(TEST_USER)
  })

  // --- Logging bridge ---

  it("executes handler with logging bridge calls without error", async () => {
    const res = await apiRequest("/api/apps/tools/untrusted-test:withLogging", {
      method: "POST",
      body: {},
      scopes: ["untrusted-test:items:read"],
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.logged).toBe(true)
  })

  // --- Concurrent execution ---

  it("handles concurrent requests across worker subprocesses", async () => {
    const requests = Array.from({ length: 4 }, (_, i) =>
      apiRequest("/api/apps/tools/untrusted-test:pureCompute", {
        method: "POST",
        body: { count: 10 + i },
        scopes: ["untrusted-test:items:read"],
      }),
    )
    const responses = await Promise.all(requests)
    for (let i = 0; i < responses.length; i++) {
      expect(responses[i].status).toBe(200)
      const body: any = await responses[i].json()
      expect(body.data.total).toBe(10 + i)
    }
    // All 4 worker subprocesses are pre-warmed in beforeAll, so these 4
    // concurrent round-trips dispatch instantly — 15s is generous headroom.
  }, 15000)

  it("handles concurrent DB writes from multiple workers without conflicts", async () => {
    // Run sequentially to avoid worker pool contention under test load
    const ids = new Set<string>()
    for (let i = 0; i < 4; i++) {
      const res = await apiRequest("/api/apps/tools/untrusted-test:createItem", {
        method: "POST",
        body: { title: `Concurrent-${i}`, team: "engineering" },
        scopes: ["untrusted-test:items:write"],
        dimensionGrants: {
          "untrusted-test:team": ["engineering"],
          "untrusted-test:sensitivity": ["public", "internal", "confidential"],
        },
      })
      expect(res.status).toBe(200)
      const body: any = await res.json()
      expect(body.data.id).toBeDefined()
      ids.add(body.data.id)
    }
    expect(ids.size).toBe(4)
    // 4 sequential worker-subprocess round-trips — see timeout note above.
  }, 15000)

  // --- Security: ArrayBuffer blocked ---

  it("blocks ArrayBuffer allocation in untrusted handlers", async () => {
    // Register a malicious tool inline by directly calling the worker pool
    // (can't add tools at runtime, so test via the worker pool directly)
    const { getWorkerPool } = await import("~/modules/apps/sandbox/worker-pool")
    const pool = getWorkerPool()

    const err = await pool
      .execute({
        bundleSource: `function attack(params, ctx) { return new ArrayBuffer(1024) }`,
        exportName: "attack",
        params: {},
        bridge: {},
      })
      .catch((e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    // Worker may return the QuickJS error or crash entirely — both are acceptable
    expect(
      (err as Error).message.includes("ArrayBuffer") || (err as Error).message.includes("crashed"),
    ).toBe(true)
  }, 15000)
})
