// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sandbox bridge runs every transactional call of a handler whose run
// shares ONE transaction in its own savepoint of that transaction. Against a
// real database (no mock handing back the same object for the savepoint):
//
//   - a call that fails, caught or not, rolls back alone; one the handler lets
//     propagate fails the whole run, which rolls back as a whole;
//   - every call's savepoint is released when the call ends, so a long job does
//     not nest one more open subtransaction per call;
//   - an event queued inside a savepoint is stamped from, and inserted
//     through, that savepoint: it names the acting agent the bridge declared on
//     it, and a failed outbox insert the caller catches does not fail the run;
//   - the short transactions of the tx-less methods (fetch, imap, smtp) wait
//     for the call in flight instead of opening a savepoint beside it.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { setEventAgentDefault } from "~/db/queue-event"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"
import { bridgeTestHostMethods } from "~/modules/apps/sandbox/bridge/shared"
import {
  createSandboxRpcBridge,
  SANDBOX_BRIDGE_SHORT_TX,
  SandboxBridgeTestAccess,
} from "~/modules/apps/sandbox/rpc-bridge"
import { insertAppRow } from "~/seed/factories/app-tables"
import { seedOrgRow } from "~/seed/factories/org/rows"

const TEST_ORG = "00000000-0000-0000-0000-000000000531"
const MISSING_ORG = "00000000-0000-0000-0000-000000000532"
const APP = "sp-bridge"
const SCHEMA = "app_sp_bridge"
/** The app's table namespace: its schema is `app_<this>`. */
const APP_TABLES = "sp_bridge"
const AGENT = "00000000-0000-0000-0000-000000000533"

const manifest = {
  name: APP,
  version: "1.0.0",
  _format: "manifest",
  // The scope that reads its table: registration refuses a table no declared scope reaches.
  scopes: [`${APP}:claims:read`],
  schema: {
    claims: { fields: { key: "string" }, constraints: { unique: [["key"]] } },
  },
  events: { emits: ["claim:noted"] },
}

async function keys(prefix: string): Promise<string[]> {
  const rows = await sql.unsafe(
    `SELECT key FROM "${SCHEMA}".claims WHERE key LIKE $1 ORDER BY key`,
    [`${prefix}%`],
  )
  return rows.map((r) => String(r.key))
}

function bridgeFor(tx: unknown, opts?: Record<string, unknown>): Record<string, any> {
  return createSandboxRpcBridge(
    APP,
    "system:sp-bridge:test",
    TEST_ORG,
    tx as never,
    manifest as never,
    undefined,
    "system",
    undefined,
    opts as never,
  )
}

beforeAll(async () => {
  await seedOrgRow(
    { id: TEST_ORG, name: "Sandbox Savepoint Org", slug: "sandbox-savepoint-org" },
    { onConflict: "skip" },
  )
  await registerApps([manifest as never], TEST_ORG)
  // A host method that writes, then fails: the case a caught error must undo.
  SandboxBridgeTestAccess.setHostMethods(TEST_ORG, APP, (ctx) => ({
    sp_writeThenThrow: async (paramsJson: string) => {
      const { key } = JSON.parse(paramsJson) as { key: string }
      await insertAppRow(ctx.txDb, APP_TABLES, "claims", { org_id: TEST_ORG, key })
      throw new Error("host method failed after its write")
    },
  }))
})

