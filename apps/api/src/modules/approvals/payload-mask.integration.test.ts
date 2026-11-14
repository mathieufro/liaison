// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An approval's payload holds no card number and no payment key: text an agent
// writes into a staged reply is masked when the request is created, when the
// agent updates its payload, when a person edits it, and when a second staging
// call restages it in place. The stored params, payload and card summary all
// hold bullets; identifier fields keep their value.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { ActorContext, UserContext } from "~/db/rls"
import { SINK_KERNEL_MESSAGES } from "~/modules/agent/scopes/scope-taint"
import { updatePayload } from "~/modules/approvals/edit"
import {
  approvalDedupeKeyRegistry,
  approvalEditableFieldsRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000005a0001"
const USER = "00000000-0000-4000-8000-0000005a0002"
const THREAD = "00000000-0000-4000-8000-0000005a0003"
const APP = "paymask_test"
const WRITE = `${APP}:write`

// Full-length key shapes and a Luhn-valid Visa number, written two ways.
const SECRET = `sk_live_${"51HxQzA9bC3dE4fG5hI6jK7lM8nO9pQ"}`
const RESTRICTED = `rk_test_${"51HxQzA9bC3dE4fG5hI6jKmN"}`
const SIGNING = `whsec_${"Kx8pYQ2mZ7cV3nB6vR1tW9aS4dF0gH5j"}`
const PAN = "4917484589897107"
const PAN_SPACED = "4917 4845 8989 7107"

const actor: ActorContext & UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: [WRITE, `${APP}:approve`],
  dimensionGrants: {},
}

function leaks(value: unknown): string[] {
  const text = JSON.stringify(value)
  const found: string[] = []
  for (const s of [SECRET, RESTRICTED, SIGNING, PAN, PAN_SPACED])
    if (text.includes(s)) found.push(s)
  if (text.replace(/\D/g, "").includes(PAN)) found.push("digits")
  return found
}

async function stage(body: string): Promise<string> {
  const r = await executeTool({
    toolName: `${APP}:reply`,
    orgId: ORG,
    actor,
    params: { draft_id: "draft-1", order_id: "5512345678907", body },
    threadId: THREAD,
    origin: "in-app-agent",
  })
  if (!r.blocked?.approvalRequestId) throw new Error(`expected a gate, got ${JSON.stringify(r)}`)
  return r.blocked.approvalRequestId
}

async function row(id: string) {
  const [r] = await sql<
    {
      tool_params: Record<string, unknown>
      current_payload: Record<string, unknown>
      summary: unknown
    }[]
  >`SELECT tool_params, current_payload, summary FROM kernel.approval_requests WHERE id = ${id}`
  if (!r) throw new Error("no approval row")
  return r
}

beforeAll(async () => {
  await acquireTestLock()
  const once = { onConflictDoNothing: true }
  await sql.unsafe(
    insertSql(
      "kernel.organizations",
      { id: ORG, name: "Payload Mask Org", slug: "payload-mask-org" },
      once,
    ),
  )
  await sql.unsafe(
    insertSql(
      "kernel.users",
      {
        id: USER,
        org_id: ORG,
        email: "payload-mask@test.com",
        name: "Requester",
        status: "active",
        password_hash: "hash",
      },
      once,
    ),
  )
  await sql.unsafe(
    insertSql(
      "kernel.threads",
      {
        id: THREAD,
        org_id: ORG,
        handle: "payload-mask-thread",
        type: "agent_chat",
        created_by: USER,
      },
      once,
    ),
  )
  await sql.unsafe(
    insertSql(
      "kernel.thread_participants",
      { thread_id: THREAD, user_id: USER, org_id: ORG, role: "admin" },
      once,
    ),
  )
  await sql.unsafe(
    insertSql("kernel.user_thread_state", { user_id: USER, thread_id: THREAD, org_id: ORG }, once),
  )
  toolRegistry.set([ORG, APP, "reply"], {
    appName: APP,
    name: "reply",
    description: "A gated reply to a customer",
    requiredScopes: [WRITE],
    gated: true,
    approvalImpact: "external",
    writesToTable: SINK_KERNEL_MESSAGES,
    handler: async () => ({ ok: true }),
  } as never)
  approvalDedupeKeyRegistry.set([ORG, APP, "reply"], "draft_id")
  approvalEditableFieldsRegistry.set(
    [ORG, APP, "reply"],
    [{ field: "body", label: "Reply", widget: "text" }],
  )
})

afterEach(async () => {
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
})

afterAll(async () => {
  toolRegistry.deleteByPrefix([ORG])
  approvalDedupeKeyRegistry.deleteByPrefix([ORG])
  approvalEditableFieldsRegistry.deleteByPrefix([ORG])
  await releaseTestLock()
})

describe("approval payloads: card numbers and payment keys masked before storage", () => {
  it("a staged reply holding a card number and keys is stored masked, and an id field keeps its value", async () => {
    const id = await stage(`Your card ${PAN_SPACED} is on file. Key ${SECRET}, hook ${SIGNING}.`)
    const r = await row(id)
    expect(leaks(r)).toEqual([])
    expect(String(r.current_payload.body)).toContain("7107")
    expect(String(r.current_payload.body)).toContain("sk_live_")
    expect(r.current_payload.order_id).toBe("5512345678907")
    expect(r.tool_params.body).toBe(r.current_payload.body)
  })

  it("the agent's payload update is masked", async () => {
    const id = await stage("Thanks, we will look into it.")
    const out = await updatePayload({
      orgId: ORG,
      requestId: id,
      fields: { body: `Charged ${PAN} with ${RESTRICTED}` },
      actor,
    })
    expect(leaks(out.currentPayload)).toEqual([])
    expect(leaks(await row(id))).toEqual([])
  })

  it("a person's edit is masked the same way", async () => {
    const id = await stage("Thanks, we will look into it.")
    await updatePayload({
      orgId: ORG,
      requestId: id,
      fields: { body: `Card ${PAN_SPACED}, key ${SECRET}` },
      actor,
      actingAgentId: null,
    })
    const r = await row(id)
    expect(leaks(r)).toEqual([])
    expect(String(r.current_payload.body)).toContain("7107")
  })

  it("a second staging call restaging the request in place is masked", async () => {
    const first = await stage("Thanks, we will look into it.")
    const second = await stage(`Use card ${PAN} and key ${SIGNING}`)
    expect(second).toBe(first)
    expect(leaks(await row(first))).toEqual([])
  })
})
