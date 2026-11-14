// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A handler that knows its own deadline (a run that must issue by a legal date) sets
// `expiry_hours` on `ctx.requestApproval`. It wins over the tool's `approvalExpiryHours`, and a
// value outside 1 to 720 whole hours is refused before anything is written.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import { approvalExpiryRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { createHandlerApprovalRequest } from "~/modules/apps/execute-tool"
import { insertSql } from "~/seed/factories/org/test-rows"

const ORG = randomUUID()
const REQUESTER = randomUUID()
const APPROVER = randomUUID()
const APP = "expiry_app"

function request(expiry: unknown) {
  return createHandlerApprovalRequest({
    orgId: ORG,
    requestedBy: REQUESTER,
    actorScopes: [`${APP}:write`],
    defaultAppName: APP,
    origin: "in-app-agent",
    input: {
      tool_name: `${APP}:run_issue`,
      summary: "Month-end run",
      current_payload: { run_id: "run-1" },
      ...(expiry === undefined ? {} : { expiry_hours: expiry as number }),
    },
  })
}

async function hoursToExpiry(id: string): Promise<number> {
  const [row] = await sql`
    SELECT EXTRACT(EPOCH FROM (expires_at - created_at)) / 3600 AS hours
    FROM kernel.approval_requests WHERE id = ${id}`
  return Math.round(Number(row?.hours))
}

async function rowCount(): Promise<number> {
  const [row] =
    await sql`SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${ORG}`
  return Number(row?.n ?? 0)
}

describe("a handler's approval deadline", () => {
  beforeAll(async () => {
    await sql.unsafe(
      insertSql("kernel.organizations", {
        id: ORG,
        name: "Expiry org",
        slug: `ex-${ORG.slice(0, 8)}`,
      }),
    )
    await sql.unsafe(
      insertSql(
        "kernel.users",
        [REQUESTER, APPROVER].map((id) => ({
          id,
          org_id: ORG,
          email: `ex-${id.slice(0, 8)}@example.com`,
          name: "Expiry user",
          status: "active",
          password_hash: "hash",
        })),
      ),
    )
    await sql.unsafe(
      insertSql("kernel.user_scope_grants", {
        user_id: APPROVER,
        org_id: ORG,
        scope: `${APP}:approve`,
      }),
    )
    toolRegistry.set([ORG, APP, "run_issue"], {
      appName: APP,
      name: "run_issue",
      description: "issue a run",
      requiredScopes: [`${APP}:write`],
      gated: true,
      handler: { bundlePath: "unused", exportName: "unused" },
    } as Parameters<typeof toolRegistry.set>[1])
    // The tool's own expiry, which a handler's deadline overrides.
    approvalExpiryRegistry.set([ORG, APP, "run_issue"], 24)
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    approvalExpiryRegistry.deleteByPrefix([ORG])
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("a handler's approval with expiry_hours 72 expires at 72 hours", async () => {
    const res = await request(72)
    expect(res.approval_id).toBeString()
    expect(await hoursToExpiry(res.approval_id as string)).toBe(72)
    // Without it, the tool's own expiry applies.
    const plain = await request(undefined)
    expect(await hoursToExpiry(plain.approval_id as string)).toBe(24)
    // The bounds themselves are accepted.
    expect(await hoursToExpiry((await request(720)).approval_id as string)).toBe(720)
    expect(await hoursToExpiry((await request(1)).approval_id as string)).toBe(1)
  })

  it("expiry_hours above 720 is refused", async () => {
    const before = await rowCount()
    for (const bad of [721, 0, 1.5, "72"]) {
      let err: unknown
      try {
        await request(bad)
      } catch (e) {
        err = e
      }
      expect((err as { code?: string } | undefined)?.code).toBe("expiry_hours_invalid")
      expect((err as Error).message).toContain("No approval was created")
    }
    expect(await rowCount()).toBe(before)
  })
})
