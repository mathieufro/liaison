// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A database error the app's own handler catches is an ordinary caught error:
// the webhook answers the handler's status, keeps the replay claim and
// schedules no kernel retry. The classic shape is an insert used as a claim
// ("insert; on a unique violation it was already claimed"), raced by two
// deliveries. Both the trusted (in-process) and the untrusted (worker) sandbox
// paths run the same handler.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { app } from "~/app"
import { sql } from "~/db/connection"
import * as jobsModule from "~/infra/jobs/jobs"
import { redis } from "~/lib/redis"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { seedOrgRow } from "~/seed/factories/org/rows"

const TEST_ORG = "00000000-0000-0000-0000-000000000317"
const REPLAY_PREFIX = "webhook:replay:"

const BUNDLE = `
globalThis.verifyHit = async function (req) {
  var body = JSON.parse(req.body);
  return { valid: true, replayKey: body.delivery };
};
async function claim(ctx, key) {
  try {
    await ctx.db.insert("claims", { key: key });
    return true;
  } catch (e) {
    return false;
  }
}
globalThis.handleHit = async function (payload, ctx) {
  var first = await claim(ctx, payload.key);
  var second = await claim(ctx, payload.key);
  // Statements after the caught error still run on the same transaction.
  var rows = await ctx.db.findMany("claims", { where: { key: payload.key } });
  await ctx.db.insert("claims", { key: payload.key + ":after" });
  return { status: 200, body: JSON.stringify({ first: first, second: second, rows: rows.length }) };
};
`

let dir: string
let bundlePath: string
const keysToClean: string[] = []

function appName(trusted: boolean): string {
  return trusted ? "caught-dberr" : "caught-dberr-untrusted"
}

async function register(trusted: boolean): Promise<void> {
  await registerApps(
    [
      {
        name: appName(trusted),
        version: "1.0.0",
        _format: "manifest",
        _bundlePath: bundlePath,
        trusted,
        scopes: [`${appName(trusted)}:claims:read`],
        schema: {
          claims: { fields: { key: "string" }, constraints: { unique: [["key"]] } },
        },
        webhooks: { hit: { verify: "verifyHit", handler: "handleHit" } },
        webhookHealth: { probe: null, reason: "test fixture" },
      } as never,
    ],
    TEST_ORG,
  )
}

beforeAll(async () => {
  await initSandboxPool()
  dir = mkdtempSync(join(tmpdir(), "caught-dberr-"))
  bundlePath = join(dir, "handlers.js")
  writeFileSync(bundlePath, BUNDLE)
  await seedOrgRow(
    { id: TEST_ORG, name: "Caught DB Error Org", slug: "caught-db-error-org" },
    { onConflict: "skip" },
  )
})

afterEach(() => resetAppRegistries())

afterAll(async () => {
  for (const key of keysToClean) await redis.del(key)
  await shutdownSandboxPool()
  await shutdownWorkerPool()
  for (const trusted of [true, false]) {
    const schema = `app_${appName(trusted).replace(/-/g, "_")}`
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await sql`DELETE FROM kernel.apps WHERE org_id = ${TEST_ORG} AND name = ${appName(trusted)}`
  }
  await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
  rmSync(dir, { recursive: true, force: true })
})

describe("a database error the handler catches", () => {
  for (const trusted of [true, false]) {
    it(`answers the handler's 200, keeps the claim and schedules no retry (${trusted ? "trusted" : "untrusted"})`, async () => {
      await register(trusted)
      const name = appName(trusted)
      const delivery = randomUUID()
      const replayKey = `${REPLAY_PREFIX}${TEST_ORG}:${name}:hit:${createHash("sha256").update(delivery).digest("hex")}`
      keysToClean.push(replayKey)
      const enqueue = spyOn(jobsModule, "enqueueAppJob").mockResolvedValue("stub")
      try {
        const key = `k-${randomUUID()}`
        const res = await app.request(`/webhooks/${TEST_ORG}/${name}/hit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ delivery, key }),
        })
        expect(res.status).toBe(200)
        const body = (await res.json()) as Record<string, unknown>
        expect(JSON.stringify(body)).toContain('"second":false')
        expect(JSON.stringify(body)).toContain('"rows":1')
        expect(
          enqueue.mock.calls.filter((c) => c[0] === "kernel" && c[1] === "retry-webhook"),
        ).toHaveLength(0)
        expect(await redis.exists(replayKey)).toBe(1)
        const schema = `app_${name.replace(/-/g, "_")}`
        const rows = await sql.unsafe(
          `SELECT key FROM "${schema}".claims WHERE key LIKE $1 ORDER BY key`,
          [`${key}%`],
        )
        expect(rows.map((r) => r.key)).toEqual([key, `${key}:after`])
      } finally {
        enqueue.mockRestore()
      }
    })
  }
})
