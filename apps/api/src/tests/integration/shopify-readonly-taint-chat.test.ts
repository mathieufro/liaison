// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Sibling of manifest-readonly-taint-chat.test.ts for the Shopify bundled app. Shopify's reads
// used to insert an install_metadata row on the read path, so none of them could carry
// readOnly and scope taint refused every one of them once a chat turn had read scoped data.
// The read path is now write-free and the reads are marked; this pins that on a tainted turn a
// Shopify read runs and a Shopify write is still refused.
//
// Shopify is registered from its real manifest through the real runtime projection, with the
// first-party voucher init.ts grants an install whose artifact is the image's own catalog
// tarball (first-party-readonly.test.ts pins the voucher itself). Only each handler is swapped
// for a spy, so nothing reaches a shop.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { sql } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import {
  agentInstructionsRegistry,
  initializedOrgRuntimes,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { registerApps, teardownAppRegistrations } from "~/modules/apps/runtime"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

/** The refusal shape, whatever scopes the turn happened to carry (the message names them). */
/** Rule 8 (scope-taint.ts): a write the taint would refuse parks for approval, unrun. */
function parked(r: unknown): boolean {
  const o = (r ?? {}) as { blocked?: unknown; status?: unknown }
  return (
    !JSON.stringify(r).includes("E_SCOPE_TAINT_BLOCKED") &&
    o.blocked === true &&
    o.status === "pending_approval"
  )
}

const ORG = "00000000-0000-0000-0000-0000000fb201"
const USER = "00000000-0000-0000-0000-0000000fb202"
const SHOPIFY_DIR = join(import.meta.dir, "..", "..", "..", "..", "..", "bundled-apps", "shopify")

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

const ran: string[] = []

function shopifyDescriptor(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(SHOPIFY_DIR, "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  return {
    ...manifest,
    trusted: false,
    _firstParty: true,
    _format: "manifest",
    _bundlePath: join(SHOPIFY_DIR, String(manifest.version), "bundle.js"),
  }
}

/** Keep the real registration's scope and taint metadata, swap only the handler. */
function spyOn(app: string, name: string) {
  const real = toolRegistry.get([ORG, app, name])
  if (!real) throw new Error(`${app}:${name} is not registered`)
  toolRegistry.set([ORG, app, name], {
    ...real,
    params: z.object({}).passthrough(),
    handler: async () => {
      ran.push(`${app}:${name}`)
      return { ok: true }
    },
  })
}

function chatTurnFrame(): RunContext {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator: createTurnScopeAccumulator(),
  } as RunContext
}

function call(frame: RunContext, sdkName: string): Promise<unknown> {
  const tools = buildToolSet(ORG, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
  const t = tools[sdkName]
  if (!t) throw new Error(`${sdkName} is not in the catalog`)
  return (t as unknown as { execute: (a: unknown) => Promise<unknown> }).execute({})
}

describe("chat turn: Shopify reads survive scope taint, Shopify writes do not", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'ShopifyTaintOrg', 'shopify-taint-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER}, ${ORG}, 'shopify-taint@test.com', 'Shopify Taint', 'x')
      ON CONFLICT DO NOTHING`
    await ensureAppsForOrg(ORG)
    await registerApps([shopifyDescriptor()] as never, ORG)
    spyOn("tickets", "search")
    spyOn("shopify", "orders_search")
    spyOn("shopify", "home_load")
    spyOn("shopify", "webhooks_repair")
  })

  afterAll(async () => {
    await teardownAppRegistrations(ORG, "shopify")
    toolRegistry.deleteByPrefix([ORG])
    skillRegistry.deleteByPrefix([ORG])
    agentInstructionsRegistry.deleteByPrefix([ORG])
    initializedOrgRuntimes.delete(ORG)
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("a Shopify read runs after an earlier read tainted the turn", async () => {
    ran.length = 0
    const frame = chatTurnFrame()
    await call(frame, "tickets__search")
    expect(frame.turnScopeAccumulator?.snapshot()).toContain("tickets:tickets:read")
    const orders = await call(frame, "shopify__orders_search")
    const home = await call(frame, "shopify__home_load")
    for (const r of [orders, home]) {
      expect((r as { code?: string }).code).not.toBe("E_SCOPE_TAINT_BLOCKED")
    }
    expect(ran).toEqual(["tickets:search", "shopify:orders_search", "shopify:home_load"])
  })

  it("a Shopify write never runs inline after a read tainted the turn: it parks for approval", async () => {
    ran.length = 0
    const frame = chatTurnFrame()
    await call(frame, "tickets__search")
    const repair = await call(frame, "shopify__webhooks_repair")
    expect(parked(repair)).toBe(true)
    expect(ran).toEqual(["tickets:search"])
  })
})
