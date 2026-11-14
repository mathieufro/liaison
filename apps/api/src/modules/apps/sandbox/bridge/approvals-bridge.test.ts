// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ctx.requestApproval through the sandbox bridge: a handler may name the scope that decides its
// request. It is written on the row as the deciding scope, the notified audience and the decide
// check read it from there, it must belong to the calling app, and without it nothing changes.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import * as eventBusModule from "~/infra/events/event-bus"
import { authorityFacts, decidingScope } from "~/modules/approvals/authority"
import { createHandlerApprovalRequest } from "~/modules/apps/execute-tool"
import { createApprovalsMethods } from "~/modules/apps/sandbox/bridge/approvals"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { seedOrgRow, seedUserRows } from "~/seed/factories/org/rows"
import { insertSql } from "~/seed/factories/org/test-rows"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

const ORG = "00000000-0000-4000-8000-0000000bb601"
const REQUESTER = "00000000-0000-4000-8000-0000000bb602"
const THREAD = "00000000-0000-4000-8000-0000000bb603"
const DECIDER = "00000000-0000-4000-8000-0000000bb604"
const GENERIC_APPROVER = "00000000-0000-4000-8000-0000000bb605"
const TOOL = "widgets:credit_issue"
const DECIDING = "widgets:credit_signoff"

type RequestInput = Parameters<typeof createHandlerApprovalRequest>[0]["input"]

/** The bridge a sandboxed `widgets` handler holds, wired to the real request path. */
function bridge(opts: { origin?: "in-app-agent" | "human-ui" } = {}) {
  const origin = opts.origin ?? "in-app-agent"
  return createApprovalsMethods({
    appName: "widgets",
    orgId: ORG,
    approvalContext: null,
    bridgeOptions: {
      requestApprovalImpl: (input: RequestInput) =>
        createHandlerApprovalRequest({
          orgId: ORG,
          requestedBy: REQUESTER,
          actorScopes: ["widgets:issue"],
          defaultAppName: "widgets",
          threadId: THREAD,
          origin,
          ...(origin === "human-ui"
            ? { personScopes: ["widgets:issue"], personToolRequiredScopes: ["widgets:issue"] }
            : {}),
          input,
        }),
    },
  } as unknown as BridgeContext) as Record<string, (json: string) => Promise<string>>
}

const ask = (extra: Record<string, unknown>, origin?: "in-app-agent" | "human-ui") =>
  bridge({ origin }).requestApproval!(
    JSON.stringify({
      tool_name: TOOL,
      summary: "Issue a credit",
      current_payload: { amount: 1 },
      ...extra,
    }),
  )

async function rowOf(id: string) {
  const [row] = await sql`SELECT tool_name, approve_scope, resource_owner_id, requested_by,
      notify_user_ids FROM kernel.approval_requests WHERE id = ${id}`
  return row as {
    tool_name: string
    approve_scope: string | null
    resource_owner_id: string | null
    requested_by: string
    notify_user_ids: string[] | null
  }
}

const count = async () =>
  (await sql`SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${ORG}`)[0]
    ?.n as number

describe("ctx.requestApproval approve_scope", () => {
  beforeAll(async () => {
    await seedOrgRow(
      { id: ORG, name: "Bridge approve scope", slug: "bridge-approve-scope", settings: {} },
      { onConflict: "skip" },
    )
    await seedUserRows(
      (
        [
          [REQUESTER, "bas-requester"],
          [DECIDER, "bas-decider"],
          [GENERIC_APPROVER, "bas-generic"],
        ] as const
      ).map(([id, mail]) => ({ id, orgId: ORG, email: `${mail}@test.com`, name: mail })),
      { onConflict: "skip" },
    )
    const row = (table: string, values: Record<string, string | boolean>) =>
      sql.unsafe(insertSql(table, values, { onConflictDoNothing: true }))
    await row("kernel.threads", {
      id: THREAD,
      org_id: ORG,
      handle: "bas-thread",
      type: "agent_chat",
      created_by: REQUESTER,
      tainted: false,
    })
    await row("kernel.thread_participants", { thread_id: THREAD, user_id: REQUESTER, org_id: ORG })
    await row("kernel.user_scope_grants", { user_id: DECIDER, org_id: ORG, scope: DECIDING })
    await row("kernel.user_scope_grants", {
      user_id: GENERIC_APPROVER,
      org_id: ORG,
      scope: "widgets:approve",
    })
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    broadcastSpy.mockRestore()
  })

  it("writes it as the deciding scope and decide uses it", async () => {
    const { approval_id } = JSON.parse(await ask({ approve_scope: DECIDING })) as {
      approval_id: string
    }
    const row = await rowOf(approval_id)
    expect(row.approve_scope).toBe(DECIDING)
    // The scope decide checks is the one the row carries, not `widgets:approve`.
    expect(decidingScope(authorityFacts(row))).toBe(DECIDING)
    // Only holders of the named scope are asked.
    expect(row.notify_user_ids).toContain(DECIDER)
    expect(row.notify_user_ids).not.toContain(GENERIC_APPROVER)
  })

  it("another app's scope refuses approve_scope_not_own", async () => {
    const before = await count()
    for (const scope of [
      "invoicing:approve",
      "kernel:approvals:admin",
      "widgetsx:approve",
      "*",
      "widgets:*",
    ]) {
      let caught: any = null
      try {
        await ask({ approve_scope: scope })
      } catch (err) {
        caught = err
      }
      expect(caught?.code).toBe("approve_scope_not_own")
      expect(String(caught?.message)).toMatch(/No approval was created/)
    }
    expect(await count()).toBe(before)
  })

  it("without the field today's behaviour", async () => {
    const { approval_id } = JSON.parse(await ask({})) as { approval_id: string }
    const row = await rowOf(approval_id)
    expect(row.approve_scope).toBe("widgets:approve")
    expect(row.notify_user_ids).toContain(GENERIC_APPROVER)
    expect(row.notify_user_ids).not.toContain(DECIDER)
  })

  it("a person's own call is still decided by the tool's own scope, not by approve_scope", async () => {
    const before = await count()
    const result = JSON.parse(await ask({ approve_scope: DECIDING }, "human-ui")) as {
      approval_id: string | null
      auto_approved?: boolean
      approved_by?: string
    }
    // Granted on the person's own authority; the named scope parks nothing and gates nobody.
    expect(result).toEqual({ approval_id: null, auto_approved: true, approved_by: "requester" })
    expect(await count()).toBe(before)
  })
})
