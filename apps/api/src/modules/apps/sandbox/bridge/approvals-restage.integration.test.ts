// SPDX-License-Identifier: FSL-1.1-ALv2
//
// approvals_restagePayload: an app rewrites the payload of one of its OWN approvals still awaiting
// a decision, after the records the payload describes changed. It keeps every guard of an edit
// (row lock, schema, sign-off reset, thread note); it skips only the person check and the
// editable-field allowlist. Another app's approval, and a decided one, stay as they are.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { ApprovalDecisionError, decideApproval } from "~/modules/approvals/decide"
import { approvalPayloadHash } from "~/modules/approvals/payload-hash"
import { approvalSummarizerRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { createApprovalsMethods } from "~/modules/apps/sandbox/bridge/approvals"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { insertSql } from "~/seed/factories/org/test-rows"

const ORG = randomUUID()
const REQUESTER = randomUUID()
const APPROVER = randomUUID()
const THREAD = randomUUID()
const APP = "restage_app"
const TOOL = `${APP}:run_issue`

let ran = 0

function methods(appName: string, taint: string[] | null = []) {
  return createApprovalsMethods({
    appName,
    orgId: ORG,
    userId: "system",
    callerScopes: [],
    approvalContext: null,
    bridgeOptions: {},
    bridgeActingAgentId: null,
    bridgeSpawnParentFrame: null,
    bridgeTurnTaintScopes: taint,
  } as unknown as BridgeContext) as Record<string, (...args: string[]) => Promise<string>>
}

async function restage(
  appName: string,
  id: string,
  fields: Record<string, unknown>,
  note?: string,
): Promise<{ ok: boolean; code?: string; message?: string; payload_hash?: string }> {
  return JSON.parse(
    await methods(appName).approvals_restagePayload!(
      id,
      JSON.stringify(fields),
      ...(note ? [note] : []),
    ),
  )
}

async function stageRow(
  opts: { status?: string; approvedBy?: string[]; total?: number } = {},
): Promise<string> {
  const id = randomUUID()
  const payload = JSON.stringify({
    run_id: "run-1",
    items: [{ item: "a", total: opts.total ?? 100 }],
  })
  const metadata = JSON.stringify(
    opts.approvedBy ? { minApprovers: 2, approvedBy: opts.approvedBy } : {},
  )
  await sql.unsafe(
    insertSql("kernel.approval_requests", {
      id,
      org_id: ORG,
      handle: `rs-${id.slice(0, 8)}`,
      thread_id: THREAD,
      originating_thread_id: THREAD,
      tool_name: TOOL,
      tool_params: { raw: `'${payload}'::jsonb` },
      current_payload: { raw: `'${payload}'::jsonb` },
      expires_at: { raw: "now() + interval '1 day'" },
      notify_user_ids: { raw: `ARRAY['${APPROVER}']::uuid[]` },
      requested_by: REQUESTER,
      status: opts.status ?? "pending",
      reason: "gated",
      summary: { raw: `'{"kind":"run_issue","title":"Month-end run","lines":[]}'::jsonb` },
      metadata: { raw: `'${metadata}'::jsonb` },
    }),
  )
  return id
}

async function readRow(id: string) {
  const [row] = await sql`
    SELECT status, current_payload, metadata FROM kernel.approval_requests WHERE id = ${id}`
  return row as { status: string; current_payload: unknown; metadata: Record<string, unknown> }
}

async function notesOn(id: string): Promise<number> {
  const [row] = await sql`
    SELECT count(*)::int AS n FROM kernel.messages
    WHERE org_id = ${ORG} AND thread_id = ${THREAD} AND metadata->>'type' = 'payload-edit'
      AND metadata->'diff' @> ${JSON.stringify([{ field: "items" }])}::jsonb
      AND created_at >= (SELECT created_at FROM kernel.approval_requests WHERE id = ${id})`
  return Number(row?.n ?? 0)
}

const approver: UserContext = {
  actorType: "user",
  userId: APPROVER,
  orgId: ORG,
  scopes: [`${APP}:write`, `${APP}:approve`],
  dimensionGrants: {},
}

describe("an app restages its own approval", () => {
  beforeAll(async () => {
    await sql.unsafe(
      insertSql("kernel.organizations", {
        id: ORG,
        name: "Restage org",
        slug: `rs-${ORG.slice(0, 8)}`,
      }),
    )
    await sql.unsafe(
      insertSql(
        "kernel.users",
        [REQUESTER, APPROVER].map((id) => ({
          id,
          org_id: ORG,
          email: `rs-${id.slice(0, 8)}@example.com`,
          name: "Restage user",
          status: "active",
          password_hash: "hash",
        })),
      ),
    )
    await sql.unsafe(
      insertSql(
        "kernel.user_scope_grants",
        [`${APP}:write`, `${APP}:approve`].map((scope) => ({
          user_id: APPROVER,
          org_id: ORG,
          scope,
        })),
      ),
    )
    await sql.unsafe(
      insertSql("kernel.threads", {
        id: THREAD,
        org_id: ORG,
        handle: `rs-${THREAD.slice(0, 8)}`,
        type: "approval",
        created_by: REQUESTER,
      }),
    )
    await sql.unsafe(
      insertSql(
        "kernel.thread_participants",
        [REQUESTER, APPROVER].map((user_id) => ({
          thread_id: THREAD,
          user_id,
          org_id: ORG,
          role: "admin",
        })),
      ),
    )
    toolRegistry.set([ORG, APP, "run_issue"], {
      appName: APP,
      name: "run_issue",
      description: "issue a run",
      requiredScopes: [`${APP}:write`],
      gated: true,
      params: {
        type: "object",
        properties: {
          run_id: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { item: { type: "string" }, total: { type: "integer" } },
              required: ["item", "total"],
            },
          },
        },
        required: ["run_id", "items"],
      },
      handler: async () => {
        ran++
        return { done: true }
      },
    } as Parameters<typeof toolRegistry.set>[1])
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("an app restages its own pending approval and the payload hash changes, sign-offs reset and the thread gets one note", async () => {
    const id = await stageRow({ approvedBy: [APPROVER] })
    const before = await readRow(id)
    const hashBefore = approvalPayloadHash(TOOL, before.current_payload)
    const res = await restage(
      APP,
      id,
      { items: [{ item: "a", total: 250 }] },
      "Row a changed to 2.50",
    )
    expect(res.ok).toBe(true)
    const after = await readRow(id)
    expect(after.status).toBe("pending")
    expect(after.current_payload).toEqual({ run_id: "run-1", items: [{ item: "a", total: 250 }] })
    const hashAfter = approvalPayloadHash(TOOL, after.current_payload)
    expect(hashAfter).not.toBe(hashBefore)
    expect(res.payload_hash).toBe(hashAfter)
    expect(after.metadata.approvedBy).toBeUndefined()
    expect(await notesOn(id)).toBe(1)
    const [note] = await sql`
      SELECT content FROM kernel.messages
      WHERE org_id = ${ORG} AND thread_id = ${THREAD} AND metadata->>'restagedByApp' = ${APP}
      ORDER BY created_at DESC LIMIT 1`
    expect(String(note?.content)).toContain("Row a changed to 2.50")
  })

  it("after an app restages its approval the card is rebuilt from the new payload, never from the app's own text", async () => {
    approvalSummarizerRegistry.set([ORG, APP, "run_issue"], async (params) => {
      const items = (params as { items?: Array<{ total: number }> }).items ?? []
      return {
        kind: "run_issue",
        title: `Issue ${items.length} invoice${items.length === 1 ? "" : "s"}`,
        lines: items.map((i) => `Total ${i.total}`),
      }
    })
    try {
      const id = await stageRow()
      const res = JSON.parse(
        await methods(APP).approvals_restagePayload!(
          id,
          JSON.stringify({ items: [{ item: "a", total: 250 }] }),
          "Row a changed",
          JSON.stringify({
            title: "Refund everything",
            lines: ["Card 4242 4242 4242 4242, refund 50 EUR"],
          }),
        ),
      ) as { ok: boolean }
      expect(res.ok).toBe(true)
      const [row] = await sql`SELECT summary FROM kernel.approval_requests WHERE id = ${id}`
      expect(row?.summary).toEqual({
        kind: "run_issue",
        title: "Issue 1 invoice",
        lines: ["Total 250"],
      })
    } finally {
      approvalSummarizerRegistry.delete([ORG, APP, "run_issue"])
    }
  })

  it("a card rebuilt after a restage masks a card number its summarizer wrote", async () => {
    approvalSummarizerRegistry.set([ORG, APP, "run_issue"], async () => ({
      kind: "run_issue",
      title: "Refund",
      lines: ["Card 4242 4242 4242 4242, refund 50 EUR"],
    }))
    try {
      const id = await stageRow()
      const res = await restage(APP, id, { items: [{ item: "a", total: 9 }] })
      expect(res.ok).toBe(true)
      const [row] = await sql`SELECT summary FROM kernel.approval_requests WHERE id = ${id}`
      const text = JSON.stringify(row?.summary)
      expect(text).toContain("refund 50 EUR")
      expect(text).not.toContain("4242 4242 4242 4242")
      expect(text.replace(/\D/g, "")).not.toContain("4242424242424242")
    } finally {
      approvalSummarizerRegistry.delete([ORG, APP, "run_issue"])
    }
  })

  it("a deferred approval is restaged as a pending one is", async () => {
    const id = await stageRow({ status: "deferred" })
    const res = await restage(APP, id, { items: [{ item: "a", total: 300 }] })
    expect(res.ok).toBe(true)
    expect((await readRow(id)).current_payload).toEqual({
      run_id: "run-1",
      items: [{ item: "a", total: 300 }],
    })
  })

  it("another app restaging this approval is refused and the payload is unchanged", async () => {
    const id = await stageRow({})
    // "restage" is a prefix of "restage_app": only the app's own tools, by `<app>:`, count.
    for (const other of ["restage", "other_app"]) {
      const res = await restage(other, id, { items: [{ item: "a", total: 1 }] })
      expect(res.ok).toBe(false)
      expect(res.code).toBe("forbidden")
    }
    expect((await readRow(id)).current_payload).toEqual({
      run_id: "run-1",
      items: [{ item: "a", total: 100 }],
    })
    expect(await notesOn(id)).toBe(0)
  })

  it("a decided approval answers not_pending", async () => {
    for (const status of ["approved", "denied", "expired"]) {
      const id = await stageRow({ status })
      const res = await restage(APP, id, { items: [{ item: "a", total: 5 }] })
      expect(res.ok).toBe(false)
      expect(res.code).toBe("not_pending")
      expect((await readRow(id)).current_payload).toEqual({
        run_id: "run-1",
        items: [{ item: "a", total: 100 }],
      })
    }
  })

  it("a payload the tool's schema refuses is not stored", async () => {
    // The schema is judged as for any edit of a sandboxed app's tool.
    const tool = toolRegistry.get([ORG, APP, "run_issue"])!
    toolRegistry.set([ORG, APP, "run_issue"], {
      ...tool,
      handler: { bundlePath: "unused", exportName: "unused" },
    } as Parameters<typeof toolRegistry.set>[1])
    try {
      const id = await stageRow({})
      const res = await restage(APP, id, { items: [{ item: "a", total: "lots" }] })
      expect(res.ok).toBe(false)
      expect(res.code).toBe("invalid_edit")
      expect((await readRow(id)).current_payload).toEqual({
        run_id: "run-1",
        items: [{ item: "a", total: 100 }],
      })
    } finally {
      toolRegistry.set([ORG, APP, "run_issue"], tool)
    }
  })

  it("a restage keeps the row lock: a decide racing it refuses with payload_changed", async () => {
    // Two connections and a barrier: the barrier holds the row lock, both writers queue behind it
    // in a known order, then the barrier lets go.
    const waiting = async (n: number) => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const [row] = await sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND cardinality(pg_blocking_pids(pid)) > 0`
        if (Number(row?.n) >= n) return
        await Bun.sleep(10)
      }
      throw new Error(`expected ${n} waiting writers`)
    }
    const race = async (first: "restage" | "decide") => {
      ran = 0
      const id = await stageRow({})
      const shown = approvalPayloadHash(TOOL, (await readRow(id)).current_payload)
      const barrier = await sql.reserve()
      try {
        await barrier`BEGIN`
        await barrier`SELECT id FROM kernel.approval_requests WHERE id = ${id} FOR UPDATE`
        const doRestage = () => restage(APP, id, { items: [{ item: "a", total: 999 }] })
        const doDecide = () =>
          decideApproval({
            orgId: ORG,
            requestId: id,
            actor: approver,
            decision: "approve",
            payloadHash: shown,
          }).then(
            (r) => ({ status: r.status as string, code: null as string | null }),
            (e) => ({
              status: "refused",
              code: e instanceof ApprovalDecisionError ? e.code : String(e),
            }),
          )
        let restaged: Promise<Awaited<ReturnType<typeof doRestage>>>
        let decided: Promise<Awaited<ReturnType<typeof doDecide>>>
        if (first === "restage") {
          restaged = doRestage()
          await waiting(1)
          decided = doDecide()
          await waiting(2)
        } else {
          decided = doDecide()
          await waiting(1)
          restaged = doRestage()
          await waiting(2)
        }
        await barrier`COMMIT`
        return { id, restaged: await restaged, decided: await decided }
      } finally {
        barrier.release()
      }
    }

    // The restage takes the lock first: the decide, judged again under the lock, sees a payload
    // other than the one shown and runs nothing.
    const a = await race("restage")
    expect(a.restaged.ok).toBe(true)
    expect(a.decided).toEqual({ status: "refused", code: "payload_changed" })
    expect(ran).toBe(0)
    expect((await readRow(a.id)).status).toBe("pending")

    // The decide takes the lock first: it runs what was shown, and the restage behind it finds the
    // approval decided and changes nothing.
    const b = await race("decide")
    expect(b.decided.status).toBe("approved")
    expect(ran).toBe(1)
    expect(b.restaged.ok).toBe(false)
    expect(b.restaged.code).toBe("not_pending")
    expect((await readRow(b.id)).current_payload).toEqual({
      run_id: "run-1",
      items: [{ item: "a", total: 100 }],
    })
  })
})