afterEach(async () => {
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${TEST_ORG}`
})

afterAll(async () => {
  SandboxBridgeTestAccess.setHostMethods(TEST_ORG, APP, null)
  resetAppRegistries()
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await sql`DELETE FROM kernel.apps WHERE org_id = ${TEST_ORG} AND name = ${APP}`
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${TEST_ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
})

describe("sandbox bridge savepoints", () => {
  it("a caught failed call rolls back alone, its own writes included, and the run commits", async () => {
    const p = `caught-${randomUUID()}:`
    await withPrivilegedDb(TEST_ORG, "test", async (tx) => {
      const bridge = bridgeFor(tx)
      await bridge.db_insert("claims", JSON.stringify({ key: `${p}a` }))
      await expect(bridge.db_insert("claims", JSON.stringify({ key: `${p}a` }))).rejects.toThrow()
      await expect(bridge.sp_writeThenThrow(JSON.stringify({ key: `${p}b` }))).rejects.toThrow(
        "host method failed after its write",
      )
      await bridge.db_insert("claims", JSON.stringify({ key: `${p}c` }))
    })
    expect(await keys(p)).toEqual([`${p}a`, `${p}c`])
  })

  it("a failed call the handler lets propagate rolls the whole run back", async () => {
    const p = `thrown-${randomUUID()}:`
    await expect(
      withPrivilegedDb(TEST_ORG, "test", async (tx) => {
        const bridge = bridgeFor(tx)
        await bridge.db_insert("claims", JSON.stringify({ key: `${p}a` }))
        await bridge.sp_writeThenThrow(JSON.stringify({ key: `${p}b` }))
      }),
    ).rejects.toThrow("host method failed after its write")
    expect(await keys(p)).toEqual([])
  })

  it("releases each call's savepoint when the call ends", async () => {
    const p = `released-${randomUUID()}:`
    await withPrivilegedDb(TEST_ORG, "test", async (tx) => {
      const bridge = bridgeFor(tx)
      for (let i = 0; i < 5; i++) {
        await bridge.db_insert("claims", JSON.stringify({ key: `${p}${i}` }))
      }
      // postgres.js names the driver savepoints of one transaction s0, s1, ...
      // in order. Released, none of the bridge's is left to release again.
      const probe = await tx
        .transaction(async (sp) => {
          await sp.execute(drizzleSql.raw("RELEASE SAVEPOINT s0"))
          return "still open"
        })
        .catch((err: { cause?: { code?: string }; code?: string }) => err.cause?.code ?? err.code)
      expect(probe).toBe("3B001")
    })
    expect(await keys(p)).toHaveLength(5)
  })

  it("an event emitted in a call carries the agent and turn the bridge declared", async () => {
    const turnMessageId = randomUUID()
    await withPrivilegedDb(TEST_ORG, "test", async (tx) => {
      const bridge = bridgeFor(tx, {
        spawnParentFrameOverride: {
          agentId: AGENT,
          turnMessageId,
          run: { runId: "r-1", rootRunId: "r-root", nestingDepth: 0 },
        },
      })
      await bridge.emit(
        JSON.stringify({ entity: "claim", action: "noted", entityId: randomUUID(), data: {} }),
      )
    })
    const rows = await sql`SELECT payload FROM kernel.pending_events WHERE org_id = ${TEST_ORG}`
    expect(rows).toHaveLength(1)
    const payload = rows[0]?.payload as { agentId?: string; metadata?: { turnMessageId?: string } }
    expect(payload.agentId).toBe(AGENT)
    expect(payload.metadata?.turnMessageId).toBe(turnMessageId)
  })

  it("a tx-less short transaction waits for the call in flight", async () => {
    const p = `short-${randomUUID()}:`
    await withPrivilegedDb(TEST_ORG, "test", async (tx) => {
      const bridge = bridgeFor(tx)
      const shortTx = Reflect.get(bridge, SANDBOX_BRIDGE_SHORT_TX) as <T>(
        fn: (tx: { execute(q: unknown): Promise<unknown> }) => Promise<T>,
      ) => Promise<T>
      // Started together: the failing call must not roll back the short
      // transaction's write, nor the short transaction the call's.
      const failing = bridge.sp_writeThenThrow(JSON.stringify({ key: `${p}call` }))
      const short = shortTx((stx) =>
        insertAppRow(stx, APP_TABLES, "claims", { org_id: TEST_ORG, key: `${p}short` }),
      )
      await expect(failing).rejects.toThrow()
      await short
      await bridge.db_insert("claims", JSON.stringify({ key: `${p}after` }))
    })
    expect(await keys(p)).toEqual([`${p}after`, `${p}short`])
  })
  it("without a transaction (an org-less scheduled job) a method that needs none still runs", async () => {
    const kept = bridgeTestHostMethods.get(`${TEST_ORG}:${APP}`) ?? null
    SandboxBridgeTestAccess.setHostMethods(TEST_ORG, APP, () => ({
      sp_noTx: async () => "ran",
    }))
    try {
      const bridge = bridgeFor(undefined)
      expect(await bridge.sp_noTx()).toBe("ran")
    } finally {
      SandboxBridgeTestAccess.setHostMethods(TEST_ORG, APP, kept)
    }
  })
})

describe("events queued in a savepoint", () => {
  it("are stamped from the savepoint's own agent declaration", async () => {
    await withPrivilegedDb(TEST_ORG, "test", async (tx) => {
      await tx.transaction(async (sp) => {
        setEventAgentDefault(sp, AGENT, {
          turnMessageId: "turn-1",
          run: { rootRunId: "root-1" },
        })
        await (sp as unknown as { queueEvent(e: unknown): Promise<void> }).queueEvent({
          app: APP,
          entity: "claim",
          action: "noted",
          entityId: randomUUID(),
          data: {},
          actorId: null,
          actorType: "system",
          orgId: TEST_ORG,
          timestamp: new Date().toISOString(),
        })
      })
    })
    const rows = await sql`SELECT payload FROM kernel.pending_events WHERE org_id = ${TEST_ORG}`
    const payload = rows[0]?.payload as { agentId?: string; metadata?: { turnMessageId?: string } }
    expect(payload.agentId).toBe(AGENT)
    expect(payload.metadata?.turnMessageId).toBe("turn-1")
  })

  it("insert through the savepoint: a failed outbox insert the caller catches leaves the run intact", async () => {
    const p = `outbox-${randomUUID()}:`
    await withPrivilegedDb(TEST_ORG, "test", async (tx) => {
      const bridge = bridgeFor(tx)
      await bridge.db_insert("claims", JSON.stringify({ key: `${p}a` }))
      const failed = await tx
        .transaction(async (sp) => {
          // No such org: the outbox row's org foreign key refuses it.
          await (sp as unknown as { queueEvent(e: unknown): Promise<void> }).queueEvent({
            app: APP,
            entity: "claim",
            action: "noted",
            entityId: randomUUID(),
            data: {},
            actorId: null,
            actorType: "system",
            orgId: MISSING_ORG,
            timestamp: new Date().toISOString(),
          })
        })
        .then(
          () => false,
          () => true,
        )
      expect(failed).toBe(true)
      await bridge.db_insert("claims", JSON.stringify({ key: `${p}b` }))
    })
    expect(await keys(p)).toEqual([`${p}a`, `${p}b`])
  })
})
