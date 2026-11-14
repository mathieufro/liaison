// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One pending refund per charge, and a person's pending refund is never
// rewritten by someone else's. The refund tool is registered with the gate,
// the dedupe key and the same-requester rule the shipped manifest declares, and
// staged through the real executeTool gate by two people of one org.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { estimateToolSchemaTokens } from "~/modules/agent/context/context"
import {
  approvalDedupeKeyRegistry,
  approvalDedupeSameRequesterRegistry,
  approvalExpiryRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { insertSql } from "~/seed/factories/org/test-rows"

const { executeTool } = await import("~/modules/apps/execute-tool")

const MANIFEST = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "..",
      "bundled-apps",
      "stripe",
      "app.manifest.json",
    ),
    "utf8",
  ),
)
const SHIPPED = MANIFEST.tools.refunds_create as {
  gated: boolean
  noAutoApprove: boolean
  requiredScopes: string[]
  approvalDedupeKeyParam: string
  approvalDedupeSameRequester: boolean
  approvalExpiryHours: number
}

let orgId: string
let alice: string
let bruno: string
let runs = 0

beforeAll(async () => {
  const slug = `stripe-refund-dedupe-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("stripe-refund-dedupe-fixture", async (tx) => {
    orgId = randomUUID()
    await tx.execute(
      drizzleSql.raw(insertSql("kernel.organizations", { id: orgId, name: "Refund Dedupe", slug })),
    )
    const user = async (name: string) => {
      const id = randomUUID()
      await tx.execute(
        drizzleSql.raw(
          insertSql("kernel.users", {
            id,
            org_id: orgId,
            email: `${name}-${slug}@x.test`,
            name,
            status: "active",
            password_hash: "h",
            auth_version: 1,
            permission_version: 1,
          }),
        ),
      )
      return id
    }
    alice = await user("alice")
    bruno = await user("bruno")
  })
  toolRegistry.set([orgId, "stripe", "refunds_create"], {
    appName: "stripe",
    name: "refunds_create",
    description: "refunds_create",
    requiredScopes: SHIPPED.requiredScopes,
    gated: SHIPPED.gated,
    noAutoApprove: SHIPPED.noAutoApprove,
    approvalImpact: "external",
    params: z.object({ chargeId: z.string(), amountMinor: z.string().optional() }).passthrough(),
    handler: async () => {
      runs++
      return { refundId: "re_never" }
    },
  } as never)
  approvalDedupeKeyRegistry.set([orgId, "stripe", "refunds_create"], SHIPPED.approvalDedupeKeyParam)
  if (SHIPPED.approvalDedupeSameRequester)
    approvalDedupeSameRequesterRegistry.set([orgId, "stripe", "refunds_create"], true)
  approvalExpiryRegistry.set([orgId, "stripe", "refunds_create"], SHIPPED.approvalExpiryHours)
})

afterAll(() => {
  toolRegistry.delete([orgId, "stripe", "refunds_create"])
})

function stage(userId: string, chargeId: string, amountMinor: string) {
  return executeTool({
    toolName: "stripe:refunds_create",
    orgId,
    actor: {
      actorType: "user",
      userId,
      orgId,
      scopes: ["stripe:refunds:write"],
      dimensionGrants: {},
    } as never,
    params: { chargeId, amountMinor },
    origin: "in-app-agent",
  })
}

async function pending(chargeId: string) {
  return withPrivilegedDb(orgId, "stripe-refund-dedupe-read", async (tx) =>
    extractRows<{ id: string; requested_by: string; amount: string }>(
      await tx.execute(drizzleSql`
        SELECT id, requested_by, current_payload->>'amountMinor' AS amount
        FROM kernel.approval_requests
        WHERE org_id = ${orgId} AND tool_name = 'stripe:refunds_create' AND status = 'pending'
          AND tool_params->>'chargeId' = ${chargeId}`),
    ),
  )
}

describe("a pending refund per charge", () => {
  it("a second requester's refund on the same charge leaves the first card unchanged and is told which one waits", async () => {
    const first = await stage(alice, "ch_shared", "1200")
    expect(first.blocked?.reason).toBe("gated")
    const firstId = first.blocked!.approvalRequestId!

    const second = await stage(bruno, "ch_shared", "9900").then(
      (r) => ({ ok: r }),
      (err: { code?: string; message?: string }) => ({ err }),
    )
    const refusal =
      "err" in second
        ? second.err
        : (second.ok as { error?: { code?: string; message?: string } }).error
    expect(refusal?.code).toBe("approval_already_pending")
    expect(refusal?.message).toContain(firstId)

    const rows = await pending("ch_shared")
    expect(rows.map((r) => [r.id, r.requested_by, r.amount])).toEqual([[firstId, alice, "1200"]])
    expect(runs).toBe(0)
  })

  it("the same person asking again on that charge edits their own waiting card, and another charge gets its own", async () => {
    const first = await stage(alice, "ch_mine", "500")
    const again = await stage(alice, "ch_mine", "700")
    expect(again.blocked!.approvalRequestId).toBe(first.blocked!.approvalRequestId!)
    expect((await pending("ch_mine")).map((r) => r.amount)).toEqual(["700"])
    const other = await stage(bruno, "ch_other", "300")
    expect(other.blocked!.approvalRequestId).not.toBe(first.blocked!.approvalRequestId!)
    expect(runs).toBe(0)
  })
})

describe("the money tools the agent reads", () => {
  it("refund, cancel and card link load on demand and their three schemas stay within 700 tokens", () => {
    let total = 0
    const each: Record<string, number> = {}
    for (const name of ["refunds_create", "subscription_cancel", "card_update_link"]) {
      const t = MANIFEST.tools[name] as {
        description: string
        params: unknown
        deferLoading?: boolean
      }
      expect({ name, deferred: t.deferLoading }).toEqual({ name, deferred: true })
      expect(t.description.length).toBeLessThanOrEqual(280)
      each[name] = estimateToolSchemaTokens(`stripe__${name}`, {
        description: t.description,
        inputSchema: t.params,
      })
      total += each[name]
    }
    console.info("money tool schema tokens", JSON.stringify({ ...each, total }))
    expect(total).toBeLessThanOrEqual(700)
  })
})
