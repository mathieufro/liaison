// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The bridge route over a REAL session bridge (createSessionRpcBridge, one RLS
// transaction per call, real Postgres): a read reaches only the run's org, and
// a run whose bridge was built in a read-only frame refuses writes through the
// route with exactly the error the subprocess pool's bridge_result carries
// (message + typed status/code), because the check lives in the bridge the
// dispatching code built, not in the route.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { createRlsSession } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { declaredEmits } from "~/infra/events/event-bus"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { typedBridgeFailure } from "~/modules/apps/sandbox/bridge-rejection"
import { createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { generateRlsPolicySql } from "~/modules/permissions/rls-generator"
import { upsertAppRow } from "~/seed/factories/app-tables"
import { seedOrgRow, seedUserRows } from "~/seed/factories/org/rows"
import { createAppBridgeRoutes } from "./bridge-route"
import { RunRegistry } from "./run-registry"

const APP_NAME = "wbridgetest"
const SCHEMA = schemaRef(`app_${APP_NAME}`)
const ORG_A = "00000000-0000-0000-0000-0000000e0a01"
const ORG_B = "00000000-0000-0000-0000-0000000e0b01"
const USER_A = "00000000-0000-0000-0000-0000000e0a02"

const MANIFEST = {
  name: APP_NAME,
  schema: { items: { fields: { title: "string" } } },
  events: { emits: ["items:created"] },
  connections: {},
  network: { allowedDomains: [] },
} as const

const actorA = {
  actorType: "user" as const,
  userId: USER_A,
  orgId: ORG_A,
  scopes: ["*"],
  dimensionGrants: {},
}

const registry = new RunRegistry()
const routes = createAppBridgeRoutes({ registry, isConfigured: () => true })

function buildBridge(): Record<string, unknown> {
  return createSessionRpcBridge(
    APP_NAME,
    USER_A,
    ORG_A,
    createRlsSession(actorA),
    MANIFEST as never,
    actorA.scopes,
  )
}

function readOnlyFrame(): RunContext {
  return {
    runId: "ro-run",
    parentRunId: null,
    rootRunId: "ro-run",
    nestingDepth: 0,
    readOnlyTools: true,
  }
}

async function post(runId: string, token: string, method: string, args: unknown[]) {
  const res = await routes.request(`/${runId}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-exec-nonce": "exec-1",
      "content-type": "application/json",
    },
    body: JSON.stringify({ callId: 1, method, args }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** What worker-pool.ts sends back as bridge_result for the same call. */
async function poolResult(bridge: Record<string, unknown>, method: string, args: unknown[]) {
  try {
    const data = await (bridge[method] as (...a: unknown[]) => Promise<unknown>)(...args)
    return { data }
  } catch (err) {
    const typed = typedBridgeFailure(err)
    return {
      error: (err as Error).message,
      ...(typed
        ? {
            errorStatus: typed.status,
            ...(typed.code !== undefined ? { errorCode: typed.code } : {}),
          }
        : {}),
    }
  }
}

beforeAll(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await sql.unsafe(`CREATE SCHEMA "${SCHEMA}"`)
  await sql.unsafe(`CREATE TABLE "${SCHEMA}".items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    title TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
  for (const role of ["liaison_rls", "liaison_admin"]) {
    await sql.unsafe(`GRANT USAGE ON SCHEMA "${SCHEMA}" TO ${role}`).catch(() => {})
    await sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA "${SCHEMA}" TO ${role}`).catch(() => {})
  }
  const policySql = generateRlsPolicySql(SCHEMA, "items", {}, APP_NAME, "items", {
    title: "string",
  })
  for (const stmt of policySql.split(";").filter((s) => s.trim())) await sql.unsafe(`${stmt};`)
  for (const [id, slug] of [
    [ORG_A, "wbridge-org-a"],
    [ORG_B, "wbridge-org-b"],
  ] as const) {
    await seedOrgRow({ id, name: slug, slug }, { onConflict: "skip" })
  }
  await seedUserRows(
    [
      {
        id: USER_A,
        orgId: ORG_A,
        email: "wbridge-a@test.com",
        name: "W Bridge A",
        status: "active",
        authVersion: 1,
      },
    ],
    { onConflict: "skip" },
  )
  for (const [org, title] of [
    [ORG_A, "A item"],
    [ORG_B, "B item"],
  ] as const) {
    await withPrivilegedDb(org, "wbridge-seed", async (tx) => {
      await upsertAppRow(tx, APP_NAME, "items", { id: randomUUID(), org_id: org, title })
    })
  }
  declaredEmits.set(APP_NAME, new Set(MANIFEST.events.emits))
})

afterAll(async () => {
  declaredEmits.delete(APP_NAME)
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await sql`DELETE FROM kernel.pending_events WHERE org_id IN (${ORG_A}, ${ORG_B})`
  await sql`DELETE FROM kernel.users WHERE id = ${USER_A}`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_A}, ${ORG_B})`
})

describe("app bridge route over a session bridge", () => {
  it("a read through the route sees the run's org only (RLS per call)", async () => {
    const bridge = buildBridge()
    const run = registry.registerRun({
      bridge,
      bridgeMethods: Object.keys(bridge),
      orgId: ORG_A,
      appName: APP_NAME,
      version: "1.0.0",
      timeoutMs: 30_000,
    })
    const res = await post(run.runId, run.runToken, "db_findMany", ["items", JSON.stringify({})])
    expect(res.status).toBe(200)
    const rows = JSON.parse(res.body.data as string) as Array<{ title: string }>
    expect(rows.map((r) => r.title)).toEqual(["A item"])
    run.settle()
  })

  it("a bridge built in a read-only frame refuses writes through the route as the pool does", async () => {
    const bridge = runContextStore.run(readOnlyFrame(), buildBridge)
    const reference = runContextStore.run(readOnlyFrame(), buildBridge)
    const run = registry.registerRun({
      bridge,
      bridgeMethods: Object.keys(bridge),
      orgId: ORG_A,
      appName: APP_NAME,
      version: "1.0.0",
      timeoutMs: 30_000,
    })
    // The route runs OUTSIDE the frame: the mark captured at construction rules.
    for (const [method, args] of [
      ["emit", ["items:created", JSON.stringify({ id: "x" })]],
      ["db_insert", ["items", JSON.stringify({ title: "nope" })]],
    ] as const) {
      const res = await post(run.runId, run.runToken, method, [...args])
      const expected = await poolResult(reference, method, [...args])
      expect("error" in expected).toBe(true)
      expect(res.status).toBe(200)
      expect(res.body).toEqual(expected)
    }
    const rows = await sql.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "${SCHEMA}".items WHERE title = 'nope'`,
    )
    const n = rows[0]?.n
    expect(n).toBe(0)
    run.settle()
  })
})
